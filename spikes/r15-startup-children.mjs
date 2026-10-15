// R15: record every descendant process AionCore spawns during startup (with command line),
// then stop AionCore and record which descendants survive.
import { startAioncore, log, sleep, ROOT, mask } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const resources = process.argv[2] ?? 'bundled';
const tag = `r15-${resources}-${Date.now()}`;
function table() {
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
const seen = new Map();
function sweep(root) {
  const t = table();
  const set = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (const p of t) if (set.has(p.ParentProcessId) && !set.has(p.ProcessId)) { set.add(p.ProcessId); grew = true; } }
  for (const p of t) if (set.has(p.ProcessId) && p.ProcessId !== root && !seen.has(p.ProcessId))
    seen.set(p.ProcessId, { pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: mask(String(p.CommandLine ?? '')).slice(0, 400), created: p.CreationDate });
  return t;
}
let sweeping = true, spawnedPid = 0;
(async () => { while (sweeping) { if (spawnedPid) { try { sweep(spawnedPid); } catch {} } await sleep(150); } })();
const a = await startAioncore({ onSpawn: (p) => { spawnedPid = p.pid; }, dataDir: join(ROOT, 'runtime', 'data', tag), workDir: join(ROOT, 'runtime', 'work', tag), mode: 'local', resources, logFile: `${tag}.stdout.log` });
// Sweep from spawn: also catch children created before READY.
const until = Date.now() + 30000;
while (Date.now() < until) { sweep(a.proc.pid); await sleep(250); }
sweeping = false;
log(`${tag}.log`, { event: 'descendants_seen', list: [...seen.values()] });
a.proc.kill();
await new Promise((r) => a.proc.on('exit', r));
await sleep(5000);
const t = table();
const live = new Set(t.map((p) => p.ProcessId));
log(`${tag}.log`, { event: 'survivors_5s_after_kill', list: [...seen.values()].filter((p) => live.has(p.pid)) });
