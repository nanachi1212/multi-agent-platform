// W2 / R14: Conductor-side verify runner process-tree termination.
// A) baseline: spawn tree directly, kill with `taskkill /T /F` on root PID.
// B) candidate: spawn tree through job-runner.ps1, kill the wrapper (TerminateProcess).
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, log, sleep } from './lib.mjs';

const TREE = join(ROOT, 'fixtures', 'tree.mjs');
const alive = (pid) => execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(` ${pid} `);
const pidsOf = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Kill a fixture pid only if its current command line is still our tree fixture (PID-reuse safe).
function killFixture(pid) {
  try {
    const cmd = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
    if (cmd.includes('tree.mjs')) execFileSync('taskkill', ['/F', '/PID', String(pid)]);
  } catch {}
}

async function run(label, launch, kill) {
  const pf = join(ROOT, 'runtime', `w2-${label}.pids`); if (existsSync(pf)) rmSync(pf);
  const p = launch(pf);
  await sleep(Number(process.env.W2_WAIT ?? 3000)); // let root, sleeper, mid, leaf start; mid exits (orphans leaf)
  const pids = pidsOf(pf);
  const before = pids.map((x) => ({ ...x, alive: alive(x.pid) }));
  const t0 = Date.now(); kill(p); await sleep(2000);
  const after = pids.map((x) => ({ role: x.role, pid: x.pid, alive: alive(x.pid) }));
  const survivors = after.filter((x) => x.alive);
  log('w2.log', { label, wrapperPid: p.pid, before, after, survivors, killToCheckMs: Date.now() - t0, verdict: survivors.length ? 'FAIL' : 'PASS' });
  for (const s of survivors) killFixture(s.pid); // cleanup leftovers (fixture only)
  return survivors.length === 0;
}

const env = (pf) => ({ ...process.env, P0_TREE_PIDS: pf, P0_JOB_DIAG: pf + '.jobdiag' });
await run('A-baseline-taskkill-T', (pf) => spawn(process.execPath, [TREE, 'root'], { env: env(pf), windowsHide: true, stdio: 'ignore', shell: false }),
  (p) => { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)]); } catch (e) { log('w2.log', { taskkill_err: String(e.status) }); } });
const argv = Buffer.from(JSON.stringify([process.execPath, TREE, 'root'])).toString('base64');
await run('B-job-runner', (pf) => spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'spikes', 'job-runner.ps1'), '-ArgvB64', argv], { env: env(pf), windowsHide: true, stdio: 'ignore', shell: false }),
  (p) => p.kill());
// C) timeout path through same runner, with a fast-spawning grandchild at t≈0 (no wait before kill)
const pf = join(ROOT, 'runtime', 'w2-C.pids'); if (existsSync(pf)) rmSync(pf);
const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'spikes', 'job-runner.ps1'), '-ArgvB64', argv], { env: env(pf), windowsHide: true, stdio: 'ignore' });
await sleep(1500); p.kill(); await sleep(4000);
const pc = existsSync(pf) ? pidsOf(pf) : [];
log('w2.log', { label: 'C-early-kill-1500ms', seen: pc.map((x) => x.role), survivors: pc.filter((x) => alive(x.pid)) });
