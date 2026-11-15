// Deterministic Windows query fixtures; no listener/provider/server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'runtime-registry.mjs'), 'utf8');
  const portCode = source.slice(source.indexOf('export async function getPortOccupant'), source.indexOf('// ---------- Safety checks'))
    .replace('export async function', 'async function') + '\nreturn getPortOccupant;';
  const query = (rows, fallback = '') => new Function('process', 'execPowerShell', 'execCmd', portCode)(
    { platform: 'win32' }, async () => { if (rows instanceof Error) throw rows; return JSON.stringify(rows); },
    async () => { if (fallback instanceof Error) throw fallback; return fallback; });
  const row = (address, pid) => ({ LocalAddress: address, LocalPort: 3020, OwningProcess: pid });
  const getPortOccupant = query([row('::1', 101), row('127.0.0.1', 202)]);
  assert.equal(await getPortOccupant(3020), 202, 'IPv6-only managed listener cannot own the IPv4 health endpoint');
  assert.equal(await query([row('10.0.0.1', 101)])(3020), null);
  assert.equal(await query([row('0.0.0.0', 101)])(3020), 101);
  assert.equal(await query([row('::', 101)])(3020), 101);
  const netstat = '  TCP    [::1]:3020    [::]:0    LISTENING    101\n  TCP    127.0.0.1:3020    0.0.0.0:0    LISTENING    202\n';
  assert.equal(await query(new Error('CIM unavailable'), netstat)(3020), 202);
  const ambiguous = [row('::', 101), row('127.0.0.1', 202)];
  await assert.rejects(query(ambiguous, netstat.replace('[::1]', '[::]'))(3020), /Cannot confirm/);
  await assert.rejects(query(ambiguous, netstat)(3020), /Cannot confirm/, 'a confirmed ambiguity is not overridden by the fallback');
  await assert.rejects(query(new Error('CIM failed'), new Error('netstat failed'))(3020), /Cannot confirm/);
  const runtime = { runtime_id: 'managed', root_pid: 101, process_identity: { creationDate: 'new', executable: 'node.exe' },
    child_pids: [], status: 'running', created_by: 'studio', port: 3020, job_id: 'job', data_dir: path.resolve('data') };
  const checkCode = source.slice(source.indexOf('export async function checkPortOwnership'))
    .replace('export async function', 'async function') + '\nreturn checkPortOwnership;';
  const check = new Function('getPortOccupant', 'loadRuntimes', 'runtimesFile', 'verifyRuntimeProcess', 'getChildPids',
    'isPidAlive', 'getProcessInfo', 'processSnapshot', 'path', checkCode)(getPortOccupant, () => [runtime], () => '',
      async () => ({ ok: true, alive: true }), async () => [], () => true, async () => ({ command: 'unrelated' }), async () => [], path);
  const { checkBackendReadiness } = await import('./runtime-readiness.mjs');
  const result = await checkBackendReadiness(runtime, { isPidAlive: () => true, portReachable: async () => true,
    getHealth: async () => ({ httpStatus: 200, body: { ready: true } }), // unrelated IPv4 service
    verifyOwnership: async (r) => { const p = await check(r.port, { desiredJobId: r.job_id, desiredDataDir: r.data_dir });
      return { ok: p.owner === 'studio' && p.runtime?.runtime_id === r.runtime_id }; } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_verified, false);
  console.log('Runtime endpoint: IPv4 listener attribution, wildcard ambiguity, query failure, and unrelated health rejection: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
