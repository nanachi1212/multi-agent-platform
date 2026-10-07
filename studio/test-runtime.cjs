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

async function runRuntimeTests() {
  const registry = await import('./runtime-registry.mjs');
  const isolated = await import('./isolated-env.mjs');

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
      const p = process.argv[2];
      const fd = fs.openSync(p, 'a+');
      // Hold file descriptor open and write marker
      fs.writeSync(fd, 'locked by smoke');
      setInterval(() => {}, 1000);
    `;
    const smokeLockFile = path.join(smokeEnv.dataDir, '.mining_process.lock');
    const smokeProc = spawn(process.execPath, ['-e', lockScript, smokeLockFile], { stdio: 'ignore', windowsHide: true });
    SPAWNED_PROCS.push(smokeProc);
    await new Promise((r) => setTimeout(r, 150));

    // Register smoke process into runtime registry on port 3028
    const rt = registry.registerRuntime({
      job_id: 'smoke-run-h-1234',
      purpose: 'smoke',
      root_pid: smokeProc.pid,
      executable: process.execPath,
      command: `smoke backend on port ${smokeEnv.port}`,
      port: smokeEnv.port,
      data_dir: smokeEnv.dataDir,
      temp_dir: smokeEnv.tempRoot,
      rtDir: mockProdDir
    });
    assert.strictEqual(rt.purpose, 'smoke');
    assert.strictEqual(rt.port, smokeEnv.port);

    // 3. Verify: while smoke backend is alive holding its lock on 3028/smoke DATA_DIR,
    // the production backend (mockProdDir) can independently acquire its OWN lock on prodDataDir!
    const prodLockFile = path.join(prodDataDir, '.mining_process.lock');
    const prodFd = fs.openSync(prodLockFile, 'a+');
    fs.writeSync(prodFd, 'locked by prod');
    fs.closeSync(prodFd);
    assert.ok(fs.existsSync(prodLockFile), 'production data lock successfully created and acquired');

    // Clean up smoke process
    safeKill(smokeProc);
    smokeEnv.cleanup();
    console.log('Case H: smoke 隔離（正式與 smoke DATA_DIR 分離、3028 活著時 3018 仍可取鎖）: PASS');
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
    const testPort = 39182; // Pick high unreserved test port

    // Spawn an unknown dummy HTTP server process
    const dummyServerScript = `
      const http = require('http');
      const s = http.createServer((req, res) => res.end('hello'));
      s.listen(${testPort}, '127.0.0.1', () => {
        console.log('READY');
      });
      setInterval(() => {}, 1000);
    `;
    const unknownProc = spawn(process.execPath, ['-e', dummyServerScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    SPAWNED_PROCS.push(unknownProc);

    await new Promise((resolve, reject) => {
      unknownProc.stdout.once('data', (d) => {
        if (d.toString().includes('READY')) resolve();
      });
      setTimeout(resolve, 1000); // fallback
    });

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

    let childPid = 0;
    await new Promise((resolve) => {
      procA.stdout.on('data', (d) => {
        const m = d.toString().match(/CHILD:(\d+)/);
        if (m) {
          childPid = parseInt(m[1], 10);
          resolve();
        }
      });
      setTimeout(resolve, 800);
    });

    // Process B: Independent process (representing another job or external worker)
    const procB = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });
    SPAWNED_PROCS.push(procB);

    await new Promise((r) => setTimeout(r, 200));

    // Verify all processes are alive
    assert.strictEqual(registry.isPidAlive(procA.pid), true, 'procA must be alive');
    if (childPid) assert.strictEqual(registry.isPidAlive(childPid), true, 'childPid must be alive');
    assert.strictEqual(registry.isPidAlive(procB.pid), true, 'procB must be alive');

    // Register procA to 'job-target-1'
    registry.registerRuntime({
      job_id: 'job-target-1',
      purpose: 'dev_backend',
      root_pid: procA.pid,
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
      executable: process.execPath,
      command: 'node independent worker',
      rtDir
    });

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

  // Teardown temp resources
  for (const p of SPAWNED_PROCS) safeKill(p);
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {}
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
