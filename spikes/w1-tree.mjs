// W1 / R13 / R7: AionCore-side process-tree termination.
// usage: node w1-tree.mjs <agent:claude|codex> <action:cancel|restart|kill-aioncore> <permission>
// Flow: own aioncore -> conversation in fresh worktree -> agent asked to run fixtures/tree.mjs (long-running)
// -> operator approves the command manually (decision file) -> wait for 4 tree pids -> snapshot agent processes
// -> action -> after 6s check every recorded pid.
import { startAioncore, client, log, sleep, ROOT, mask, writeJson } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Kill a fixture pid only if its current command line is still our tree fixture (PID-reuse safe).
function killFixture(pid) {
  try {
    const cmd = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
    if (cmd.includes('tree.mjs')) execFileSync('taskkill', ['/F', '/PID', String(pid)]);
  } catch {}
}

const [agent, action, permission = 'default'] = process.argv.slice(2);
const ASSISTANT = { claude: 'bare:2d23ff1c', codex: 'bare:8e1acf31' }[agent];
const tag = `w1-${agent}-${action}`;
const L = (o) => log(`${tag}.log`, o);
const REPO = join(ROOT, 'p0-sandbox', 'repo 測試 A');
const WT = join(ROOT, 'p0-sandbox', 'wt', tag);
if (!existsSync(WT)) execFileSync('git', ['-C', REPO, 'worktree', 'add', '-q', '-b', `p0/${tag}`, WT, 'HEAD']);
const pidFile = join(ROOT, 'runtime', `${tag}.treepids`); if (existsSync(pidFile)) rmSync(pidFile);
const tree = join(ROOT, 'fixtures', 'tree.mjs');

const table = () => JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Created";e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }));
// PID-reuse guard: a process counts as a descendant only if it was created at/after its parent.
const desc = (t, root) => { const by = new Map(t.map((p) => [p.ProcessId, p])); const s = new Set([root]); let g = true;
  while (g) { g = false; for (const p of t) { const par = by.get(p.ParentProcessId);
    if (s.has(p.ParentProcessId) && !s.has(p.ProcessId) && par && p.Created >= par.Created) { s.add(p.ProcessId); g = true; } } }
  return t.filter((p) => s.has(p.ProcessId) && p.ProcessId !== root); };

// Tree discovery independent of the pid file: fixture processes carry the unique pidFile path in argv.
function treeFromCim() {
  return table().filter((p) => p.Name === 'node.exe' && String(p.CommandLine ?? '').includes('tree.mjs') && String(p.CommandLine ?? '').includes(pidFile))
    .map((p) => ({ role: (String(p.CommandLine).match(/tree\.mjs"?\s+(\w+)/) || [])[1] ?? '?', pid: p.ProcessId, ppid: p.ParentProcessId, via: 'cim' }));
}

const a = await startAioncore({ dataDir: join(ROOT, 'runtime', 'data', tag), workDir: join(ROOT, 'runtime', 'work', tag), mode: 'local', logFile: `${tag}.stdout.log` });
const c = client(a.base, { evid: `${tag}.api.log` });
L({ step: 'aioncore', pid: a.proc.pid, base: a.base });
await sleep(3000); // assistant catalog warm-up (observed startup race in R3)
const cr = await c.post('/api/conversations', { name: tag, assistant: { id: ASSISTANT, conversation_overrides: { permission } }, extra: { workspace: WT } });
const conv = cr.json?.data?.id; L({ step: 'create', status: cr.status, conv });
const prompt = `Run exactly this one shell command in the foreground and wait for it (it runs until stopped; do not stop it yourself, do not run anything else):\nnode "${tree}" root "${pidFile}"`;
const send = await c.post(`/api/conversations/${conv}/messages`, { content: prompt });
const turnId = send.json?.data?.turn_id; L({ step: 'send', status: send.status, turnId });

const PEND = join(ROOT, 'runtime', 'approvals', 'pending'), DEC = join(ROOT, 'runtime', 'approvals', 'decide');
mkdirSync(PEND, { recursive: true }); mkdirSync(DEC, { recursive: true });
const done = new Set(); const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  const lines = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  if (new Set(lines.map((l) => JSON.parse(l).role)).size >= 4) break;
  // root, sleeper and leaf stay alive; mid exits by design. Found via argv when the pid file write is denied.
  if (new Set(treeFromCim().map((p) => p.role)).size >= 3) { await sleep(1000); break; }
  const r = await c.get(`/api/conversations/${conv}/confirmations`);
  for (const cf of r.json?.data ?? []) {
    const key = `${tag}__${conv}__${cf.call_id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!existsSync(join(PEND, key + '.json'))) { writeFileSync(join(PEND, key + '.json'), JSON.stringify({ base: a.base, convId: conv, ...cf }, null, 2)); L({ step: 'approval_pending', key, title: cf.title }); }
    const df = join(DEC, key + '.json');
    if (existsSync(df) && !done.has(key)) {
      const d = JSON.parse(readFileSync(df, 'utf8')); const opt = cf.options[d.option];
      const res = await c.post(`/api/conversations/${conv}/confirmations/${encodeURIComponent(cf.call_id)}/confirm`, { msg_id: cf.id, data: opt.value, always_allow: false });
      done.add(key); L({ step: 'approval_decided', key, option: opt.value, status: res.status });
    }
  }
  await sleep(500);
}
const fromFile = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const treePids = fromFile.length >= 4 ? fromFile : treeFromCim();
const before = desc(table(), a.proc.pid).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: mask(String(p.CommandLine ?? '')).slice(0, 200) }));
L({ step: 'tree_ready', treePids, aioncoreDescendants: before.length });
writeJson(`${tag}.before.json`, before);

const tA = Date.now();
if (action === 'cancel') { const r = await c.post(`/api/conversations/${conv}/cancel`, { turn_id: turnId }); L({ step: 'cancel', status: r.status, body: r.text.slice(0, 300) }); }
if (action === 'restart') { const r = await c.post(`/api/conversations/${conv}/runtime/restart`, {}); L({ step: 'restart', status: r.status, body: r.text.slice(0, 300) }); }
if (action === 'kill-aioncore') { a.proc.kill(); L({ step: 'aioncore TerminateProcess' }); }
await sleep(6000);
const liveSet = new Set(table().map((p) => p.ProcessId));
const watch = [...before.map((p) => ({ kind: 'aioncore-descendant', pid: p.pid, name: p.name })), ...treePids.map((p) => ({ kind: 'tree:' + p.role, pid: p.pid }))];
const survivors = watch.filter((w) => liveSet.has(w.pid) && !(action !== 'kill-aioncore' && w.name === 'conhost.exe'));
const treeSurvivors = survivors.filter((s) => s.kind.startsWith('tree:'));
L({ step: 'result', action, ms: Date.now() - tA, survivors, treeSurvivors: treeSurvivors.map((s) => s.kind), verdict: treeSurvivors.length ? 'FAIL' : 'PASS' });
writeJson(`${tag}.result.json`, { action, survivors });
for (const s of treeSurvivors) killFixture(s.pid);
if (action !== 'kill-aioncore') { a.proc.kill(); await sleep(3000);
  const live2 = new Set(table().map((p) => p.ProcessId));
  L({ step: 'after_aioncore_stop', survivors: watch.filter((w) => live2.has(w.pid)) });
  // Cleanup kills ONLY fixture pids self-reported in the pid file (never inferred descendants).
  for (const w of watch) if (w.kind.startsWith('tree:') && live2.has(w.pid)) killFixture(w.pid); }
process.exit(0);
