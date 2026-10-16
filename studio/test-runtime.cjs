// Automated verification for Workstream B+C:
// Runtime Ownership Registry, Process Tree Cleanup, Port Ownership, and Test/Smoke Isolation.
// Test cases covered:
//   Case H: Smoke 隔離 (formal vs smoke DATA_DIR separated, 3028 lock does not block 3018)
//   Case I: Stale smoke 自動 cleanup (detects dead PID, updates status to cleaned, removes temp data dir)
//   Case J: 未知 process 不 kill 並回報 PID/command (reports PID, command, blocked reason, process stays alive)
//   Case L: 只清理該 job process tree 不影響其他 python/node (targeted PID tree kill)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const TMP_DIRS = [];
const SPAWNED_PROCS = [];

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}

function safeKill(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      process.kill(proc.pid, 'SIGKILL');
    }
  } catch (e) {}
}

function waitOutput(proc, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Process did not become ready: ' + output)), 10000);
    const onData = (data) => { output += data; const match = output.match(pattern); if (match) finish(null, match); };
    const onExit = (code) => finish(new Error('Process exited before ready: ' + code));
    const finish = (error, value) => {
      clearTimeout(timer); proc.stdout.off('data', onData); proc.off('exit', onExit); proc.off('error', onExit);
      error ? reject(error) : resolve(value);
    };
    proc.stdout.on('data', onData); proc.once('exit', onExit); proc.once('error', onExit);
  });
}

async function runRuntimeTests() {
  const registry = await import('./runtime-registry.mjs');
  const isolated = await import('./isolated-env.mjs');
  const readiness = await import('./runtime-readiness.mjs');

  try {
  console.log('--- Running Workstream B+C Runtime & Isolation Tests ---');

  // =========================================================================
  // Case H: Smoke 隔離
  // 正式與 smoke DATA_DIR 不同、3028 活著時 3018 仍可取鎖
  // 用假的 lock-holding 子程序模擬，不得動真實 TWstock data
  // =========================================================================
  {
    const mockProdDir = mkTmp('mock-prod-twstock-');
    const prodDataDir = path.join(mockProdDir, 'data');
    fs.mkdirSync(prodDataDir, { recursive: true });

    const smokeEnv = await isolated.createSmokeEnvironment({
      project: mockProdDir,
      runId: 'smoke-run-h-1234',
      preferredPort: 3028
    });
    TMP_DIRS.push(smokeEnv.tempRoot);

    // 1. DATA_DIR must be strictly isolated from production ./data
    assert.notStrictEqual(path.resolve(smokeEnv.dataDir), path.resolve(prodDataDir), 'smoke DATA_DIR must not be production data_dir');
    assert.ok(smokeEnv.dataDir.includes('MultiAgentStudio'), 'smoke DATA_DIR must be under MultiAgentStudio temp directory');
    assert.notStrictEqual(smokeEnv.port, 3018, 'smoke port must not collide with production 3018');
    assert.notStrictEqual(smokeEnv.port, 3011, 'smoke port must not collide with production 3011');

    // 2. Simulate smoke backend holding .mining_process.lock inside smokeEnv.dataDir
    // We launch a dummy node process holding an exclusive lock on smokeEnv.dataDir/.mining_process.lock
    const lockScript = `
      const fs = require('fs');
      const p = process.argv[1];
      const fd = fs.openSync(p, 'wx');
      // Hold file descriptor open and write marker
      fs.writeSync(fd, 'locked by smoke');
      console.log('LOCKED');
      setInterval(() => {}, 1000);
    `;
    const smokeLockFile = path.join(smokeEnv.dataDir, '.mining_process.lock');
    const smokeProc = spawn(process.execPath, ['-e', lockScript, smokeLockFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    SPAWNED_PROCS.push(smokeProc);
    await waitOutput(smokeProc, /LOCKED/);

    assert.strictEqual(registry.isPidAlive(smokeProc.pid), true);
    assert.strictEqual(fs.readFileSync(smokeLockFile, 'utf8'), 'locked by smoke');
    assert.throws(() => fs.openSync(smokeLockFile, 'wx'), /EEXIST/);
    // Register smoke process into runtime registry on port 3028
    const rt = registry.registerRuntime({
      job_id: 'smoke-run-h-1234',
      purpose: 'smoke',
      root_pid: smokeProc.pid,
      process_identity: await registry.getProcessInfo(smokeProc.pid),
      executable: process.execPath,
      command: 'smoke backend on port 3028',
      port: 3028,
      data_dir: smokeEnv.dataDir,
      temp_dir: smokeEnv.tempRoot,
      rtDir: mockProdDir
    });
    assert.strictEqual(rt.purpose, 'smoke');
    assert.strictEqual(rt.port, 3028);

    // 3. While the smoke lock remains held on 3028, a separate fake production process
    // acquires its own lock and reports healthy through the 3018 readiness contract.
    const prodLockFile = path.join(prodDataDir, '.mining_process.lock');
    const prodLockScript = `const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'wx'); fs.writeSync(fd, 'locked by prod'); console.log('LOCKED'); setInterval(() => {}, 1000);`;
    const prodProc = spawn(process.execPath, ['-e', prodLockScript, prodLockFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    SPAWNED_PROCS.push(prodProc);
    await waitOutput(prodProc, /LOCKED/);
    assert.ok(fs.existsSync(prodLockFile), 'production data lock successfully created and acquired');
    const prodRuntime = registry.registerRuntime({
      job_id: 'production-3018-h-1234', purpose: 'dev_backend', root_pid: prodProc.pid,
      process_identity: await registry.getProcessInfo(prodProc.pid), executable: process.execPath,
      command: 'fake production backend with isolated lock', port: 3018, data_dir: prodDataDir, rtDir: mockProdDir
    });
    const prodReady = await readiness.checkBackendReadiness(prodRuntime, {
      isPidAlive: registry.isPidAlive,
      verifyOwnership: async (runtime) => ({ ok: runtime.runtime_id === prodRuntime.runtime_id && runtime.data_dir === prodDataDir,
        reason: 'production runtime identity mismatch' }),
      // Keep the regression deterministic and avoid binding the host's real 3018 port.
      portReachable: async (port) => port === 3018,
      getHealth: async (port) => port === 3018
        ? { httpStatus: 200, body: { status: 'ok' } }
        : { httpStatus: 503, body: { error: 'wrong port' } }
    });
    assert.strictEqual(registry.isPidAlive(smokeProc.pid), true, 'the stale smoke lock owner remains present during the regression');
    assert.strictEqual(prodReady.status, 'BACKEND_READY', '3028 smoke lock residue does not prevent the isolated 3018 backend from becoming ready');
    assert.strictEqual(prodReady.health_http_status, 200);

    // Clean up smoke process
    safeKill(smokeProc);
    safeKill(prodProc);
    smokeEnv.cleanup();
    console.log('Case H: 3028 smoke lock retained; isolated 3018 production lock acquired and readiness BACKEND_READY: PASS');
  }

  // =========================================================================
  // Case I: Stale smoke 自動 cleanup
  // 偵測殘留 stale runtime，啟動/掃描時自動清理資源與 temp dir
  // =========================================================================
  {
    const rtDir = mkTmp('studio-rt-stale-');
    const deadTempDir = path.join(os.tmpdir(), 'MultiAgentStudio', 'stale-test-proj', 'stale-run-999');
    const deadDataDir = path.join(deadTempDir, 'data');
    fs.mkdirSync(deadDataDir, { recursive: true });
    fs.writeFileSync(path.join(deadDataDir, 'stale-marker.txt'), 'residue');
    TMP_DIRS.push(deadTempDir);

    // Register a stale smoke runtime with a non-existent PID (e.g. 999998)
    const deadPid = 999998;
    assert.strictEqual(registry.isPidAlive(deadPid), false, 'deadPid must not be alive');

    registry.registerRuntime({
      job_id: 'stale-job-i',
      purpose: 'smoke',
      root_pid: deadPid,
      executable: 'python.exe',
      command: 'python -m uvicorn app.main:app --port 3028',
      port: 3028,
      data_dir: deadDataDir,
      temp_dir: deadTempDir,
      rtDir
    });

    const beforeList = registry.listRuntimes({ rtDir });
    assert.strictEqual(beforeList.length, 1);
    assert.strictEqual(beforeList[0].status, 'running');

    // Run cleanup
    const cleanupReport = await registry.cleanupStaleRuntimes({ rtDir });
    assert.ok(cleanupReport.cleanedCount >= 1, 'at least 1 stale runtime must be cleaned');

    const afterList = registry.listRuntimes({ rtDir });
    assert.strictEqual(afterList[0].status, 'cleaned', 'stale smoke runtime must be marked cleaned');
    assert.strictEqual(fs.existsSync(deadTempDir), false, 'stale temp directory must be removed from disk');

    console.log('Case I: stale smoke 自動 cleanup（偵測 dead PID、標記 cleaned、刪除暫存目錄）: PASS');
  }

  // =========================================================================
  // Case J: 未知 process 不 kill 並回報 PID/command
  // owner 不明者絕不 kill，回報具體 PID/command/port/DATA_DIR 並給出 blocked 原因字串
  // =========================================================================
  {
    const rtDir = mkTmp('studio-rt-unknown-');
    let testPort; // OS chooses a free port; never touch production listeners.

    // Spawn an unknown dummy HTTP server process
    const dummyServerScript = `
      const http = require('http');
      const s = http.createServer((req, res) => res.end('hello'));
      s.listen(0, '127.0.0.1', () => {
        console.log('READY:' + s.address().port);
      });
      setInterval(() => {}, 1000);
    `;
    const unknownProc = spawn(process.execPath, ['-e', dummyServerScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    SPAWNED_PROCS.push(unknownProc);

    testPort = Number((await waitOutput(unknownProc, /READY:(\d+)/))[1]);

    // Check port ownership without registering it in Studio
    const portReport = await registry.checkPortOwnership(testPort, {
      desiredJobId: 'new-job-1',
      rtDir
    });

    // 1. Report must identify unknown owner and be blocked
    assert.strictEqual(portReport.status, 'blocked');
    assert.strictEqual(portReport.available, false);
    assert.strictEqual(portReport.owner, 'unknown');
    assert.strictEqual(portReport.pid, unknownProc.pid);
    assert.ok(portReport.command.toLowerCase().includes('node') || portReport.executable.toLowerCase().includes('node'));
    assert.strictEqual(portReport.port, testPort);
    assert.ok(portReport.reason.includes('Blocked: unknown process PID'), `reason must match Blocked pattern: ${portReport.reason}`);

    // 2. CRITICAL CHECK: unknown process MUST STILL BE ALIVE! NEVER KILLED!
    assert.strictEqual(registry.isPidAlive(unknownProc.pid), true, 'unknown process must NOT be killed!');

    // Clean up
    safeKill(unknownProc);
    console.log('Case J: 未知 process 不 kill 並回報 PID/command（絕不殺程序，回報完整資訊）: PASS');
  }

  // =========================================================================
  // Case L: 只清理該 job process tree 不影響其他 python/node
  // Windows 用 PID tree，禁止 Stop-Process -Name python 或依名稱殺程序
  // =========================================================================
  {
    const rtDir = mkTmp('studio-rt-targeted-');

    // Process A (Parent) spawns Process A_Child
    const treeScript = `
      const cp = require('child_process');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { windowsHide: true });
      console.log('CHILD:' + child.pid);
      setInterval(() => {}, 1000);
    `;
    const procA = spawn(process.execPath, ['-e', treeScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    SPAWNED_PROCS.push(procA);

    const childPid = Number((await waitOutput(procA, /CHILD:(\d+)/))[1]);
    SPAWNED_PROCS.push({ pid: childPid });

    // Process B: Independent process (representing another job or external worker)
    const procB = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });
    SPAWNED_PROCS.push(procB);

    await new Promise((r) => setTimeout(r, 200));

    // Verify all processes are alive
    assert.strictEqual(registry.isPidAlive(procA.pid), true, 'procA must be alive');
    assert.ok(childPid > 0, 'child PID must be captured');
    if (childPid) assert.strictEqual(registry.isPidAlive(childPid), true, 'childPid must be alive');
    assert.strictEqual(registry.isPidAlive(procB.pid), true, 'procB must be alive');

    // Register procA to 'job-target-1'
    registry.registerRuntime({
      job_id: 'job-target-1',
      purpose: 'dev_backend',
      root_pid: procA.pid,
      process_identity: await registry.getProcessInfo(procA.pid),
      child_pids: childPid ? [childPid] : [],
      executable: process.execPath,
      command: 'node backend tree',
      rtDir
    });

    // Register procB to a different job 'job-unrelated'
    registry.registerRuntime({
      job_id: 'job-unrelated',
      purpose: 'helper',
      root_pid: procB.pid,
      process_identity: await registry.getProcessInfo(procB.pid),
      executable: process.execPath,
      command: 'node independent worker',
      rtDir
    });

    const reused = registry.registerRuntime({ job_id: 'job-reused', root_pid: procB.pid,
      executable: process.execPath, process_identity: { creationDate: 'wrong-creation-time', executable: process.execPath }, rtDir });
    const refused = await registry.cleanupJobRuntimes('job-reused', { rtDir });
    assert.strictEqual(refused.blocked.length, 1);
    assert.strictEqual(registry.isPidAlive(procB.pid), true, 'PID reuse never kills unrelated process');
    assert.strictEqual(registry.listRuntimes({ rtDir }).find(x => x.runtime_id === reused.runtime_id).status, 'running');
    assert.strictEqual(registry.isSafeTempDir(os.tmpdir()), false);
    assert.strictEqual(registry.isSafeTempDir(path.join(os.tmpdir(), 'MultiAgentStudio')), false);
    assert.strictEqual(registry.isSafeTempDir(path.join(os.tmpdir() + '-sibling', 'MultiAgentStudio', 'p', 'r')), false);
    const one = isolated.getIsolatedDataDir('..', '..'), two = isolated.getIsolatedDataDir('..', '..');
    TMP_DIRS.push(one.tempRoot, two.tempRoot);
    assert.notStrictEqual(one.dataDir, two.dataDir, 'each smoke environment gets its own data owner');
    assert.strictEqual(registry.isSafeTempDir(one.tempRoot), true);

    // Cleanup ONLY 'job-target-1'
    await registry.cleanupJobRuntimes('job-target-1', { rtDir });

    await new Promise((r) => setTimeout(r, 400));

    // Verify: procA and its child are DEAD
    assert.strictEqual(registry.isPidAlive(procA.pid), false, 'procA must be dead after job cleanup');
    if (childPid) assert.strictEqual(registry.isPidAlive(childPid), false, 'child process must be dead after tree kill');

    // CRITICAL: procB MUST STILL BE ALIVE! (Did not kill other node/python processes)
    assert.strictEqual(registry.isPidAlive(procB.pid), true, 'procB must NOT be affected by cleanup of job-target-1!');

    // Clean up procB
    safeKill(procB);
    console.log('Case L: 只清理該 job process tree 不影響其他 python/node: PASS');
  }

  // PID reuse: a process whose ParentProcessId matches but that is older than the parent is not a descendant.
  {
    const at = (s) => new Date(s * 1000).toISOString();
    const rows = [
      { pid: process.pid, parent: 1, creationDate: at(100) },
      { pid: 900001, parent: process.pid, creationDate: at(200) }, // real child
      { pid: 900002, parent: process.pid, creationDate: at(50) }, // older: its parent PID was reused (e.g. a user's Vite server)
      { pid: 900003, parent: 900002, creationDate: at(300) } // child of the unrelated process
    ];
    assert.deepStrictEqual(await registry.getChildPids(process.pid, async () => rows), [900001]);
    await assert.rejects(registry.getChildPids(process.pid, async () => { throw new Error('CIM denied'); }), /CIM denied/, 'a failed query is not an empty tree');
    console.log('PID reuse: older process with a matching parent PID is not selected for kill: PASS');
  }

  // Reviewer P1: a child PID reused after the root died must not be killed; only an unchanged identity is.
  {
    const spawnIdle = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); SPAWNED_PROCS.push(c); return c; };
    const [root, reused, same] = [spawnIdle(), spawnIdle(), spawnIdle()];
    const row = (pid, parent, s, exe = 'node.exe') => ({ pid, parent, executable: exe, command: '', creationDate: new Date(s * 1000).toISOString() });
    const before = [row(root.pid, 1, 100), row(reused.pid, root.pid, 200), row(same.pid, root.pid, 200)];
    let calls = 0;
    const result = await registry.killProcessTree(root.pid, async () => ++calls === 1 ? before
      : [row(reused.pid, 1, 999), row(same.pid, 1, 200, 'NODE.EXE')]); // reused PID: new creation time
    assert.deepStrictEqual(result.children, [same.pid]);
    assert.ok(registry.isPidAlive(reused.pid), 'a reused child PID is never killed');
    assert.ok(!registry.isPidAlive(same.pid) && !registry.isPidAlive(root.pid));
    reused.kill();
    console.log('killProcessTree: child identity revalidated before kill: PASS');
  }

  // Reviewer P1: a Codex record left 'stopping' is cleaned from its saved identities on the next Studio start.
  {
    const rtDir = mkTmp('studio-stopping-');
    const { processSnapshot } = await import('./codex-runtime.mjs');
    const spawnIdle = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); SPAWNED_PROCS.push(c); return c; };
    const [orphan, reused] = [spawnIdle(), spawnIdle()];
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = await processSnapshot(), id = (c) => { const p = rows.find((r) => r.pid === c.pid); return { pid: p.pid, executable: p.executable, creationDate: p.creationDate }; };
    const add = (tree) => { const r = registry.registerRuntime({ rtDir, job_id: 'studio_core', purpose: 'codex_session', root_pid: tree[0].pid, process_identity: tree[0], studio_pid: 2147483000 });
      registry.updateRuntime(r.runtime_id, { status: 'stopping', process_tree: tree }, { rtDir }); return r.runtime_id; };
    const a = add([id(orphan)]), b = add([{ ...id(reused), creationDate: 'old' }]);
    await registry.cleanupStaleRuntimes({ rtDir });
    const status = (rid) => registry.listRuntimes({ rtDir }).find((r) => r.runtime_id === rid).status;
    assert.strictEqual(status(a), 'cleaned'); assert.ok(!registry.isPidAlive(orphan.pid), 'stopping orphan killed by saved identity');
    assert.strictEqual(status(b), 'cleaned'); assert.ok(registry.isPidAlive(reused.pid), 'a reused PID is not killed');
    reused.kill();
    console.log('stopping Codex record recovered at startup: PASS');
  }

  // Review round 2: per-kill revalidation, failed kills stay reported, failed/PID-reused recovery stays retryable.
  {
    const spawnIdle = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); SPAWNED_PROCS.push(c); return c; };
    const row = (pid, s, exe = 'node.exe') => ({ pid, parent: 1, executable: exe, command: '', creationDate: new Date(s * 1000).toISOString() });
    const realKill = process.kill;
    const rtDir = mkTmp('studio-stopping2-');
    const add = (tree, extra = {}) => { const r = registry.registerRuntime({ rtDir, job_id: 'studio_core', purpose: 'codex_session', root_pid: tree[0].pid, process_identity: tree[0], studio_pid: 2147483000 });
      registry.updateRuntime(r.runtime_id, { status: 'stopping', process_tree: tree, ...extra }, { rtDir }); return r.runtime_id; };
    const status = (rid) => registry.listRuntimes({ rtDir }).find((r) => r.runtime_id === rid);

    // recovery: a child whose PID was reused only after the root died is not killed
    const [root, victim] = [spawnIdle(), spawnIdle()];
    const tree = [row(root.pid, 100), row(victim.pid, 200)];
    let alive = [...tree];
    const killed = [];
    process.kill = (pid, sig) => { if (sig === 'SIGKILL') { killed.push(pid); if (pid === root.pid) alive = [row(victim.pid, 999)]; return true; } return realKill(pid, sig); };
    try {
      const a = add(tree);
      await registry.cleanupStaleRuntimes({ rtDir, snapshot: async () => alive });
      assert.deepStrictEqual(killed, [root.pid], 'reused child PID is not killed');
      assert.strictEqual(status(a).status, 'cleaned');

      // a verified child whose kill fails is reported and keeps the record 'stopping' (retryable), then recovers
      alive = [row(victim.pid, 200)]; killed.length = 0;
      process.kill = (pid, sig) => { if (sig === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EPERM' }); return realKill(pid, sig); };
      const b = add([row(victim.pid, 200)]);
      await registry.cleanupStaleRuntimes({ rtDir, snapshot: async () => alive });
      assert.strictEqual(status(b).status, 'stopping'); assert.match(status(b).blocked_reason, /have not stopped/);
      process.kill = (pid, sig) => { if (sig === 'SIGKILL') { alive = []; return true; } return realKill(pid, sig); };
      await registry.cleanupStaleRuntimes({ rtDir, snapshot: async () => alive });
      assert.strictEqual(status(b).status, 'cleaned', 'the next startup retries');

      // killProcessTree: a child whose kill fails stays in remaining
      process.kill = (pid, sig) => { if (sig === 'SIGKILL' && pid === victim.pid) throw new Error('denied'); return realKill(pid, sig); };
      const r2 = spawnIdle(); await new Promise((resolve) => setTimeout(resolve, 100));
      const rows = [{ ...row(r2.pid, 100), parent: 1 }, { ...row(victim.pid, 200), parent: r2.pid }];
      const res = await registry.killProcessTree(r2.pid, async () => rows);
      assert.strictEqual(res.ok, false); assert.deepStrictEqual(res.remaining, [victim.pid]);

      // a stopping record from an earlier Studio that got this Studio's PID is still recovered
      process.kill = realKill; alive = [row(victim.pid, 200)];
      process.kill = (pid, sig) => { if (sig === 'SIGKILL') { alive = []; return true; } return realKill(pid, sig); };
      const c = add([row(victim.pid, 200)], { studio_pid: process.pid, started_at: '2000-01-01T00:00:00.000Z' });
      const d = add([row(victim.pid, 200)], { studio_pid: process.pid }); // this Studio's own in-flight stop
      await registry.cleanupStaleRuntimes({ rtDir, snapshot: async () => alive });
      assert.strictEqual(status(c).status, 'cleaned'); assert.strictEqual(status(d).status, 'stopping');
    } finally { process.kill = realKill; victim.kill(); }
    console.log('recovery: per-kill revalidation, failed kill retryable, reused Studio PID: PASS');
  }

  // =========================================================================
  // Case K: Listener alone is not ready; application startup failure is surfaced.
  // =========================================================================
  {
    const runtime = { root_pid: 42, port: 3018 };
    const healthy = await readiness.checkBackendReadiness(runtime, {
      verifyOwnership: async () => ({ ok: true }),
      isPidAlive: () => true,
      portReachable: async () => true,
      getHealth: async () => ({ httpStatus: 200, body: { ready: true } })
    });
    assert.strictEqual(healthy.status, 'BACKEND_READY');
    assert.strictEqual(healthy.process_alive && healthy.port_reachable && healthy.application_ready, true);

    const startupFailure = await readiness.checkBackendReadiness(runtime, {
      verifyOwnership: async () => ({ ok: true }),
      isPidAlive: () => true,
      portReachable: async () => true,
      getHealth: async () => ({ httpStatus: 503, body: { ready: false, error: 'MiningProcessLockError: data directory is locked' } })
    });
    assert.strictEqual(startupFailure.status, 'BLOCKED', 'a listener that failed FastAPI startup is not ready');
    assert.match(startupFailure.reason, /MiningProcessLockError/);

    const deadProcess = await readiness.checkBackendReadiness(runtime, {
      verifyOwnership: async () => ({ ok: true }),
      isPidAlive: () => false,
      portReachable: async () => true,
      getHealth: async () => ({ httpStatus: 200, body: { ready: true } })
    });
    assert.strictEqual(deadProcess.status, 'BLOCKED', 'health alone does not replace process identity');
    assert.strictEqual(readiness.isApplicationReady({ status: 'ok' }), true, 'existing TWstock /health contract');
    assert.strictEqual(readiness.isApplicationReady({ status: 'ok', ready: false }), false);
    assert.strictEqual(readiness.isApplicationReady({ ready: true, error: 'MiningProcessLockError' }), false);
    const falseReady = await readiness.checkBackendReadiness(runtime, {
      isPidAlive: () => true, portReachable: async () => true,
      verifyOwnership: async () => ({ ok: false, reason: 'Unknown PID 42: external listener' }),
      getHealth: async () => ({ httpStatus: 200, body: { status: 'ok' } })
    });
    assert.strictEqual(falseReady.status, 'BLOCKED', 'unrelated listener cannot satisfy readiness');
    assert.match(falseReady.reason, /Unknown PID/);
    console.log('Case K: process + port + HTTP 200 + application ready; startup failure reason: PASS');
  }

  // Actual HTTP listener with failed startup must stay blocked until app reports ready.
  {
    const rtDir = mkTmp('studio-http-ready-');
    const script = `let ready = false; const server = require('http').createServer((req,res) => {
      if (req.url === '/make-ready') ready = true;
      res.setHeader('content-type', 'application/json'); res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify(ready ? {status:'ok'} : {ready:false,error:'MiningProcessLockError: startup failed'}));
    }); server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));`;
    const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    SPAWNED_PROCS.push(proc);
    const port = Number((await waitOutput(proc, /PORT:(\d+)/))[1]);
    const runtime = registry.registerRuntime({ job_id: 'http-ready', root_pid: proc.pid,
      process_identity: await registry.getProcessInfo(proc.pid), executable: process.execPath,
      command: 'HTTP startup fixture', port, data_dir: rtDir, rtDir });
    const failed = await readiness.checkBackendReadiness({ ...runtime, rtDir });
    assert.strictEqual(failed.process_alive, true);
    assert.strictEqual(failed.port_reachable, true);
    assert.strictEqual(failed.ownership_verified, true);
    assert.strictEqual(failed.status, 'BLOCKED');
    assert.match(failed.reason, /MiningProcessLockError/);
    await fetch('http://127.0.0.1:' + port + '/make-ready');
    const ready = await readiness.checkBackendReadiness({ ...runtime, rtDir });
    assert.strictEqual(ready.status, 'BACKEND_READY');
    const otherOwner = await registry.checkPortOwnership(port, { desiredJobId: 'http-ready', desiredDataDir: rtDir + '-other', rtDir });
    assert.strictEqual(otherOwner.available, false, 'same job does not imply same data owner');
    safeKill(proc);
    console.log('Case K real HTTP: listener + MiningProcessLockError blocked, existing status ok accepted: PASS');
  }

  // Safe automatic recovery is ordered cleanup -> restart -> readiness -> smoke -> continue.
  {
    const events = [];
    const runtime = { created_by: 'studio', restart_safe: true, root_pid: 42, workspace: 'C:/repo', data_dir: 'C:/repo/data', executable: 'python.exe', args: ['-m', 'uvicorn'], cwd: 'C:/repo', job_id: 'job-1', card_id: 'card-1' };
    const result = await readiness.recoverOwnedRuntime(runtime, {
      workspace: runtime.workspace, dataDir: runtime.data_dir,
      cleanup: async () => events.push('cleanup'),
      restart: async () => { events.push('restart'); return { ...runtime, root_pid: 43 }; },
      readiness: async () => { events.push('health'); return { status: 'BACKEND_READY' }; },
      smoke: async () => { events.push('smoke'); return { ok: true }; },
      continueJob: async () => events.push('continue')
    });
    assert.strictEqual(result.status, 'recovered');
    assert.deepStrictEqual(events, ['cleanup', 'restart', 'health', 'smoke', 'continue']);

    let restarted = false;
    const unknown = await readiness.recoverOwnedRuntime({ ...runtime, created_by: 'unknown' }, {
      workspace: runtime.workspace, dataDir: runtime.data_dir,
      cleanup: async () => {}, restart: async () => { restarted = true; }, readiness: async () => ({}),
      smoke: async () => ({ ok: true }), continueJob: async () => {}
    });
    assert.strictEqual(unknown.status, 'blocked');
    assert.strictEqual(restarted, false, 'unknown runtime owner must stop before cleanup or restart');
    const needsCredentials = await readiness.recoverOwnedRuntime({ ...runtime, restart_safe: false }, {
      workspace: runtime.workspace, dataDir: runtime.data_dir,
      cleanup: async () => { throw new Error('must not clean'); }, restart: async () => { restarted = true; },
      readiness: async () => ({}), smoke: async () => ({ ok: true }), continueJob: async () => {}
    });
    assert.strictEqual(needsCredentials.status, 'blocked');
    assert.match(needsCredentials.reason, /credentials/);
    const failedHealthEvents = [];
    const failedHealth = await readiness.recoverOwnedRuntime(runtime, {
      workspace: runtime.workspace, dataDir: runtime.data_dir,
      cleanup: async () => failedHealthEvents.push('cleanup'),
      restart: async () => { failedHealthEvents.push('restart'); return runtime; },
      readiness: async () => { failedHealthEvents.push('health'); return { status: 'BLOCKED', reason: 'MiningProcessLockError' }; },
      smoke: async () => { failedHealthEvents.push('smoke'); return { ok: true }; },
      continueJob: async () => failedHealthEvents.push('continue')
    });
    assert.strictEqual(failedHealth.status, 'blocked');
    assert.deepStrictEqual(failedHealthEvents, ['cleanup', 'restart', 'health'], 'failed readiness must not run smoke or continue the card');
    for (const phase of ['cleanup', 'restart', 'health', 'smoke']) {
      let active = true;
      const stoppedEvents = [];
      const stopped = await readiness.recoverOwnedRuntime(runtime, {
        workspace: runtime.workspace, dataDir: runtime.data_dir, canProceed: () => active,
        cleanup: async () => { stoppedEvents.push('cleanup'); if (phase === 'cleanup') active = false; return { ok: true }; },
        restart: async () => { stoppedEvents.push('restart'); if (phase === 'restart') active = false; return runtime; },
        readiness: async () => { stoppedEvents.push('health'); if (phase === 'health') active = false; return { status: 'BACKEND_READY' }; },
        smoke: async () => { stoppedEvents.push('smoke'); if (phase === 'smoke') active = false; return { ok: true }; },
        continueJob: async () => stoppedEvents.push('continue')
      });
      assert.strictEqual(stopped.status, 'cancelled');
      assert.ok(!stoppedEvents.includes('continue'), 'STOP/PAUSE/handoff during ' + phase + ' must fence continuation');
      if (phase === 'cleanup') assert.ok(!stoppedEvents.includes('restart'), 'STOP during cleanup must prevent restart');
    }
    const unconfirmed = await readiness.recoverOwnedRuntime(runtime, {
      cleanup: async () => ({ ok: false, reason: 'process tree still alive' }),
      restart: async () => { throw new Error('must not restart'); }, readiness: async () => ({}),
      smoke: async () => ({ ok: true }), continueJob: async () => {}
    });
    assert.strictEqual(unconfirmed.status, 'blocked');
    assert.strictEqual(failedHealth.manual, false, 'known owner startup failure stays automatically monitored');
    console.log('Runtime recovery: known Studio owner auto-continues in order; unknown owner blocks: PASS');
  }

  await require('./test-runtime-server.cjs')();
  await require('./test-ui-ownership.cjs')();
  } finally {
  // Teardown temp resources
  for (const p of SPAWNED_PROCS) safeKill(p);
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {}
  }

  }
  console.log('--- All Workstream B+C Runtime & Isolation Tests: PASS ---');
}

if (require.main === module) {
  runRuntimeTests().catch((e) => {
    console.error('RUNTIME TESTS FAILED:', e);
    process.exit(1);
  });
}

module.exports = { runRuntimeTests };
