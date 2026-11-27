const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { region, makeEnv, newW, TMP_DIRS } = require('./lifecycle-harness.cjs');

test('disabling the built-in Claude CLI blocks new and restored work before provider I/O', async () => {
  const code = region('const AGENTS =', '// ---------- External LLM providers')
    + region('async function createAgentConv(', '// AionCore pushes')
    + region('async function turn(agent', '// ---------- External provider operations')
    + region('const CONTINUE_RE =', 'function leaderStep(w, work)')
    + region('async function runRoutine(w, r, now)', '// ---------- Plan limits')
    + region('async function resumeJob(', 'async function reassign(');
  const events = [];
  const ctx = { process: { env: {} }, busyConvs: () => [], drainExecution() { throw Error('resume reached drain'); },
    launching: (_w, fn) => fn(), endLeftSetups() {}, settingUp: () => false, stillStopping: () => false, isDir: () => true,
    event: kind => events.push(kind), label: () => 'project', notify() {}, saveSettings() {}, api: () => assert.fail('unexpected provider request') };
  const catalog = () => vm.runInNewContext(region('const AGENTS =', '// ---------- External LLM providers') + '\nAGENTS', { ...ctx });
  assert.equal(catalog().claude.create('project', true).extra.backend, 'claude');
  ctx.process.env.STUDIO_DISABLE_BUILTIN_CLAUDE = 'mistyped';
  assert.throws(catalog, /0 或 1/);
  ctx.process.env.STUDIO_DISABLE_BUILTIN_CLAUDE = '1';
  const { AGENTS, createAgentConv, turn, resumeJob, runRoutine } = vm.runInNewContext(code + '\n({ AGENTS, createAgentConv, turn, resumeJob, runRoutine })', ctx);
  assert.equal(AGENTS.codex.create('project', false).extra.backend, 'codex');
  assert.equal(AGENTS.antigravity.create('project', true).extra.backend, 'antigravity');
  const disabled = /已停用內建 Claude Code/;
  for (const lead of [true, false]) await assert.rejects(createAgentConv('claude', 'project', lead), disabled);
  await assert.rejects(turn('claude', 'restored-conversation', 'work'), disabled);
  const scheduled = { leader: 'claude', project: 'project', tasks: [], run: null }, routine = { request: 'scheduled work' };
  await runRoutine(scheduled, routine, new Date());
  assert.match(routine.lastResult, disabled);
  assert.deepEqual(events, ['routine.error']);
  assert.equal(scheduled.run, null);
  const w = { leader: 'claude', run: { paused: true, active: false, project: 'project' }, tasks: [] };
  await assert.rejects(resumeJob(w, {}), /更換工頭/);
  w.leader = 'codex';
  w.tasks.push({ title: 'unfinished', status: 'PAUSED', agent: 'claude' });
  await assert.rejects(resumeJob(w, {}), /先改派「unfinished」/);
  assert.equal(w.run.paused, true);
  assert.equal(w.run.active, false);
  assert.equal(w.tasks[0].status, 'PAUSED');
  w.tasks[0].status = 'DONE';
  await assert.rejects(resumeJob(w, {}), /resume reached drain/);
});

test('a scheduled follow-up dispatch belongs to the tab where the job finished', async t => {
  const fs = require('node:fs');
  const prior = TMP_DIRS.length;
  t.after(() => { for (const dir of TMP_DIRS.splice(prior)) fs.rmSync(dir, { recursive: true, force: true }); });
  for (const change of ['keep', 'close', 'reopen']) {
    let followUp;
    const { env, api } = makeEnv(() => '', { setTimeout: (callback, ms) => {
      assert.equal(ms, 5000); followUp = callback;
    } });
    const w = Object.assign(newW(), { afterDone: 'auto', autoMax: 5, autoRounds: 0 });
    w.run.suggestions = [{ title: 'next', request: 'test the next step' }];
    env.S.workspaces.push(w);
    api.finish(w, 'done');
    await w.run.runtimeCleanup;
    if (change !== 'keep') api.closeWorkspace(w);
    if (change === 'reopen') env.S.workspaces.push({ ...w });
    const notices = env.notices.length;
    followUp();
    const expected = change === 'keep' ? 1 : 0;
    assert.equal(env.started.length, expected, change);
    assert.equal(w.autoRounds, expected, change);
    assert.equal(env.events.filter(x => x.type === 'auto.start').length, expected, change);
    assert.equal(env.notices.length - notices, expected, change);
  }
});

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
