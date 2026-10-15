// One agent turn probe (R5/R6/R8/R11). Manual approvals: pending approvals are written to
// runtime/approvals/pending/<file>.json; the operator writes runtime/approvals/decide/<file>.json
// = {"option": <index>} or {"option": <index>, "always_allow": false}. Nothing is auto-approved.
// usage: node turn.mjs <serverTag> <agent:claude|codex|agy> <runTag> <promptFile> [overridesJson] [timeoutSec]
import { client, log, sleep, ROOT, writeJson, mask } from './lib.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [serverTag, agent, runTag, promptFile, overridesJson = '{}', timeoutSec = '600'] = process.argv.slice(2);
const ASSISTANT = { claude: 'bare:2d23ff1c', codex: 'bare:8e1acf31', agy: 'bare:a9f3c21e' }[agent];
if (!ASSISTANT) throw new Error('unknown agent');
const ev = `${runTag}.log`;
const { base, pid: aionPid } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${serverTag}.endpoint`), 'utf8'));
const authHeaders = existsSync(join(ROOT, 'runtime', `${serverTag}.auth.json`))
  ? JSON.parse(readFileSync(join(ROOT, 'runtime', `${serverTag}.auth.json`), 'utf8')).headers : {};
const c = client(base, { evid: `${runTag}.api.log`, headers: authHeaders });

// 1. worktree per attempt
const REPO = process.env.P0_REPO ?? join(ROOT, 'p0-sandbox', 'repo 測試 A');
const WT = process.env.P0_WT ?? join(ROOT, 'p0-sandbox', 'wt', runTag);
const baseCommit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!existsSync(WT)) execFileSync('git', ['-C', REPO, '-c', 'core.longpaths=true', 'worktree', 'add', '-q', '-b', `p0/${runTag}`, WT, baseCommit]);
log(ev, { step: 'worktree', WT, baseCommit });

// 1b. process sampler: descendants of aioncore with masked command lines (R5 evidence)
const procSeen = new Map(); let sampling = true;
(async () => {
  while (sampling) {
    try {
      const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const t = JSON.parse(out); const set = new Set([aionPid]); let grew = true;
      while (grew) { grew = false; for (const p of t) if (set.has(p.ParentProcessId) && !set.has(p.ProcessId)) { set.add(p.ProcessId); grew = true; } }
      for (const p of t) if (set.has(p.ProcessId) && p.ProcessId !== aionPid && !procSeen.has(p.ProcessId))
        procSeen.set(p.ProcessId, { pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: mask(String(p.CommandLine ?? '')).slice(0, 1500) });
    } catch {}
    await sleep(1000);
  }
})();

// 2. websocket recorder
const wsEvents = [];
let turnDone = null;
const wsUrl = base.replace('http', 'ws') + '/ws';
const ws = authHeaders.authorization ? new WebSocket(wsUrl, { headers: { authorization: authHeaders.authorization } }) : new WebSocket(wsUrl);
ws.addEventListener('message', (m) => {
  let j; try { j = JSON.parse(m.data); } catch { j = { raw: String(m.data).slice(0, 300) }; }
  if (j.name === 'ping') { ws.send(JSON.stringify({ name: 'pong', data: {} })); return; }
  const rec = { t: Date.now(), name: j.name, data: j.data };
  wsEvents.push(rec);
  writeFileSync(join(ROOT, 'reports', 'evidence', `${runTag}.ws.jsonl`), mask(JSON.stringify(rec)) + '\n', { flag: 'a' });
  if (convId && j.data?.conversation_id === convId && /^turn\.(completed|failed|cancelled|error)/.test(j.name ?? '')) turnDone = rec;
});
await new Promise((r, x) => { ws.addEventListener('open', r); ws.addEventListener('error', x); });

// 3. create conversation
let convId = null;
const overrides = JSON.parse(overridesJson);
const commandId = 'cmd_' + Date.now().toString(36);
const create = await c.post('/api/conversations', {
  name: `p0 ${runTag}`,
  assistant: { id: ASSISTANT, conversation_overrides: overrides },
  extra: { workspace: WT, conductor_command_id: commandId },
});
log(ev, { step: 'create', status: create.status, body: create.text.slice(0, 1500) });
convId = create.json?.data?.id;
if (!convId) { log(ev, { step: 'abort', reason: 'no conversation id' }); process.exit(2); }
const got = await c.get(`/api/conversations/${convId}`);
log(ev, { step: 'readback', extra: got.json?.data?.extra, type: got.json?.data?.type });

// 4. send
const prompt = `conductor-command-id: ${commandId}\n` + readFileSync(promptFile, 'utf8');
const send = await c.post(`/api/conversations/${convId}/messages`, { content: prompt });
log(ev, { step: 'send', status: send.status, body: send.text.slice(0, 800) });
const turnId = send.json?.data?.turn_id ?? send.json?.turn_id;

// 5. approvals: manual, via decision files
const PEND = join(ROOT, 'runtime', 'approvals', 'pending'); const DEC = join(ROOT, 'runtime', 'approvals', 'decide');
mkdirSync(PEND, { recursive: true }); mkdirSync(DEC, { recursive: true });
const known = new Map();
const deadline = Date.now() + Number(timeoutSec) * 1000; const startedAt = Date.now();
while (!turnDone && Date.now() < deadline) {
  const r = await c.get(`/api/conversations/${convId}/confirmations`);
  const list = r.json?.data ?? r.json ?? [];
  for (const cf of Array.isArray(list) ? list : []) {
    const key = `${runTag}__${convId}__${cf.call_id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!known.has(key)) {
      known.set(key, { cf, seenAt: Date.now() });
      writeFileSync(join(PEND, key + '.json'), JSON.stringify({ convId, ...cf }, null, 2));
      log(ev, { step: 'approval_pending', key, title: cf.title, action: cf.action, command_type: cf.command_type, description: mask(cf.description).slice(0, 1500), options: cf.options });
    }
  }
  for (const f of readdirSync(DEC)) {
    if (!f.startsWith(runTag + '__')) continue;
    const key = f.replace(/\.json$/, '');
    const k = known.get(key); if (!k || k.done) continue;
    const d = JSON.parse(readFileSync(join(DEC, f), 'utf8'));
    const opt = k.cf.options[d.option];
    const res = await c.post(`/api/conversations/${convId}/confirmations/${encodeURIComponent(k.cf.call_id)}/confirm`,
      { msg_id: k.cf.id, data: opt.value, always_allow: !!d.always_allow });
    k.done = true;
    log(ev, { step: 'approval_decided', key, option: opt, status: res.status, body: res.text.slice(0, 500), latency_ms: Date.now() - k.seenAt });
  }
  // REST fallback: runtime idle after processing => turn over (WS may have missed the event)
  const rt = await c.get(`/api/conversations/${convId}`);
  const run = rt.json?.data?.runtime;
  if (run && run.is_processing === false && run.turn_id == null && Date.now() - startedAt > 5000) { turnDone = turnDone ?? { name: 'rest.runtime.idle', data: run }; }
  await sleep(400);
}
log(ev, { step: 'turn_end', turnDone: turnDone ? { name: turnDone.name, data: turnDone.data } : null, timedOut: !turnDone, turnId });

// 6. readback
const msgs = await c.get(`/api/conversations/${convId}/messages`);
writeJson(`${runTag}.messages.json`, msgs.json);
const status = execFileSync('git', ['-C', WT, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' });
const diff = execFileSync('git', ['-C', WT, 'diff'], { encoding: 'utf8' });
log(ev, { step: 'git', status, diff: diff.slice(0, 3000) });
writeJson(`${runTag}.summary.json`, { convId, turnId, commandId, WT, wsEventNames: [...new Set(wsEvents.map((e) => e.name))], wsCount: wsEvents.length, approvals: [...known.keys()] });
sampling = false;
writeJson(`${runTag}.procs.json`, [...procSeen.values()]);
ws.close();
process.exit(0);
