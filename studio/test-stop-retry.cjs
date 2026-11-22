// Production start/drain/cleanup logic; OS/provider boundaries are scripted, never real agents.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Stop retry');
const crypto = require('node:crypto');
const { src, region } = require('./lifecycle-harness.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function setup(overrides = {}) {
  let canStop = false, blocked = false, calls = 0, planned = 0, released = 0;
  const task = { id: 't', agent: 'codex', status: 'FAILED', stopUnconfirmed: true, runtimeStopPending: true };
  const w = { project: 'P', leader: 'claude', tasks: [task], activity: [], run: {
    id: 'old', stopped: true, paused: false, active: false, convs: { codex: 'old-conv' }, runtimeCleanup: Promise.resolve() } };
  const env = { crypto, setTimeout, clearTimeout, RT: 'fixture',
    endLeftSetups: async () => {}, settingUp: () => false, stopPreparing: async () => {},
    stop: () => {}, busyConvs: () => [], workKey: t => t.agent,
    stopTurn: async () => { calls++; return canStop; },
    cleanupJobRuntimes: async () => ({ blocked: blocked ? [{ reason: 'still alive' }] : [] }),
    releaseJobLeases: () => { released++; }, releaseLock: async () => {}, isWriter: () => true, saveRun: () => {},
    isDir: () => true, available: () => true, workersFor: () => ['codex'], agentName: x => x,
    latestJob: () => null, projectContext: () => '', knownRefs: () => [], event: () => {}, log: () => {},
    planPhase: () => { planned++; },
  };
  const code = src.match(/^const stillStopping = .*$/m)[0] + '\n'
    + region('const CONTINUE_RE =', 'async function planPhase(w)')
    + region('async function cleanupCardRuntimes(', '// ----- external takeover:')
    + region('const launchingWs =', 'async function resume(w,')
    + 'return { start, stopAndDrain, stillStopping };';
  Object.assign(env, overrides);
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  return { w, task, api, setStop: x => canStop = x, setBlocked: x => blocked = x,
    stats: () => ({ calls, planned, released }) };
}
(async () => {
  const x = setup(), old = x.w.run, cards = x.w.tasks;
  // First retry still cannot confirm shutdown. Keep ownership and all old records.
  await assert.rejects(x.api.start(x.w, 'new job'), /保留寫入租約|不能啟動新工作/);
  assert.equal(x.w.run, old); assert.equal(x.w.tasks, cards);
  assert.equal(x.task.stopUnconfirmed, true); assert.equal(x.stats().released, 0);
  // Agent is now idle, but OS runtime cleanup still refuses: no new job either.
  x.setStop(true); x.setBlocked(true);
  await assert.rejects(x.api.start(x.w, 'new job'), /Runtime|不能啟動新工作/);
  assert.equal(x.w.run, old); assert.equal(x.stats().planned, 0); assert.equal(x.stats().released, 0);
  // Once both independent checks confirm exit, retry must not be stuck on stale flags.
  x.setBlocked(false);
  await x.api.start(x.w, 'new job');
  assert.notEqual(x.w.run, old); assert.equal(x.stats().planned, 1);
  assert.equal(x.task.stopUnconfirmed, false); assert.equal(x.task.runtimeStopPending, false);
  assert.equal(x.stats().released, 1);
  // Do not replace records while an existing step/finalizer is still running.
  const y = setup(), gate = deferred(), oldY = y.w.run;
  y.setStop(true); y.w.executingSteps = new Map([['t', { done: gate.promise }]]);
  const pending = y.api.start(y.w, 'new job');
  await new Promise(r => setImmediate(r));
  assert.equal(y.w.run, oldY); assert.equal(y.stats().planned, 0);
  await assert.rejects(y.api.start(y.w, 'duplicate'), /正在開始/);
  y.w.executingSteps.clear(); gate.resolve(); await pending;
  assert.equal(y.stats().planned, 1);
  // Concurrent Stop shares the release/save transition and cannot mutate a new job.
  const locks = deferred(), entered = deferred(), lateCleanup = deferred(), saved = [], releases = [];
  let cleanups = 0;
  const z = setup({ releaseLock: async () => { entered.resolve(); await locks.promise; },
    cleanupJobRuntimes: async () => { if (++cleanups === 2) await lateCleanup.promise; return { blocked: [] }; },
    releaseJobLeases: w => releases.push(w.run.id), saveRun: w => saved.push(w.run.id) });
  z.setStop(true);
  const start = z.api.start(z.w, 'new job'); await entered.promise;
  const stop = z.api.stopAndDrain(z.w);
  await new Promise(r => setImmediate(r));
  locks.resolve(); await start; lateCleanup.resolve(); await stop;
  assert.deepEqual(releases, ['old']); assert.deepEqual(saved, ['old']); assert.equal(cleanups, 1);
  // HTTP wait timeout never removes the still-running cleanup fence. A later
  // retry joins that operation, and admission waits through its final lock release.
  const pendingCleanup = deferred(), began = deferred(), timers = [];
  let retries = 0;
  const timeout = setup({ setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout: () => {},
    cleanupJobRuntimes: async () => { retries++; began.resolve(); await pendingCleanup.promise; return { blocked: [] }; } });
  timeout.setStop(true);
  const waiting = timeout.api.start(timeout.w, 'new job');
  const timedOut = assert.rejects(waiting, /背景清理持續中/);
  await began.promise; timers[0](); await timedOut;
  assert.equal(timeout.w.run.id, 'old'); assert.equal(timeout.api.stillStopping(timeout.w), true);
  const retry = timeout.api.start(timeout.w, 'new job');
  await new Promise(r => setImmediate(r));
  assert.equal(timeout.w.run.id, 'old'); assert.equal(retries, 1);
  pendingCleanup.resolve(); await retry;
  assert.notEqual(timeout.w.run.id, 'old'); assert.equal(timeout.api.stillStopping(timeout.w), false);
  finished();
  console.log('Stopped job cleanup retry PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
