// Actual settings, billing, admission and turn code. Only the provider and Windows notification are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { region, mkTmp, makeEnv, newW } = require('./lifecycle-harness.cjs');

(async () => {
  const { writeJson } = await import('./state-files.mjs');
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
  } finally {
    if (harness) await fs.promises.rm(harness.env.RT, { recursive: true, force: true });
    await fs.promises.rm(rt, { recursive: true, force: true });
  }
  console.log('API budget: subscriptions, handoff usage, daily warning, restart, close/reopen, midnight, admission and in-flight overage PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
