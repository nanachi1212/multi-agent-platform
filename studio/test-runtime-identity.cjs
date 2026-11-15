// Deterministic ownership regressions: no files, providers, servers, or real processes are started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { killProcessTree, killIdentities, getChildPids } = await import('./runtime-registry.mjs');
  const row = (pid, parent, when = pid, executable = 'node.exe') => ({ pid, parent, executable,
    creationDate: new Date(when * 1000).toISOString() });
  const root = row(101, 1), child = row(202, 101);
  const realKill = process.kill;
  let alive, killed;
  const reset = (...pids) => { alive = new Set(pids); killed = []; };
  process.kill = (pid, signal) => {
    if (signal === 0) {
      if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }
    assert.equal(signal, 'SIGKILL'); killed.push(pid); alive.delete(pid); return true;
  };
  try {
    for (const old of [{ pid: child.pid }, { ...child, creationDate: '' }, { ...child, executable: '' }]) {
      reset(child.pid);
      await assert.rejects(killIdentities([old], async () => [old]), /identity is unconfirmed/);
      assert.deepEqual(killed, [], 'unknown saved identities fail closed rather than matching empty metadata');
    }
    for (const rows of [[], [{ ...root, creationDate: '' }], [{ ...root, executable: '' }]]) {
      reset(root.pid);
      assert.equal((await killProcessTree(root.pid, async () => rows)).ok, false);
      assert.deepEqual(killed, [], 'missing root identity never permits a bare PID kill');
    }
    for (const changed of [{ ...root, creationDate: 'different' }, { ...root, executable: 'other.exe' }]) {
      reset(root.pid);
      const result = await killProcessTree(root.pid, async () => [changed], root);
      assert.equal(result.ok, false); assert.deepEqual(killed, []);
      assert.deepEqual(result.left, [root], 'preserve the expected root, not the recycled process');
      await assert.rejects(getChildPids(root.pid, async () => [changed, child], root), /identity changed/);
    }
    for (const fresh of [[], [{ ...root, creationDate: 'recycled' }]]) {
      reset(root.pid, child.pid); let calls = 0;
      const result = await killProcessTree(root.pid, async () => ++calls === 1 ? [root, child] : fresh, root);
      assert.equal(result.ok, false); assert.deepEqual(killed, []);
      assert.deepEqual(result.left.map(p => p.pid), [root.pid, child.pid]);
    }
    reset(root.pid);
    const unavailable = await killProcessTree(root.pid, async () => { throw new Error('CIM denied'); }, root);
    assert.equal(unavailable.ok, false); assert.deepEqual(unavailable.left, [root]); assert.deepEqual(killed, []);
    reset(root.pid, child.pid); let deniedCalls = 0;
    const denied = await killProcessTree(root.pid, async () => {
      if (++deniedCalls > 1) throw new Error('CIM denied'); return [root, child];
    }, root);
    assert.equal(denied.ok, false); assert.deepEqual(killed, []);

    // The already-required root recheck also captures children born since the first snapshot.
    const late = row(303, root.pid), grandchild = row(404, late.pid), unrelated = row(505, 1);
    reset(root.pid, child.pid, late.pid, grandchild.pid, unrelated.pid); let windowCalls = 0;
    const expanded = await killProcessTree(root.pid, async () => ++windowCalls === 1 ? [root, child]
      : [root, child, late, grandchild, unrelated].filter(p => alive.has(p.pid)), root);
    assert.equal(expanded.ok, true); assert.deepEqual(killed, [root.pid, child.pid, late.pid, grandchild.pid]);
    assert.ok(alive.has(unrelated.pid), 'the second snapshot never adopts an unrelated sibling');

    // A reused child PID in the second tree must not overwrite its first-snapshot identity.
    for (const changed of [{ ...child, creationDate: new Date(999000).toISOString() }, { ...child, executable: 'other.exe' }]) {
      reset(root.pid, child.pid); let calls = 0;
      const result = await killProcessTree(root.pid, async () => ++calls === 1 ? [root, child] : [root, changed], root);
      assert.equal(result.ok, false); assert.deepEqual(killed, []);
      assert.deepEqual(result.left.find(p => p.pid === child.pid), {
        pid: child.pid, creationDate: child.creationDate, executable: child.executable
      }, 'the original child identity survives a conflicting later snapshot');
    }
    for (const unknown of [{ ...late, creationDate: '' }, { ...late, executable: '' }]) {
      reset(root.pid, child.pid, late.pid); let calls = 0;
      const result = await killProcessTree(root.pid, async () => ++calls === 1 ? [root, child] : [root, child, unknown], root);
      assert.equal(result.ok, false); assert.deepEqual(killed, [], 'unknown late descendants block rather than being killed');
    }
    // A child retained from the first tree still gets its identity rechecked if its parent exits meanwhile.
    reset(root.pid, child.pid, grandchild.pid); let orphanCalls = 0;
    const orphan = { ...grandchild, parent: child.pid };
    const retained = await killProcessTree(root.pid, async () => {
      if (++orphanCalls === 1) return [root, child, orphan];
      alive.delete(child.pid); return [root, orphan].filter(p => alive.has(p.pid));
    }, root);
    assert.equal(retained.ok, true); assert.deepEqual(killed, [root.pid, orphan.pid]);

    reset(root.pid, child.pid);
    const stopped = await killProcessTree(root.pid, async () => [root, child].filter(p => alive.has(p.pid)), root);
    assert.equal(stopped.ok, true); assert.deepEqual(killed, [root.pid, child.pid]);
    reset(root.pid, child.pid);
    const reusedChild = await killProcessTree(root.pid, async () => alive.has(root.pid)
      ? [root, child] : [{ ...child, creationDate: 'recycled' }], root);
    assert.equal(reusedChild.ok, true); assert.deepEqual(killed, [root.pid]);
    assert.ok(alive.has(child.pid), 'child identity revalidation remains intact');
  } finally { process.kill = realKill; }

  // Exercise the production ownership function with injected OS queries, so these cases also run on Linux.
  const source = fs.readFileSync(path.join(__dirname, 'runtime-registry.mjs'), 'utf8');
  const code = source.slice(source.indexOf('export async function checkPortOwnership'))
    .replace('export async function', 'async function') + '\nreturn checkPortOwnership;';
  let descendants = [child.pid], verified = true, queried = 0;
  const check = new Function('getPortOccupant', 'loadRuntimes', 'runtimesFile', 'verifyRuntimeProcess',
    'getChildPids', 'isPidAlive', 'getProcessInfo', 'processSnapshot', 'path', code)(
    async () => child.pid, () => [], () => '', async () => ({ ok: verified, alive: true }),
    async (pid, snapshot, expected) => {
      queried++; assert.equal(pid, root.pid); assert.deepEqual(expected, root);
      if (descendants instanceof Error) throw descendants;
      return descendants;
    }, () => true, async () => ({ command: 'listener' }), async () => [], path);
  const runtime = { runtime_id: 'managed', root_pid: root.pid, process_identity: root, child_pids: [],
    status: 'running', created_by: 'studio', port: 3020, job_id: 'job', data_dir: path.resolve('data') };
  const options = { desiredJobId: 'job', desiredDataDir: runtime.data_dir, customRuntimes: [runtime] };
  assert.equal((await check(3020, options)).status, 'owned_by_current_job');
  assert.equal(queried, 1, 'an unsaved listener child is checked against the live owned tree');
  descendants = [];
  assert.equal((await check(3020, options)).owner, 'unknown', 'unrelated sibling is never adopted');
  descendants = new Error('Root process identity changed');
  assert.equal((await check(3020, options)).owner, 'unknown', 'recycled root remains unknown');
  descendants = [child.pid]; verified = false;
  assert.equal((await check(3020, options)).owner, 'unknown', 'unverified parent cannot claim child');
  verified = true;
  assert.equal((await check(3020, { ...options, desiredJobId: 'another-job' })).status, 'blocked');
  console.log('Runtime identity: missing/reused roots, late descendants, per-kill revalidation, and live child listener ownership: PASS');

  // One "process alive" check for registry and server: only ESRCH means gone; unsure or a non-number PID counts as alive.
  const { isPidAlive } = await import('./runtime-registry.mjs');
  const server = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
  assert.match(server, /^const pidAlive = isPidAlive;/m, 'server.mjs uses the registry implementation');
  assert.equal(isPidAlive(process.pid), true); assert.equal(isPidAlive('not-a-pid'), true);
  for (const none of [0, null, undefined, -5]) assert.equal(isPidAlive(none), false);
  const kill0 = process.kill;
  try {
    for (const [code, want] of [['ESRCH', false], ['EPERM', true], ['EINVAL', true]]) {
      process.kill = () => { throw Object.assign(new Error(code), { code }); };
      assert.equal(isPidAlive(4242), want, code);
    }
  } finally { process.kill = kill0; }
  console.log('isPidAlive: one conservative implementation: PASS');

  // AionCore ending by itself after ready is logged once and shown on the seats; Studio closing is not reported.
  const aionSrc = server.slice(server.indexOf('let aionProcess, aionGone'), server.indexOf('const codexRuntime'));
  for (const closing of [false, true]) {
    const events = [], errors = [], agents = { codex: { status: 'available', note: '' } }, realError = console.error;
    console.error = (m) => errors.push(m);
    try {
      const env = new Function('S', 'event', aionSrc + (closing ? 'aionClosing = true;' : '') + 'return { aionExited, gone: () => aionGone };')({ agents }, (t, d) => events.push(t));
      env.aionExited(3, null); env.aionExited(3, null);
      assert.equal(events.length, closing ? 0 : 1); assert.equal(errors.length, closing ? 0 : 1);
      assert.equal(agents.codex.status, closing ? 'available' : 'unavailable');
      if (!closing) { assert.match(agents.codex.note, /AionCore 已停止，請重新啟動 Studio/); assert.match(errors[0], /exit code 3/); }
    } finally { console.error = realError; }
  }
  assert.match(server, /p\.on\('exit', \(c, sig\) => \(BASE \? aionExited\(c, sig\)/, 'exit after ready goes to aionExited');
  assert.match(server, /async function api\(method, p, body\) \{\r?\n  if \(aionGone\) throw new Error\(aionGone\);/);
  console.log('AionCore exit after ready is reported, Studio shutdown is not: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
