// Real history loading, resume and scheduler; provider/filesystem boundaries are stubbed.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Resume orphan');
const { region } = require('./lifecycle-harness.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function setup(status = 'ASK_LEADER', overrides = {}) {
  const dispatched = [];
  const w = { project: 'P', leader: 'claude', tasks: [] };
  const env = {
    S: { workspaces: [w], leases: [] }, convAgent: new Map(), leftSetup: () => { throw Error('unexpected setup'); },
    busyConvs: () => [], endLeftSetups: async () => {},
    workKey: t => t.agent, stopTurn: async () => true, setTimeout, clearTimeout, RT: 'test',
    cleanupJobRuntimes: async () => ({ blocked: [] }),
    holderText: () => 'other owner', cancelTurn: () => {}, markRuntimeStops: () => {}, releaseJobLeases: () => {},
    PARKED: ['ASK_LEADER', 'NEEDS_USER', 'WAITING_EXTERNAL'],
    finish: w => { w.run.active = false; w.run.paused = false; },
    isDir: () => true, available: () => true, agentName: x => x, leaseBlocker: async () => null,
    isWriter: () => false, log: () => {}, saveLeases: () => {}, watchExternal: () => {}, processNotes: () => {},
    writerBusy: () => false, runTask: (w, t) => { dispatched.push(t.id); t.status = 'WORKING'; },
    OPEN: ['WAITING', 'ASK_LEADER', 'NEEDS_USER'], summarize: () => {},
  };
  Object.assign(env, overrides);
  const code = region('async function cleanupCardRuntimes(', 'async function pauseAndDrain(')
    + region('function stop(w)', 'function pause(w)')
    + region('function pump(w)', '// ---------- Workspace lease:')
    + region('const resumable =', 'async function reassign(w,')
    + 'return { loadRun, resume, stop };';
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  const record = { id: 'r', status: 'running', project: 'P', leader: 'claude', leadTier: 'hard', phase: 'working', tasks: [
    { id: 't', agent: 'codex', status, title: 'build', leaderAsks: 2,
      wait: { leader: true, what: 'Which database?' }, wakeNote: 'Keep existing changes', ask: { question: 'User decision' } },
  ], activity: [], convs: {} };
  api.loadRun(w, record);
  return { api, w, dispatched };
}
(async () => {
  const x = setup();
  await x.api.resume(x.w);
  assert.deepEqual(x.dispatched, ['t'], 'orphan leader question must not leave an active job idle');
  assert.equal(x.w.tasks[0].wait, null);
  assert.match(x.w.tasks[0].wakeNote, /Which database/);
  assert.match(x.w.tasks[0].wakeNote, /Keep existing changes/);
  assert.equal(x.w.tasks[0].leaderAsks, 1, 'an interrupted question must not consume the retry allowance');
  assert.equal(x.w.tasks[0].resumed, true);
  // A real user decision and external waits are not permission to continue automatically.
  for (const status of ['NEEDS_USER', 'WAITING_EXTERNAL']) {
    const x = setup(status); await x.api.resume(x.w);
    assert.deepEqual(x.dispatched, []); assert.equal(x.w.tasks[0].status, status);
  }
  const blocked = setup(); blocked.w.leaderSteps = new Set([Promise.resolve()]);
  await assert.rejects(blocked.api.resume(blocked.w), /停下中/);
  assert.equal(blocked.w.tasks[0].status, 'ASK_LEADER');
  assert.deepEqual(blocked.dispatched, []);
  // Real drainExecution rejects an orphan conversation that cannot be stopped.
  const undrained = setup('ASK_LEADER', { stopTurn: async () => false });
  undrained.w.run.convs.codex = 'old-conversation';
  const beforeDrain = structuredClone(undrained.w.tasks[0]);
  await assert.rejects(undrained.api.resume(undrained.w), /保留寫入租約/);
  assert.deepEqual(undrained.w.tasks[0], beforeDrain);
  assert.deepEqual(undrained.dispatched, []);
  // A foreign lease must reject before changing the question or retry count.
  const leased = setup('ASK_LEADER', { leaseBlocker: async () => ({ owner: { kind: 'external' } }) });
  const beforeLease = structuredClone(leased.w.tasks[0]);
  await assert.rejects(leased.api.resume(leased.w), /外部 Agent 接手/);
  assert.deepEqual(leased.w.tasks[0], { ...beforeLease, runtimeStopPending: false, stopUnconfirmed: false });
  assert.deepEqual(leased.dispatched, []);
  // STOP while actual drain waits for runtime cleanup wins over pending Resume.
  const entered = deferred(), release = deferred();
  const stopped = setup('ASK_LEADER', { cleanupJobRuntimes: async () => { entered.resolve(); await release.promise; return { blocked: [] }; } });
  const pending = stopped.api.resume(stopped.w);
  const rejected = assert.rejects(pending, /已被停止/);
  await entered.promise;
  assert.equal(stopped.w.tasks[0].status, 'ASK_LEADER');
  assert.equal(stopped.w.tasks[0].leaderAsks, 2);
  stopped.api.stop(stopped.w);
  release.resolve(); await rejected;
  assert.equal(stopped.w.tasks[0].status, 'FAILED');
  assert.equal(stopped.w.tasks[0].leaderAsks, 2);
  assert.equal(stopped.w.run.active, false);
  assert.deepEqual(stopped.dispatched, []);
  finished();
  console.log('resume orphan leader question regressions PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
