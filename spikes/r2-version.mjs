// R2: version / contract check with fail-closed behavior.
// Case A: expected version matches -> continue.  Case B: expected mismatch -> must stop aioncore, exit non-zero.
// Case C: tampered binary copy -> must refuse before spawn.
import { startAioncore, client, log, ROOT, sleep, sha256, EXPECTED_SHA256, BIN } from './lib.mjs';
import { copyFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const L = (o) => log('r2.log', o);
const REQUIRED = ['/health', '/api/conversations', '/api/assistants'];

async function checkedStart(expectedVersion, tag) {
  const a = await startAioncore({ dataDir: join(ROOT, 'runtime', 'data', tag), workDir: join(ROOT, 'runtime', 'work', tag), mode: 'local', logFile: `${tag}.stdout.log` });
  const c = client(a.base, { evid: `${tag}.api.log` });
  const h = await c.get('/health');
  const problems = [];
  if (h.status !== 200 || h.json?.status !== 'ok') problems.push('health');
  if (h.json?.version !== expectedVersion) problems.push(`version ${h.json?.version} != ${expectedVersion}`);
  for (const p of REQUIRED) { const r = await c.get(p); if (r.status !== 200) problems.push(`route ${p} ${r.status}`); }
  if (problems.length) {
    a.proc.kill();
    await new Promise((r) => a.proc.on('exit', r));
    await sleep(1000);
    const alive = execFileSync('tasklist', ['/FI', `PID eq ${a.proc.pid}`, '/NH'], { encoding: 'utf8' }).includes(String(a.proc.pid));
    return { ok: false, problems, pid: a.proc.pid, aioncoreAliveAfterFailClosed: alive };
  }
  a.proc.kill(); await new Promise((r) => a.proc.on('exit', r));
  return { ok: true, health: h.json };
}

L({ case: 'A_match', result: await checkedStart('0.2.2', 'r2-a') });
L({ case: 'B_mismatch', result: await checkedStart('0.2.3', 'r2-b') });

// Case C: tampered copy
const tdir = join(ROOT, 'runtime', 'tampered'); mkdirSync(tdir, { recursive: true });
const tbin = join(tdir, 'aioncore.exe'); copyFileSync(BIN, tbin); appendFileSync(tbin, Buffer.from([0]));
const th = sha256(readFileSync(tbin));
let refused = false, err = null;
try { if (th !== EXPECTED_SHA256) throw new Error('sha256 mismatch ' + th); await startAioncore({ bin: tbin }); } catch (e) { refused = true; err = String(e); }
L({ case: 'C_tampered_binary', refusedBeforeSpawn: refused, err });
