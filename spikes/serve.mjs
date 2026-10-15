// Keep a spike-owned aioncore running for manual probes. Writes base URL to runtime/<tag>.endpoint.
// Stop by deleting the endpoint file (polled) or killing this process (aioncore exits via --parent-pid).
import { startAioncore, log, sleep, ROOT } from './lib.mjs';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [tag = 'explore-local', mode = 'local', resources = 'bundled'] = process.argv.slice(2);
const ep = join(ROOT, 'runtime', `${tag}.endpoint`);
const a = await startAioncore({ dataDir: join(ROOT, 'runtime', 'data', tag), workDir: join(ROOT, 'runtime', 'work', tag), mode, resources, logFile: `${tag}.stdout.log`, logLevel: process.env.AION_LOG_LEVEL });
writeFileSync(ep, JSON.stringify({ base: a.base, pid: a.proc.pid, serverPid: process.pid }));
log(`${tag}.log`, { event: 'ready', base: a.base, pid: a.proc.pid });
a.proc.on('exit', (c) => { log(`${tag}.log`, { event: 'aioncore-exit', code: c }); process.exit(0); });
while (existsSync(ep)) await sleep(500);
a.proc.kill();
await sleep(1000);
process.exit(0);
