// Real CI-wait code with controlled GitHub responses; no network or providers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { region } = require('./lifecycle-harness.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pr = (checks = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]) => ({
  url: 'https://github.com/owner/project/pull/7', state: 'OPEN', statusCheckRollup: checks,
});
const pending = () => pr([{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }]);
function setup(overrides = {}) {
  const calls = [], wakes = [], handoffs = [], logs = [], notices = [];
  const t = { id: 'card', title: 'ship', agent: 'codex', writes: true, status: 'WAITING_EXTERNAL', wait: { pr: pr().url, manual: false } };
  const w = { project: 'project', tasks: [t], run: { active: true, paused: false, stopped: false, leader: 'claude', lifecycleEpoch: 0 } };
  const env = { checking: new Set(), originRepo: async () => 'owner/project',
    ghJson: async (...args) => { calls.push(args); return pr(); },
    log: (...args) => logs.push(args), notify: (...args) => notices.push(args), label: () => 'project',
    isWriter: card => card.writes, available: () => true, agentName: id => id,
    wake: (...args) => wakes.push(args), handoffWriter: async (...args) => handoffs.push(args), ...overrides };
  const check = vm.runInNewContext(region('async function checkExternal(w, t)', 'function watchExternal()') + '\ncheckExternal;', env);
  return { w, t, env, calls, wakes, handoffs, logs, notices, check: () => check(w, t) };
}

const changes = {
  pause: ({ w }) => { w.run.active = false; w.run.paused = true; w.run.lifecycleEpoch++; },
  'pause then resume': ({ w }) => { w.run.lifecycleEpoch += 2; },
  stop: ({ w }) => { w.run.active = false; w.run.stopped = true; },
  'replace job': ({ w }) => { w.run = { ...w.run }; },
  'replace wait': ({ t }) => { t.wait = { pr: 'https://github.com/owner/project/pull/8', manual: false }; },
  'remove card': ({ w }) => { w.tasks = []; },
  'change owner': ({ t }) => { t.leaseGeneration = 1; },
  'change agent': ({ t }) => { t.agent = 'antigravity'; },
  'hold card': ({ t }) => { t.hold = true; },
};
for (const [name, change] of Object.entries(changes)) for (const result of ['success', 'error']) {
  test(`late ${result} after ${name} cannot change the current wait`, async () => {
    const gate = deferred(), E = setup({ ghJson: () => gate.promise });
    const request = E.check(); change(E);
    const waitBefore = JSON.stringify(E.t.wait);
    if (result === 'success') gate.resolve(pr()); else gate.reject(new Error('offline'));
    await request;
    assert.equal(JSON.stringify(E.t.wait), waitBefore);
    assert.equal(E.wakes.length + E.handoffs.length + E.logs.length + E.notices.length, 0);
  });
}
test('already paused, held or stopped work does not query GitHub', async () => {
  for (const change of [changes.pause, changes.stop, changes['hold card']]) {
    const E = setup(); change(E); await E.check(); assert.equal(E.calls.length, 0);
  }
});
test('cancellation during origin lookup does not issue a PR query', async () => {
  const gate = deferred(), E = setup({ originRepo: () => gate.promise }); E.t.wait.pr = '7';
  const request = E.check(); changes.pause(E); gate.resolve('owner/project'); await request;
  assert.equal(E.calls.length, 0);
});
test('bare PR numbers require the project origin, never the gh default repo', async () => {
  const missing = setup({ originRepo: async () => '' }); missing.t.wait.pr = '7';
  await missing.check(); assert.equal(missing.calls.length, 0); assert.equal(missing.t.wait.errors, 1);
  const valid = setup(); valid.t.wait.pr = '7'; await valid.check();
  assert.deepEqual(Array.from(valid.calls[0][0]).slice(0, 5), ['pr', 'view', '7', '--repo', 'owner/project']);
  assert.equal(valid.wakes.length, 1);
});
test('successful pending checks reset consecutive network failures', async () => {
  let failed = true; const E = setup({ ghJson: async () => { if (failed) throw new Error('offline'); return pending(); } });
  for (let i = 0; i < 3; i++) {
    failed = true; await E.check(); assert.equal(E.t.wait.errors, 1);
    failed = false; await E.check(); assert.equal(E.t.wait.errors, 0); assert.equal(E.t.wait.manual, false);
  }
  failed = true; for (let i = 0; i < 3; i++) await E.check();
  assert.equal(E.t.wait.manual, true); assert.equal(E.notices.length, 1);
});
test('only three consecutive successful empty responses mean no CI checks', async () => {
  let response = pr([]); const E = setup({ ghJson: async () => response });
  await E.check(); await E.check();
  response = pending(); await E.check(); assert.equal(E.t.wait.empty, 0);
  response = pr([]); await E.check(); await E.check(); assert.equal(E.wakes.length, 0);
  await E.check(); assert.equal(E.wakes.length, 1);
});
test('a lookup failure breaks the empty-response streak', async () => {
  let failed = false; const E = setup({ ghJson: async () => { if (failed) throw new Error('offline'); return pr([]); } });
  await E.check(); await E.check(); failed = true; await E.check();
  failed = false; await E.check(); assert.equal(E.wakes.length, 0);
});
test('concurrent checks deduplicate; completed CI wakes the worker once', async () => {
  const gate = deferred(); let queries = 0;
  const E = setup({ ghJson: () => { queries++; return gate.promise; } });
  const first = E.check(); await E.check(); assert.equal(queries, 1);
  gate.resolve(pr()); await first; assert.equal(E.wakes.length, 1); assert.equal(E.env.checking.size, 0);
});
test('finisher failure after cancellation cannot wake or log into the paused job', async () => {
  const E = setup(); E.w.finisher = 'antigravity';
  E.env.handoffWriter = async () => { changes.pause(E); throw new Error('cancelled'); };
  await E.check(); assert.equal(E.wakes.length, 0);
  assert.equal(E.logs.length, 1, 'only the valid handoff start is logged');
});
