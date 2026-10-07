// Exercise production HTTP recovery hooks together with durable workspace leases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { makeEnv, TMP_DIRS } = require('./lifecycle-harness.cjs');

module.exports = async function () {
  const readiness = await import('./runtime-readiness.mjs');
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
      registerRuntime: (r) => { const replacement = { ...r, runtime_id: 'replacement' }; runtimes.push(replacement); return replacement; },
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
    const E = setup(); await acquire(E); addRuntime(E);
    await E.api.recoverBackendWait(E.w, E.t);
    assert.deepEqual(E.events, ['cleanup:original', 'restart']);
    assert.equal(E.t.status, 'WAITING', 'owned backend wakes original card after readiness and smoke');
    assert.equal(E.runtimes.at(-1).runtime_id, 'replacement');

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
    console.log('Server runtime integration: latest owner, unknown PID, startup failure polling, STOP race, handoff drain, lease admission: PASS');
  } finally {
    for (const w of environments) for (const timer of w.lockTimers?.values() || []) clearInterval(timer);
    for (const root of [...roots, ...TMP_DIRS.splice(baseline)]) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
