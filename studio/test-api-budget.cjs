// Actual settings, billing, admission and turn code. Only the provider and Windows notification are simulated.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('API budget');
const fs = require('node:fs'), path = require('node:path');
const { region, mkTmp, makeEnv, newW } = require('./lifecycle-harness.cjs');

(async () => {
  const { writeJson } = await import('./state-files.mjs');
  const { readAionrsUsage } = await import('./aion-client.mjs');
  const rt = mkTmp('studio-api-budget-'), settings = path.join(rt, 'studio', 'settings.json');
  const EVENT = [], notices = [], agents = { codex: {}, claude: {}, ext: { external: true } };
  let now = new Date(2026, 10, 18, 23, 59, 58);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const budgets = region('function tokenLimit(', 'function setBackendPort(');
  const env = { fs, path, RT: rt, AGENTS: agents, Date: Clock, writeJson, validRoutine: () => true,
    treeKey: p => p.toLowerCase(), refreshState() {}, stillStopping: () => false, preparing: new Map(),
    event: (type, data) => EVENT.push({ type, ...data }), notify: (...args) => notices.push(args) };
  const load = () => new Function(...Object.keys(env),
    region('const AFTER_DONE =', '// ponytail: reads the newest') + budgets
    + region('function chargeUsage(', '// ---------- Automatic fallback')
    + region('function openWorkspace(p)', 'function removeRecent(p)')
    + 'return { S, setApiDailyTokenCap, chargeUsage, apiBudgetSpent, closeWorkspace, openWorkspace };')(...Object.values(env));
  let harness;
  const extra = [];
  try {
    writeJson(settings, { project: rt }); // legacy settings, before workspaces or API budgets
    let app = load(), w = app.S.workspaces[0];
    assert.equal(w.project, rt); assert.equal(w.apiDailyTokenCap, 0);
    const card = {}, run = {};
    const charge = (agent, input, output) => app.chargeUsage(run, agent, card, { in: input, out: output, cache: 9 }, w);
    charge('codex', 400, 200); charge('claude', 300, 100);
    assert.equal(w.apiDailyUsage, null);
    charge('ext', 60, 19); // measured even while unlimited
    app.setApiDailyTokenCap(w, 100);
    assert.equal(w.apiDailyUsage.tokens, 79); assert.equal(notices.length, 0);
    charge('ext', 1, 0); charge('codex', 1000, 0); charge('ext', 3, 2);
    assert.equal(w.apiDailyUsage.tokens, 85); assert.equal(notices.length, 1);
    assert.deepEqual(EVENT, [{ type: 'api.budget.warning', tokens: 80, cap: 100 }]);
    app = load(); w = app.S.workspaces[0]; // restart with the same settings file
    assert.equal(w.apiDailyTokenCap, 100); assert.equal(w.apiDailyUsage.warned, true);
    app.chargeUsage({}, 'ext', {}, { in: 12, out: 3, cache: 0 }, w); // another job and card in the same project
    assert.equal(w.apiDailyUsage.tokens, 100); assert.equal(notices.length, 1);
    assert.ok(app.apiBudgetSpent(w, 'ext')); assert.ok(!app.apiBudgetSpent(w, 'claude'));
    app.closeWorkspace(w); app = load(); app.openWorkspace(rt); w = app.S.workspaces[0];
    assert.equal(w.apiDailyTokenCap, 100); assert.ok(app.apiBudgetSpent(w, 'ext'));
    now = new Date(2026, 10, 19, 0, 0, 1);
    assert.ok(!app.apiBudgetSpent(w, 'ext'), 'midnight admits work before another charge arrives');
    charge('ext', 40, 40);
    assert.equal(w.apiDailyUsage.tokens, 80); assert.equal(notices.length, 2);
    assert.throws(() => app.setApiDailyTokenCap(w, -1)); assert.equal(w.apiDailyTokenCap, 100);

    // The real dispatch/turn path: the first response crosses the daily cap; asking for a missing STATUS needs another turn.
    let sends = 0, reads = 0, turn;
    harness = makeEnv(() => 'OK\nSTATUS: DONE', { AGENTS: agents, turn: (...args) => turn(...args) });
    const id = 'a1b2c3d4', file = path.join(rt, 'aionrs-sessions', 'sessions', id, 'state.json');
    const snapshot = (input_tokens, output_tokens, cache_read_tokens) => {
      writeJson(file, { id, total_usage: { input_tokens, output_tokens, cache_read_tokens } });
      return readAionrsUsage(rt, id);
    };
    assert.equal(await readAionrsUsage(rt, id), null);
    await assert.rejects(readAionrsUsage(rt, '..'), /ID/);
    const first = await snapshot(79, 31, 4), second = await snapshot(158, 62, 8);
    assert.deepEqual(harness.api.usageDelta(first, second), { in: 79, out: 31, cache: 4 });
    assert.equal(harness.api.usageDelta(second, second), null);
    assert.throws(() => harness.api.usageDelta(second, first), /重設/);
    writeJson(file, { id: 'different', total_usage: {} });
    await assert.rejects(readAionrsUsage(rt, id), /用量格式/);
    const job = newW(); job.apiDailyTokenCap = 100;
    const worker = { id: 'one', title: 'one', agent: 'ext', writes: false, status: 'WAITING', after: [] };
    job.tasks.push(worker);
    const turnEnv = { ...harness.env, usageOf: async () => reads++ ? { _meta: { input_tokens: 70, output_tokens: 40 } } : null,
      usageDelta: harness.api.usageDelta, chargeUsage: harness.api.chargeUsage, steers: new Map(),
      sendMessage: async () => { sends++; return { turn_id: 'turn', msg_id: 'sent' }; }, isAskAnswer: () => false,
      api: async (_verb, url) => url.endsWith('/messages')
        ? { items: [{ id: 'sent' }, { position: 'left', type: 'text', content: { content: 'Needs another step' } }] }
        : { runtime: { state: 'idle' } } };
    turnEnv.S.agents = { ext: { working: 0 } };
    turn = new Function(...Object.keys(turnEnv), budgets + region('async function turn(agent,', '// ---------- External provider') + 'return turn;')(...Object.values(turnEnv));
    await harness.api.runTask(job, worker);
    assert.equal(sends, 1); assert.equal(worker.usage.in + worker.usage.out, 110);
    assert.equal(job.apiDailyUsage.tokens, 110); assert.equal(worker.status, 'NEEDS_USER');
    const next = { id: 'two', title: 'two', agent: 'ext', writes: true, status: 'WAITING', after: [] };
    job.tasks.push(next); await harness.api.runTask(job, next);
    assert.equal(next.status, 'NEEDS_USER'); assert.match(next.ask.question, /今日 API 預算已用完/);
    assert.equal(next.firstStartedAt, undefined); assert.equal(sends, 1);
    assert.ok(!turnEnv.S.leases.some(l => l.cardId === next.id));
    assert.ok(!harness.api.overCap(job, worker), 'per-card limit remains independent');
    turn = async () => 'OK\nSTATUS: DONE';
    const subscription = { ...next, ask: null, id: 'three', agent: 'codex', status: 'WAITING' };
    job.tasks.push(subscription); job.run.phase = 'working';
    harness.api.pump(job);
    const active = job.executingSteps.get(subscription.id);
    assert.ok(active, 'a never-started budget-held card does not reserve the writer slot');
    await active.done; assert.equal(subscription.status, 'DONE');
    job.apiDailyTokenCap = 150;
    harness.api.answer(job, next.id, '重新檢查預算');
    await job.executingSteps.get(next.id).done;
    assert.equal(next.status, 'DONE', 'raising the cap admits the parked card on user retry');

    // A handoff reserves the folder for an external member whose budget is spent; the card never started.
    const { execFile, execFileSync } = require('node:child_process');
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    const repoAt = (name) => {
      const repo = path.join(rt, name); fs.mkdirSync(repo);
      git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
      fs.writeFileSync(path.join(repo, 'source.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
      return repo;
    };
    const today = () => new Date().toLocaleDateString('en-CA');
    const spent = (w, tokens) => Object.assign(w, { apiDailyTokenCap: 100, apiDailyUsage: { date: today(), tokens, warned: true } });
    const settled = async (w, id) => { await new Promise(r => setTimeout(r, 50)); while (w.executingSteps?.has(id)) await w.executingSteps.get(id).done; };
    const handed = makeEnv(() => 'ok\nSTATUS: DONE', { execFile });
    extra.push(handed.env.RT);
    handed.env.AGENTS.ext = { name: 'Ext API', external: true };
    const hw = newW(); hw.project = hw.run.project = repoAt('handoff');
    Object.assign(hw.run, { phase: 'working', startedAt: new Date().toISOString() });
    hw.workers.push('ext'); spent(hw, 100); handed.env.S.workspaces.push(hw);
    const a = { id: 'a', title: 'a', instructions: 'a', role: 'build', agent: 'codex', writes: true, status: 'WAITING', after: [], trust: true };
    const b = { id: 'b', title: 'b', instructions: 'b', role: 'build', agent: 'claude', writes: true, status: 'WAITING', after: [], trust: true, wakeNote: 'continue' };
    hw.tasks.push(b, a); // b is woken for the same folder and ahead in line: Studio's own dispatch must start it once the reservation is given back
    await handed.api.handoffWriter(hw, 'ext', 'a');
    await settled(hw, 'a');
    assert.equal(a.agent, 'ext'); assert.equal(a.status, 'NEEDS_USER'); assert.ok(a.ask?.apiBudget);
    assert.equal(a.firstStartedAt, undefined);
    assert.ok(!handed.env.S.leases.some(l => l.cardId === 'a' && ['ACTIVE', 'RESERVED'].includes(l.status)), 'a card waiting for budget gives back its reservation');
    for (let i = 0; i < 200 && b.status !== 'DONE'; i++) await new Promise(r => setTimeout(r, 25));
    await settled(hw, 'b');
    assert.equal(b.status, 'DONE', 'another writer in the same folder is not stuck behind the budget');
    hw.apiDailyTokenCap = 1000;
    handed.api.answer(hw, 'a', '重新檢查預算');
    await settled(hw, 'a');
    assert.equal(a.status, 'DONE', 'after the cap is raised the card takes a fresh lease and finishes');
    assert.equal(handed.env.prompts.filter(p => p.agent === 'ext' && p.text.includes('Task: a')).length, 1);

    // The same line-up with budget left: the card holding the folder's reservation goes first, the other follows it.
    // Before, the woken card marked itself WORKING, kept the holder from starting and then lost the folder, on every 30 s retry.
    {
      const free = makeEnv(() => 'ok\nSTATUS: DONE', { execFile });
      extra.push(free.env.RT);
      free.env.AGENTS.ext = { name: 'Ext API', external: true };
      const fw = newW(); fw.project = fw.run.project = repoAt('handoff-free');
      Object.assign(fw.run, { phase: 'working', startedAt: new Date().toISOString() });
      fw.workers.push('ext'); spent(fw, 0); free.env.S.workspaces.push(fw);
      const ha = { id: 'a', title: 'a', instructions: 'a', role: 'build', agent: 'codex', writes: true, status: 'WAITING', after: [], trust: true };
      const hb = { id: 'b', title: 'b', instructions: 'b', role: 'build', agent: 'claude', writes: true, status: 'WAITING', after: [], trust: true, wakeNote: 'continue' };
      fw.tasks.push(hb, ha);
      await free.api.handoffWriter(fw, 'ext', 'a');
      for (let i = 0; i < 200 && !(ha.status === 'DONE' && hb.status === 'DONE'); i++) await new Promise(r => setTimeout(r, 25));
      assert.equal(ha.status, 'DONE', 'the card holding the reservation is not shut out by a writer ahead in line');
      assert.equal(hb.status, 'DONE', 'the writer ahead in line runs after the holder');
    }

    // A user instruction queued for the next step survives a follow-up turn the budget refuses.
    let calls = 0, refused = false, g;
    const noted = makeEnv((agent, prompt) => {
      if (prompt.includes('Every current card has ended')) return '{"needs_user":"ok?"}';
      if (++calls === 1) { g.notes = ['use the v2 API instead']; return 'first step\nSTATUS: DONE'; }
      if (prompt.includes('New instruction from the user') && !refused) {
        refused = true; nw.apiDailyUsage.tokens = nw.apiDailyTokenCap; // the first step used the rest of today's budget
        throw Object.assign(new Error('今日 API 預算已用完'), { apiBudget: true }); // what turn() throws before sending
      }
      return 'finished\nSTATUS: DONE';
    }, { execFile });
    extra.push(noted.env.RT);
    noted.env.AGENTS.ext = { name: 'Ext API', external: true };
    const nw = newW(); nw.project = nw.run.project = repoAt('notes');
    Object.assign(nw.run, { phase: 'working', startedAt: new Date().toISOString() });
    nw.workers.push('ext'); spent(nw, 10); noted.env.S.workspaces.push(nw);
    g = { id: 'g', title: 'g', instructions: 'g', role: 'build', agent: 'ext', writes: true, status: 'WAITING', after: [], trust: true };
    nw.tasks.push(g);
    await noted.api.runTask(nw, g);
    assert.ok(refused); assert.equal(g.status, 'NEEDS_USER'); assert.ok(g.ask?.apiBudget);
    assert.deepEqual(g.notes, ['use the v2 API instead'], 'the refused turn never ran: the instruction is still queued');
    const sent = noted.env.prompts.length;
    nw.apiDailyTokenCap = 1000;
    noted.api.answer(nw, 'g', '重新檢查預算');
    await settled(nw, 'g');
    assert.equal(g.status, 'DONE');
    assert.equal(noted.env.prompts.slice(sent).filter(p => p.text.includes('use the v2 API instead')).length, 1, 'the member hears the instruction exactly once');

    // A card woken with an update still owes its member that update when the budget refuses its first turn.
    let turns = 0;
    const woken = makeEnv((agent, prompt) => {
      if (prompt.includes('Every current card has ended')) return '{"needs_user":"ok?"}';
      if (++turns === 1) {
        kw.apiDailyUsage.tokens = kw.apiDailyTokenCap; // another card spent the rest while this one was starting
        throw Object.assign(new Error('今日 API 預算已用完'), { apiBudget: true }); // what turn() throws before sending
      }
      return 'finished\nSTATUS: DONE';
    }, { execFile });
    extra.push(woken.env.RT);
    woken.env.AGENTS.ext = { name: 'Ext API', external: true };
    const kw = newW(); kw.project = kw.run.project = repoAt('woken');
    Object.assign(kw.run, { phase: 'working', startedAt: new Date().toISOString() });
    kw.workers.push('ext'); spent(kw, 10); woken.env.S.workspaces.push(kw);
    const k = { id: 'k', title: 'k', instructions: 'k', role: 'build', agent: 'ext', writes: true, status: 'WAITING', after: [], trust: true, wakeNote: 'The user answered: deploy to staging' };
    kw.tasks.push(k);
    await woken.api.runTask(kw, k);
    assert.equal(k.status, 'NEEDS_USER'); assert.ok(k.ask?.apiBudget);
    const refusedAt = woken.env.prompts.length;
    kw.apiDailyTokenCap = 1000;
    woken.api.answer(kw, 'k', '重新檢查預算');
    await settled(kw, 'k');
    assert.equal(k.status, 'DONE');
    assert.equal(woken.env.prompts.slice(refusedAt).filter(p => p.text.includes('deploy to staging')).length, 1, 'the update reaches the member once the budget allows the turn');
  } finally {
    for (const dir of extra) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
    if (harness) await fs.promises.rm(harness.env.RT, { recursive: true, force: true });
    await fs.promises.rm(rt, { recursive: true, force: true });
  }
  finished();
  console.log('API budget: subscriptions, handoff usage, daily warning, restart, close/reopen, midnight, admission, in-flight overage, handoff reservation released while over budget and queued instruction kept on a refused turn PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
