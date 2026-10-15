// R1 / R15 smoke: spike-owned launch, endpoint discovery, health, stop.
import { startAioncore, client, log, sleep, ROOT, processTable, descendants } from './lib.mjs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'local';
const resources = process.argv[3] ?? 'bundled';
const tag = `r1-${mode}-${resources}`;
const dataDir = join(ROOT, 'runtime', 'data', tag);
const workDir = join(ROOT, 'runtime', 'work', tag);
const t0 = Date.now();
try {
  const a = await startAioncore({ dataDir, workDir, mode, resources, logFile: `${tag}.stdout.log` });
  log(`${tag}.log`, { event: 'ready', port: a.port, base: a.base, ms: Date.now() - t0, pid: a.proc.pid });
  const c = client(a.base, { evid: `${tag}.api.log` });
  for (const p of ['/health', '/api/auth/status', '/api/system/info', '/api/version', '/api/agents', '/api/conversations']) {
    const r = await c.get(p);
    log(`${tag}.log`, { path: p, status: r.status, body: r.text.slice(0, 600) });
  }
  await sleep(1500);
  const tbl = await processTable();
  log(`${tag}.log`, { event: 'children', list: descendants(tbl, a.proc.pid) });
  a.proc.kill();
  const exit = await new Promise((r) => a.proc.on('exit', (c, s) => r({ c, s })));
  log(`${tag}.log`, { event: 'stopped', exit });
} catch (e) {
  log(`${tag}.log`, { event: 'error', error: String(e) });
  process.exitCode = 1;
}
