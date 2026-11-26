// Exercise production HTTP recovery hooks together with durable workspace leases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { makeEnv, TMP_DIRS } = require('./lifecycle-harness.cjs');

module.exports = async function () {
  const readiness = await import('./runtime-readiness.mjs');
  const isolated = await import('./isolated-env.mjs');
  const registry = await import('./runtime-registry.mjs');
  const roots = [], environments = [], baseline = TMP_DIRS.length;
  function setup(overrides = {}) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-server-runtime-'));
    const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-server-registry-'));
    roots.push(project, rtDir);
    const dataDir = path.join(project, 'data'); fs.mkdirSync(dataDir);
    const runtimes = [], events = [];
    let E, nextPid = 71000;
    E = makeEnv(() => 'STATUS: DONE', {
      RT: rtDir,
      createSmokeEnvironment: isolated.createSmokeEnvironment,
      cleanupIsolatedDir: isolated.cleanupIsolatedDir,
      isSafeTempDir: registry.isSafeTempDir,
      wsOf: () => E.w,
      listRuntimes: () => runtimes,
      checkPortOwnership: async () => ({ status: 'free', available: true }),
      verifyRuntimeProcess: async () => ({ ok: true }),
      checkBackendReadiness: async (r) => ({ status: r.runtime_id === 'replacement' ? 'BACKEND_READY' : 'BLOCKED', reason: 'MiningProcessLockError' }),
      recoverOwnedRuntime: readiness.recoverOwnedRuntime,
      cleanupRuntime: async (r) => { events.push('cleanup:' + r.runtime_id); r.status = 'cleaned'; return { ok: true }; },
      cleanupJobRuntimes: async (jobId, { cardIds } = {}) => {
        events.push('drain');
        for (const r of runtimes) if (r.job_id === jobId && (!cardIds || cardIds.includes(r.card_id))) r.status = 'cleaned';
        return { cleaned: runtimes.length, blocked: [] };
      },
      spawn: () => { events.push('restart'); const p = new EventEmitter(); p.pid = nextPid++; queueMicrotask(() => p.emit('spawn')); return p; },
      getProcessInfo: async () => ({ creationDate: 'fixture', executable: process.execPath }),
      registerRuntime: (r) => { const replacement = { ...r, created_by: 'studio', runtime_id: 'replacement' }; runtimes.push(replacement); return replacement; },
      updateRuntime: (id, updates) => Object.assign(runtimes.find(r => r.runtime_id === id), updates),
      isPidAlive: () => true,
      killProcessTree: async () => ({ ok: true }),
      fetch: async () => ({ status: 200 }),
      ...overrides
    });
    const w = { project, tasks: [], workers: ['codex', 'claude'], activity: [], leader: 'claude',
      run: { id: 'integration-' + path.basename(project), convs: {}, phase: 'planning', active: true, paused: false, stopped: false } };
    const t = { id: 'card', agent: 'codex', writes: true, title: 'recover backend', status: 'WAITING_EXTERNAL', after: [],
      wait: { backendPort: 3018, manual: false } };
    w.tasks.push(t); E.w = w; E.env.S.workspaces.push(w);
    E.api.loadLeases(); environments.push(w);
    return { ...E, t, dataDir, runtimes, events };
  }
  async function acquire(E) { return E.api.acquireWrite(E.w, E.t, await E.api.workspaceOf(E.w.project)); }
  function addRuntime(E, id = 'original') {
    const r = { runtime_id: id, created_by: 'studio', restart_safe: true, status: 'running', root_pid: 70001,
      workspace: fs.realpathSync.native(E.w.project), data_dir: E.dataDir, env: { DATA_DIR: E.dataDir },
      executable: process.execPath, command: 'fixture backend', args: ['backend.js'], cwd: E.w.project,
      job_id: E.w.run.id, card_id: E.t.id, port: 3018 };
    E.runtimes.push(r); return r;
  }
  try {
    const E = setup(); await acquire(E);
    addRuntime(E).shell_job = 'previous-shell-job';
    await E.api.recoverBackendWait(E.w, E.t);
    assert.deepEqual(E.events, ['cleanup:original', 'restart']);
    assert.equal(E.t.status, 'WAITING', 'owned backend wakes original card after readiness and smoke');
    assert.equal(E.runtimes.at(-1).runtime_id, 'replacement');
    assert.equal(E.runtimes.at(-1).shell_job, null, 'a regular replacement must never inherit the old Windows Job');

    // A stale earlier record must never win over the current healthy replacement.
    E.t.status = 'WAITING_EXTERNAL'; E.t.wait = { backendPort: 3018, manual: false };
    const before = E.events.length;
    await E.api.recoverBackendWait(E.w, E.t);
    assert.equal(E.events.length, before, 'healthy latest replacement does not restart');
    assert.equal(E.t.status, 'WAITING');

    const unknown = setup({ checkPortOwnership: async () => ({ owner: 'unknown', pid: 88001,
      command: 'external backend', reason: 'unknown PID 88001 command external backend DATA_DIR owner unknown' }) });
    await acquire(unknown);
    await unknown.api.recoverBackendWait(unknown.w, unknown.t);
    assert.equal(unknown.t.wait.manual, true);
    assert.match(unknown.t.wait.recoveryReason, /88001.*external backend/);
    assert.ok(!unknown.events.includes('restart'));

    const failed = setup({ checkBackendReadiness: async () => ({ status: 'BLOCKED', reason: 'MiningProcessLockError' }) });
    await acquire(failed); addRuntime(failed);
    await failed.api.recoverBackendWait(failed.w, failed.t);
    assert.equal(failed.t.wait.manual, false, 'known startup failure remains automatically monitored');
    assert.match(failed.t.wait.recoveryReason, /MiningProcessLockError/);
    const count = failed.events.length;
    await failed.api.recoverBackendWait(failed.w, failed.t);
    assert.equal(failed.events.length, count, 'pending replacement is polled without repeated restarts');

    // STOP while cleanup awaits: retain lease, then fence restart and release only after drain.
    let releaseCleanup, cleanupStarted;
    const started = new Promise(resolve => { cleanupStarted = resolve; });
    const gate = new Promise(resolve => { releaseCleanup = resolve; });
    const stopped = setup({ cleanupRuntime: async () => { cleanupStarted(); await gate; return { ok: true }; } });
    await acquire(stopped); addRuntime(stopped);
    const recovery = stopped.api.recoverBackendWait(stopped.w, stopped.t);
    await started;
    const stop = stopped.api.stopAndDrain(stopped.w);
    assert.ok(stopped.api.writerOf(stopped.api.treeKey(stopped.w.project)), 'lease retained during runtime drain');
    releaseCleanup(); await recovery; await stop;
    assert.ok(!stopped.events.includes('restart'), 'STOP during cleanup never restarts runtime');
    assert.equal(stopped.w.run.stopped, true);
    assert.equal(stopped.api.writerOf(stopped.api.treeKey(stopped.w.project)), null);

    const handoff = setup({ cleanupJobRuntimes: async () => ({ cleaned: 0,
      blocked: [{ runtime_id: 'original', pid: 70001, reason: 'process tree still alive' }] }) });
    await acquire(handoff); addRuntime(handoff);
    await assert.rejects(handoff.api.handoffWriter(handoff.w, 'claude', handoff.t.id), /Runtime/);
    assert.equal(handoff.t.agent, 'codex');
    assert.ok(handoff.api.writerOf(handoff.api.treeKey(handoff.w.project)), 'failed OS cleanup retains original writer');
    const moved = setup(); await acquire(moved); addRuntime(moved);
    await moved.api.handoffWriter(moved.w, 'claude', moved.t.id);
    assert.equal(moved.t.agent, 'claude');
    assert.ok(moved.events.includes('drain'), 'OS runtimes drained before acquiring replacement lease');
    assert.equal(moved.runtimes[0].status, 'cleaned');

    // Aion idle alone cannot authorize a lease transfer or terminal release.
    const codexBlocked = setup({ stopTurn: async () => false });
    await acquire(codexBlocked); codexBlocked.w.run.convs = { 'codex:work': 'codex-session' };
    await assert.rejects(codexBlocked.api.handoffWriter(codexBlocked.w, 'claude', codexBlocked.t.id), /保留寫入租約/);
    assert.equal(codexBlocked.t.agent, 'codex');
    codexBlocked.t.status = 'DONE';
    await codexBlocked.api.endWriteStep(codexBlocked.w, codexBlocked.t);
    assert.equal(codexBlocked.t.stopUnconfirmed, true);
    assert.equal(codexBlocked.api.writerOf(codexBlocked.api.treeKey(codexBlocked.w.project))?.status, 'RESERVED');

    let acknowledgeStop;
    const codexGate = new Promise(resolve => { acknowledgeStop = resolve; });
    const codexMoving = setup({ stopTurn: () => codexGate });
    await acquire(codexMoving); codexMoving.w.run.convs = { 'codex:work': 'codex-session' };
    const transfer = codexMoving.api.handoffWriter(codexMoving.w, 'claude', codexMoving.t.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(codexMoving.t.agent, 'codex', 'writer stays assigned while tool exit verification is pending');
    assert.ok(codexMoving.api.writerOf(codexMoving.api.treeKey(codexMoving.w.project)));
    acknowledgeStop(true); await transfer;
    assert.equal(codexMoving.t.agent, 'claude', 'handoff proceeds only after tool exit confirmation');

    // A completed card must stop only its own backend before its workspace lease is released.
    let releaseCardCleanup, cardCleanupStarted;
    const cardCleanupGate = new Promise(resolve => { releaseCardCleanup = resolve; });
    const cardCleanupSignal = new Promise(resolve => { cardCleanupStarted = resolve; });
    const cardDone = setup({ cleanupJobRuntimes: async (jobId, { cardIds }) => {
      assert.deepEqual(cardIds, ['card']);
      assert.equal(jobId, cardDone.w.run.id);
      cardCleanupStarted(); await cardCleanupGate;
      return { cleaned: 1, blocked: [] };
    } });
    await acquire(cardDone); addRuntime(cardDone); cardDone.t.status = 'DONE';
    const ending = cardDone.api.endWriteStep(cardDone.w, cardDone.t, 'codex');
    await cardCleanupSignal;
    assert.ok(cardDone.api.writerOf(cardDone.api.treeKey(cardDone.w.project)), 'the card lease remains held while its runtime is stopping');
    releaseCardCleanup(); await ending;
    assert.equal(cardDone.api.writerOf(cardDone.api.treeKey(cardDone.w.project)), null, 'lease is released only after runtime cleanup succeeds');
    assert.equal(cardDone.t.runtimeStopPending, false);

    const blockedCardDone = setup({ cleanupJobRuntimes: async () => ({ cleaned: 0,
      blocked: [{ runtime_id: 'original', pid: 70001, reason: 'process tree still alive' }] }) });
    await acquire(blockedCardDone); addRuntime(blockedCardDone); blockedCardDone.t.status = 'DONE';
    await blockedCardDone.api.endWriteStep(blockedCardDone.w, blockedCardDone.t, 'codex');
    assert.equal(blockedCardDone.t.runtimeStopPending, true);
    assert.equal(blockedCardDone.api.writerOf(blockedCardDone.api.treeKey(blockedCardDone.w.project))?.status, 'RESERVED',
      'failed card-runtime cleanup retains workspace ownership');

    const cleanedJobs = []; let finishStart;
    const finished = setup({ cleanupJobRuntimes: async (id) => { cleanedJobs.push(id); return { cleaned: 1, blocked: [] }; } });
    await acquire(finished); addRuntime(finished);
    const originalRun = finished.w.run, originalJob = originalRun.id;
    finished.w.runtimeStarts = new Map([[finished.t.id, new Promise(resolve => { finishStart = resolve; })]]);
    finished.api.finish(finished.w, 'done');
    assert.ok(finished.t.runtimeStopPending, 'finishing retains pending runtime ownership');
    // Even if another caller changes workspace state, deferred cleanup keeps the original job scope.
    finished.w.run = { id: 'different-job' }; finished.w.tasks = [];
    finishStart(); await originalRun.runtimeCleanup;
    assert.deepEqual(cleanedJobs, [originalJob], 'deferred cleanup never targets a replacement job');

    const noLease = setup(); noLease.t.status = 'WORKING';
    await assert.rejects(noLease.api.startManagedRuntime({ ws: noLease.w.project, cardId: noLease.t.id }), /lease/);
    assert.ok(!noLease.events.includes('restart'));

    // The production entry point must allocate isolation, not just label a shared DATA_DIR as smoke.
    for (const purpose of ['smoke', 'test']) {
      let launched;
      const smoke = setup({
        spawn: (exe, args, options) => {
          launched = options;
          assert.ok(fs.existsSync(options.env.DATA_DIR), 'recovery recreates the allocated data directory before spawn');
          const child = new EventEmitter(); child.pid = 71001;
          queueMicrotask(() => child.emit('spawn')); return child;
        },
        cleanupRuntime: async (r) => { isolated.cleanupIsolatedDir(r.temp_dir); r.status = 'cleaned'; return { ok: true }; }
      });
      await acquire(smoke); smoke.t.status = 'WORKING';
      fs.writeFileSync(path.join(smoke.dataDir, 'sentinel'), 'preserve');
      const { runtime } = await smoke.api.startManagedRuntime({ ws: smoke.w.project, cardId: smoke.t.id,
        purpose, executable: process.execPath, args: [], cwd: smoke.w.project, dataDir: smoke.dataDir,
        port: 3018, noCredentialsConfirmed: true });
      assert.ok(registry.isSafeTempDir(runtime.temp_dir));
      roots.push(runtime.temp_dir);
      assert.notEqual(runtime.data_dir, smoke.dataDir);
      assert.equal(runtime.data_dir, path.join(runtime.temp_dir, 'data'));
      assert.equal(launched.env.DATA_DIR, runtime.data_dir);
      assert.equal(launched.env.STUDIO_ISOLATED, '1');
      assert.equal(launched.env.PORT, String(runtime.port));
      assert.ok(![3018, 3011].includes(runtime.port));
      assert.equal(fs.readFileSync(path.join(smoke.dataDir, 'sentinel'), 'utf8'), 'preserve');

      // Healthy isolated backends must remain eligible to wake their original card.
      smoke.t.status = 'WAITING_EXTERNAL'; smoke.t.wait = { backendPort: runtime.port, manual: false };
      await smoke.api.recoverBackendWait(smoke.w, smoke.t);
      assert.equal(smoke.t.status, 'WAITING', 'healthy isolated runtime can wake its card');

      runtime.runtime_id = 'original';
      smoke.t.status = 'WAITING_EXTERNAL'; smoke.t.wait = { backendPort: runtime.port, manual: false };
      await smoke.api.recoverBackendWait(smoke.w, smoke.t);
      assert.equal(smoke.t.status, 'WAITING', 'stale smoke runtime is cleaned and safely recreated: ' + smoke.t.wait?.recoveryReason);
      assert.equal(runtime.status, 'cleaned');
      assert.equal(smoke.runtimes.at(-1).data_dir, runtime.data_dir);
      assert.ok(fs.existsSync(runtime.data_dir));

      smoke.runtimes.at(-1).data_dir = smoke.dataDir;
      smoke.runtimes.at(-1).env.DATA_DIR = smoke.dataDir;
      smoke.t.status = 'WAITING_EXTERNAL'; smoke.t.wait = { backendPort: runtime.port, manual: false };
      await smoke.api.recoverBackendWait(smoke.w, smoke.t);
      assert.equal(smoke.t.wait.manual, true, 'a forged smoke owner cannot recover against project data');
      assert.match(smoke.t.wait.recoveryReason, /DATA_DIR owner/);
    }

    for (const failure of ['spawn', 'ownership']) {
      let allocated;
      const failedSmoke = setup({
        createSmokeEnvironment: async (options) => {
          allocated = await isolated.createSmokeEnvironment(options); roots.push(allocated.tempRoot);
          if (failure === 'ownership') failedSmoke.w.run.paused = true;
          return allocated;
        },
        spawn: () => { throw new Error('fixture spawn failed'); }
      });
      await acquire(failedSmoke); failedSmoke.t.status = 'WORKING';
      await assert.rejects(failedSmoke.api.startManagedRuntime({ ws: failedSmoke.w.project, cardId: failedSmoke.t.id,
        purpose: 'smoke', executable: process.execPath, args: [], port: 3011 }), /spawn failed|ownership changed/);
      assert.ok(allocated && !fs.existsSync(allocated.tempRoot), 'failed start removes only its allocated temp data');
    }
    console.log('Server runtime integration: owner recovery, STOP/handoff drain, lease admission, smoke/test isolation and failed-start cleanup: PASS');
  } finally {
    for (const w of environments) for (const timer of w.lockTimers?.values() || []) clearInterval(timer);
    for (const root of [...roots, ...TMP_DIRS.splice(baseline)]) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
