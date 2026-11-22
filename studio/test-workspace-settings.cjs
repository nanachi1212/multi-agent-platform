// Exercise Studio's authenticated HTTP routes, settings file and process restart without starting model backends.
const assert = require('node:assert/strict');
const finished = require.main === module ? require('./test-finish.cjs')('Workspace settings') : () => {};
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

function stageStudio(root) {
  const dir = path.join(root, 'studio');
  fs.mkdirSync(dir);
  for (const name of fs.readdirSync(__dirname)) {
    if (/\.[cm]js$/.test(name) && !name.startsWith('test-')) fs.copyFileSync(path.join(__dirname, name), path.join(dir, name));
  }
  const file = path.join(dir, 'server.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const boot = source.indexOf('\nawait startAion();');
  assert.ok(boot > 0, 'found backend startup after settings, routes and history are loaded');
  fs.writeFileSync(file, source.slice(0, boot) + `
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, token: API_TOKEN }));
process.on('disconnect', () => server.close());
`);
  return file;
}

async function start(file, runtime) {
  const child = fork(file, [], { cwd: path.dirname(runtime), stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, STUDIO_RUNTIME: runtime, STUDIO_CODEX_HOME: path.join(runtime, 'codex-home') } });
  const exited = once(child, 'exit');
  const [{ port, token }] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(20000) }),
    exited.then(([code]) => { throw new Error('Studio exited before listening: ' + code); }),
  ]).catch(async error => { child.kill(); await exited; throw error; });
  return {
    async api(route, body) {
      const res = await fetch('http://127.0.0.1:' + port + '/api/' + route, { method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-studio-token': token }, body: body && JSON.stringify(body) });
      const data = await res.json();
      assert.equal(res.status, 200, route + ' ' + (data.error || res.status));
      return data;
    },
    async stop() { if (child.connected) child.disconnect(); const [code] = await exited; assert.equal(code, 0); },
  };
}

async function testWorkspaceSettings() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tab-settings-')));
  let app;
  try {
    const file = stageStudio(root), rt = path.join(root, 'runtime'), settings = path.join(rt, 'studio', 'settings.json');
    const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
    const project = path.join(root, 'project'), other = path.join(root, 'other'), legacy = path.join(root, 'legacy');
    for (const dir of [project, other, legacy, path.dirname(settings)]) fs.mkdirSync(dir, { recursive: true });
    const key = p => process.platform === 'win32' ? p.toLowerCase() : p.replaceAll('/', '\\');
    const removed = 'acp_test_fixture', date = new Date().toLocaleDateString('en-CA');
    const member = { model: 'normal-test', effort: 'low', hardModel: 'hard-test', hardEffort: 'high' };
    const usage = { date, tokens: 79, warned: false };
    const weekly = { id: 'weekly', request: '既有的定時工作', days: [2], time: '08:30', on: true,
      since: '2026-01-01T00:00:00Z', lastAt: '2026-01-06T00:30:00Z', lastResult: '略過前置檢查' };
    const seed = { notify: false, leader: 'codex', acp: [{ id: removed, name: 'test', backend: 'test-fixture' }],
      workspaces: [{ project, leader: removed, workers: [removed, 'codex'], agentCfg: { codex: member }, apiDailyUsage: usage, routines: [weekly],
        tasks: [{ id: 'old-task' }], run: { active: true }, activity: ['old-event'], leases: ['old-lease'] },
      { project: other, name: '第二個專案', leader: 'claude', mission: '別的專案', workers: [], finisher: removed, fallback: removed }],
      closedApiBudgets: { [key(legacy)]: { apiDailyTokenCap: 123, apiDailyUsage: usage } } };
    fs.writeFileSync(settings, JSON.stringify(seed));
    app = await start(file, rt);
    const state = () => app.api('state');
    const tab = async (p = project) => (await state()).workspaces.find(w => w.project === p);
    const post = (route, body) => app.api(route, { ws: project, ...body });
    const close = (p) => app.api('workspace/close', { ws: p });
    const open = (p) => app.api('workspace/open', { path: p });
    await post('workspace/rename', { name: '長期專案' });
    await post('after-done', { mode: 'suggest' }); await post('auto-max', { max: 3 });
    await post('strategy', { strategy: 'custom' }); await post('delivery', { mode: 'pr' });
    await post('finisher', { agent: 'codex' }); await post('fallback', { agent: 'claude' });
    await post('backend-port', { port: 4888 }); await post('worktree-setup', { command: 'echo prepare' });
    await post('token-cap', { cap: 100 }); await post('daily-api-budget', { cap: 500 });
    await post('mission', { text: '測試長期目標' });
    await post('routine/save', { request: '測試排程', days: [1], time: '09:30', on: false, precheck: 'echo scheduled' });
    await post('project-state/refresh', {});
    const stored = () => read().workspaces.find(w => w.project === project);
    const before = stored();
    assert.equal(before.mission, '測試長期目標'); assert.ok(before.pstate); assert.equal(before.routines.length, 2);
    assert.deepEqual(before.routines[0], weekly, 'the schedule keeps its enabled flag and last processed slot');
    await close(project);
    const firstArchive = read().closedWorkspaces?.[key(project)];
    assert.ok(!await tab()); assert.ok(!JSON.stringify(await state()).includes('測試排程'));
    await open(project);
    assert.equal((await tab()).mission, before.mission, 'closing and reopening must retain the mission');
    assert.deepEqual(firstArchive, before, 'closing preserves the same persistent fields, including project state');
    assert.equal((await tab(other)).mission, '別的專案');
    const { pstate, ...preferences } = before;
    const { pstate: refreshed, ...reopened } = stored();
    assert.deepEqual(reopened, preferences, 'every durable setting survives reopening');
    assert.deepEqual(reopened.apiDailyUsage, usage);
    assert.deepEqual(reopened.agentCfg.codex, member);
    assert.equal((await tab()).run, null); assert.deepEqual((await tab()).tasks, []);
    await close(project); await close(other);
    const archive = read().closedWorkspaces[key(project)];
    for (const field of ['run', 'tasks', 'activity', 'leases', 'autoRounds']) assert.ok(!Object.hasOwn(archive, field));
    assert.ok(archive.pstate); assert.deepEqual(archive.routines, before.routines);
    assert.ok(!Object.hasOwn(await state(), 'closedWorkspaces'));
    await app.api('acp/delete', { id: removed });
    await app.stop(); app = null; app = await start(file, rt);
    assert.deepEqual((await state()).workspaces, [], 'closed tabs and their routines stay closed over restart');
    await open(project); await open(other); await open(legacy);
    const restored = await tab(), sibling = await tab(other), oldBudget = await tab(legacy);
    const original = { ...preferences, leader: 'codex', workers: ['codex'], agentCfg: { ...preferences.agentCfg } };
    delete original.agentCfg[removed];
    const { pstate: afterRestart, ...current } = stored();
    assert.deepEqual(current, original, 'restart preserves all remaining choices after an agent is removed');
    assert.deepEqual([restored.run, restored.tasks, restored.activity], [null, [], []]);
    assert.deepEqual([sibling.name, sibling.mission, sibling.workers, sibling.finisher, sibling.fallback], ['第二個專案', '別的專案', [], '', '']);
    assert.deepEqual([oldBudget.apiDailyTokenCap, oldBudget.routines], [123, []]);
    assert.deepEqual(read().workspaces.find(w => w.project === legacy).apiDailyUsage, usage);
    assert.deepEqual(read().closedWorkspaces, {});
    finished();
    console.log('Workspace settings: HTTP close/reopen/restart, all preferences and schedules, isolation, removed agent and legacy budgets: PASS');
  } finally {
    try { await app?.stop(); } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
}

module.exports = { stageStudio, start };
if (require.main === module) testWorkspaceSettings().catch(e => { console.error(e); process.exitCode = 1; });
