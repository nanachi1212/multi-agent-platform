const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { region } = require('./lifecycle-harness.cjs');

test('continuation belongs to the open tab and the run that requested it', async () => {
  for (const change of ['keep', 'close', 'reopen', 'replace', 'stop']) {
    const w = { project: 'A', tasks: [], run: { stopped: false } };
    const S = { workspaces: [w], closedWorkspaces: {} }, gate = Promise.withResolvers(), starts = [];
    const api = vm.runInNewContext(region('async function continueProject(w)', '// ---------- The Leader')
      + region('function closeWorkspace(w)', 'function removeRecent(p)') + '\n({continueProject, closeWorkspace})',
    { S, refreshState: () => gate.promise, start: tab => starts.push(tab), launchingWs: new Set(), preparing: new Map(),
      stillStopping: () => false, treeKey: x => x, workspaceSettings: () => ({}), saveSettings() {} });
    const pending = api.continueProject(w);
    if (change === 'close' || change === 'reopen') api.closeWorkspace(w);
    if (change === 'reopen') S.workspaces.push({ ...w });
    if (change === 'replace') w.run = {};
    if (change === 'stop') w.run.lifecycleEpoch = 1;
    gate.resolve();
    if (change === 'keep') { await pending; assert.deepEqual(starts, [w]); }
    else { await assert.rejects(pending, /已取消/); assert.equal(starts.length, 0); }
  }
});

test('only safe provider URLs reach storage, listing or use of previously saved credentials', async () => {
  const calls = [], saved = { id: 'ext', providerId: 'p', baseUrl: 'http://remote.invalid/v1' };
  const code = region('const extOf =', '// An added agent') + region('async function extModels(b)', '// ---------- Team');
  const api = vm.runInNewContext(code + '\n({validateExternalUrl, saveExternal, extModels, extProvider})', {
    URL, S: { external: [saved] }, EXT_PLATFORMS: ['openai'], api: (...args) => { calls.push(args); return [{ id: 'p', base_url: 'http://remote.invalid/v1' }]; }
  });
  for (const baseUrl of ['https://remote.invalid/v1', 'http://localhost:1234', 'http://127.0.0.1', 'http://[::1]']) api.validateExternalUrl(baseUrl);
  const form = { name: 'demo', model: 'model', baseUrl: saved.baseUrl };
  await assert.rejects(api.saveExternal(form), /HTTPS/);
  await assert.rejects(api.extModels({ ...form, id: saved.id }), /HTTPS/);
  await assert.rejects(api.extProvider(saved.id), /HTTPS/);
  assert.deepEqual(calls, []);
  saved.baseUrl = 'https://remote.invalid/v1';
  await assert.rejects(api.extProvider(saved.id), /HTTPS/);
  assert.deepEqual(Array.from(calls[0]), ['GET', '/api/providers']);
});

test('project status distinguishes incomplete work and inconclusive GitHub results', () => {
  const { ciOf, deriveState } = vm.runInNewContext(region('function ciOf(', '// Reads the folder')
    + region('const CARD_WORD =', '// The handoff text') + '\n({ciOf, deriveState})', { clip: x => x });
  const job = run => ({ run: { ...run, request: 'demo' }, tasks: [] });
  assert.equal(deriveState(job({ active: true, phase: 'planning' }), {}).level, 'wait');
  assert.equal(deriveState(job({ result: 'stopped' }), {}).headline, '上一件工作已停止');
  assert.equal(deriveState(job({ result: 'failed' }), {}).level, 'open');
  assert.equal(deriveState(job({ result: 'done' }), {}).level, 'done');
  for (const prs of [[], [{ n: 7, state: 'OPEN', ci: ciOf([]), unresolved: 0 }]]) {
    assert.equal(deriveState(job({ result:'done' }), { repo:'owner/repo', error:'未讀取完整資料', prs }).level, 'wait');
  }
  assert.equal(deriveState(job({ result:'done' }), { error:'非 Git 專案', prs:[] }).level, 'done');
  for (const [conclusion, state] of [['SUCCESS', 'passed'], ['STARTUP_FAILURE','failed'], ['STALE','unknown'], ['unknown','unknown']]) {
    assert.equal(ciOf([{ name: 'check', __typename: 'CheckRun', status: 'COMPLETED', conclusion }]).state, state);
  }
  for (const [conclusion, unresolved] of [['STALE', 0], ['SUCCESS', null], ['SUCCESS', 0]]) {
    const ci = ciOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion }]);
    const status = deriveState(null, { prs: [{ n: 7, state: 'OPEN', ci, unresolved }] });
    assert.equal(status.level, conclusion === 'SUCCESS' && unresolved === 0 ? 'open' : 'wait');
  }
});

test('review thread count covers every page and rejects incomplete results', async () => {
  const page = (resolved, hasNextPage) => ({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: resolved.map(isResolved => ({ isResolved })), pageInfo: { hasNextPage, endCursor: 'after-first' }
  } } } } });
  for (const second of [page([false], false), { errors: [{ message: 'offline' }] }, page([], true)]) {
    const calls = [], pages = [page(Array(100).fill(true), true), second];
    const count = vm.runInNewContext(region('const UNRESOLVED_Q =', 'function ciOf(') + '\nunresolvedThreads', {
      ghJson: async args => { calls.push(args); return pages.shift(); }
    });
    const result = count('project', 'owner', 'repo', 7);
    if (second.data && !second.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage) assert.equal(await result, 1);
    else await assert.rejects(result);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('cursor=after-first'));
  }
});

test('a GitHub fetch failure with a known origin cannot publish a completed project summary', async () => {
  const run = { request:'demo', result:'done' };
  for (const repo of ['owner/repo', '']) {
    const api = vm.runInNewContext(region('async function readGitState(', '// The handoff text') + '\n({readGitState, deriveState})', {
      git: async () => ({out:'## main\n'}), originRepo: async () => repo, PR_FIELDS: 'fields',
      ghJson: async () => { throw new Error('offline'); }, clip: x => x
    });
    const git = await api.readGitState('project', []);
    assert.ok(git.error);
    assert.equal(api.deriveState({run,tasks:[]},git).level, repo ? 'wait' : 'done');
  }
});
