// Real turn/runCard/instruct functions with gated I/O: no providers or filesystem writes.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Card interrupt');
const { region } = require('./lifecycle-harness.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function setup(stage = 'runtime', { stopConfirmed = true, modelHelper, modelFailure } = {}) {
  const entered = deferred(), release = deferred(), prompts = [], applied = [], savedSteps = [], logs = [];
  let gated = false, snapshots = 0, reads = 0;
  let onStepEnd = () => {};
  const cardStep = new Set();
  cardStep.delete = function (cid) { const deleted = Set.prototype.delete.call(this, cid); onStepEnd(); return deleted; };
  const gate = async name => { if (stage === name && !gated) { gated = true; entered.resolve(); await release.promise; } };
  class Halt extends Error {}
  const t = { id: 'card', agent: 'codex', title: 'Preserve partial edits', instructions: 'work', status: 'WAITING', notes: [], leaseGeneration: 3 };
  const run = { id: 'original', active: true, paused: false, stopped: false, lifecycleEpoch: 0, leader: 'claude', convs: { codex: 'cid' } };
  const w = { run, tasks: [t], project: 'P' };
  const env = {
      applyTurnModel: modelHelper || (async () => {}), AGENTS: { codex: {}, claude: {} },
    Halt, reviewAuthors: () => new Set(), agentName: x => x, nowIso: () => 'now', workKey: x => x.agent,
    log: (...args) => logs.push(args), missionNote: () => '', rulesNote: () => '', roleRules: () => '', accessRules: () => '', deliveryRules: () => '',
    STATUS_RULES: 'STATUS: DONE', CARD_STALL_MS: 900000, HARD_CAP_MS: 3600000, VERDICT_RE: {}, QUOTA_RE: /quota/, BILLING_RE: /billing/, MAX_QUOTA_WAITS: 3,
    isWriter: () => true, roOf: () => false, overCap: () => false, cardTokens: () => 0,
    conv: async () => { await gate('conv'); return 'cid'; }, cardStep, askBusy: new Map(),
    workspaceOf: async () => ({ path: 'P' }), treeFiles: async () => ['partial.txt'],
    snapTree: async () => ++snapshots === 1 ? 'before' : 'partial-after', keepStep: async (dir, card) => savedSteps.push({ dir, steps: [...card.steps] }),
    parseStatus: text => text.includes('STATUS: DONE') ? { kind: 'DONE', text, files: [] } : null,
    applyStatus: (w, card, status) => { applied.push(status); card.status = status.kind; }, reportFiles: async () => {}, wakeWaiters: () => {},
    tierCfg: (_w, _agent, hard) => modelHelper ? { model: hard ? 'strong' : 'new' } : {}, handToLeader: () => false, available: () => false,
    pause: () => { run.paused = true; run.active = false; }, saveRun: () => {}, notify: () => {}, label: () => 'test',
    usageOf: async () => { await gate('usage'); return null; }, usageDelta: () => null, chargeUsage: () => {}, refreshCodexLimits: () => {},
    codexRuntime: { prepare: async () => {}, stop: async () => stopConfirmed },
    sendMessage: async (cid, text) => { prompts.push(text); return { turn_id: 'tid', msg_id: 'sent' }; },
    active: new Map(), convActivity: new Map(), steers: new Map(), S: { agents: { codex: { working: 0 } } },
    sleep: async () => {}, stopTurn: async () => stopConfirmed, answerConfirmations: async () => {}, sendSteer: async () => {},
    isAskAnswer: () => false,
    api: async (method, url) => {
      // AionCore returns the config snapshot from runtime/ensure (the GET config-options route is gone).
      const snapshot = url.endsWith('/runtime/ensure');
      if (snapshot || url.includes('/config-options')) {
        await gate(snapshot ? 'model-get' : 'model-put');
        if (snapshot) return { config_options: [{ id: 'model', category: 'model', current_value: 'old', options: [{value:'old'}, {value:'new'}, {value:'strong'}] }] };
        if (modelFailure === 'unconfirmed') throw Object.assign(new Error('config timeout'), { stopUnconfirmed: true });
        return { confirmation: modelFailure === 'ack' ? 'command_ack' : 'observed' };
      }
      if (!url.endsWith('/messages')) { await gate('runtime'); return { runtime: { state: 'idle', is_processing: false } }; }
      reads++; await gate('response');
      return { items: [{ id: 'sent' }, { type: 'text', position: 'left', content: { content: 'Stale completion\nSTATUS: DONE' } }] };
    },
    cancelTurn: () => {}, processNotes: () => {}, answer: () => { throw Error('unexpected answer'); },
  };
  const code = region('async function turn(agent,', '// ---------- External provider')
    + region('async function runCard(w,', '// 工人做不到')
    + region('function instruct(w,', 'const NOTE_SHAPE =')
    + 'return { runCard, instruct, turn };';
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  return { api, w, t, run, env, entered, release, prompts, applied, savedSteps, logs, reads: () => reads,
    onStepEnd: fn => { onStepEnd = fn; } };
}

(async () => {
  const { applyTurnModel } = await import('./live-models.mjs');
  // Real helper + real turn + real runCard: cancellation during config I/O must not escalate the card.
  for (const [stage, stop, modelFailure] of [
    ['model-get', false, undefined], ['model-get', true, undefined],
    ['model-put', false, 'ack'], ['model-put', false, 'unconfirmed']
  ]) {
    const x = setup(stage, { modelHelper: applyTurnModel, modelFailure });
    const pending = x.api.runCard(x.w, x.t);
    await x.entered.promise;
    x.run[stop ? 'stopped' : 'paused'] = true; x.run.active = false;
    x.release.resolve(); await pending;
    assert.equal(x.prompts.length, 0, 'cancelled config startup never sends a model request');
    assert.ok(!x.t.hard && !x.t.escalated, stage + ': cancellation must not escalate');
    assert.equal(x.t.status, stop ? 'FAILED' : 'PAUSED');
    if (modelFailure === 'unconfirmed') {
      assert.equal(x.t.stopUnconfirmed, true, 'uncertain runtime safety remains fenced');
      assert.match(x.t.result, /尚未確認停止/);
    } else assert.equal(x.t.result, stop ? '已停止' : '已暫停');
    assert.equal(x.applied.length, 0, 'no stale completion');
  }
  for (const stage of ['runtime', 'response', 'conv', 'usage']) {
    const x = setup(stage), pending = x.api.runCard(x.w, x.t);
    await x.entered.promise;
    x.api.instruct(x.w, 'Use blue instead', true);
    x.t.notes.push('Use blue instead'); // Leader may deliver the card-specific note before it stops.
    x.release.resolve(); await pending;
    const sent = !['conv', 'usage'].includes(stage); // these two gates close before the first message goes out
    assert.equal(x.t.status, 'WAITING', `${stage}: immediate interrupt must park, not fail`);
    assert.equal(x.t.resumed, sent ? true : undefined); assert.equal(x.t.interrupted, false); assert.equal(x.t.hold, true);
    assert.equal(/last step may be half done/.test(x.t.wakeNote), sent, `${stage}: only a step that reached the agent can be half done`);
    assert.match(x.t.wakeNote, /Use blue instead/);
    assert.equal(x.applied.length, 0, 'stale DONE must not publish');
    assert.equal(x.prompts.length, sent ? 1 : 0);
    assert.equal(x.savedSteps.length, 1, 'partial edits remain in step history');
    assert.deepEqual(x.t.steps[0], { at: 'now', finishedAt: 'now', before: 'before', after: 'partial-after' });
    x.t.hold = false; // Leader has finished processing the instruction.
    await x.api.runCard(x.w, x.t);
    assert.equal(x.t.status, 'DONE'); assert.equal(x.applied.length, 1);
    assert.match(x.prompts.at(-1), /Use blue instead/);
    assert.equal(/Task: Preserve partial edits/.test(x.prompts.at(-1)), !sent, `${stage}: an agent that never got the brief gets it now`);
    assert.equal(x.env.cardStep.size, 0); assert.equal(x.env.active.size, 0); assert.equal(x.env.S.agents.codex.working, 0);
  }
  // A woken card stopped before its first message goes out still owes its agent the update it was woken with.
  for (const stage of ['conv', 'usage']) {
    const x = setup(stage);
    Object.assign(x.t, { briefed: 'codex', wakeNote: 'The user answered: deploy to staging' });
    const pending = x.api.runCard(x.w, x.t);
    await x.entered.promise;
    x.api.instruct(x.w, 'Use blue instead', true);
    x.release.resolve(); await pending;
    assert.equal(x.t.status, 'WAITING'); assert.equal(x.prompts.length, 0);
    assert.match(x.t.wakeNote, /deploy to staging/, `${stage}: the update is still owed`);
    x.t.hold = false;
    await x.api.runCard(x.w, x.t);
    assert.equal(x.t.status, 'DONE'); assert.equal(x.prompts.length, 1);
    assert.match(x.prompts[0], /Update from Multi-Agent Studio/); assert.match(x.prompts[0], /deploy to staging/);
  }
  // An interruption marker is not permission to recover a stale lifecycle/owner.
  const invalidations = {
    paused: x => { x.run.paused = true; x.run.active = false; },
    stopped: x => { x.run.stopped = true; x.run.active = false; },
    inactive: x => { x.run.active = false; },
    epoch: x => { x.run.lifecycleEpoch++; },
    replacement: x => { x.w.run = { ...x.run, id: 'replacement' }; },
    owner: x => { x.t.agent = 'claude'; },
    generation: x => { x.t.leaseGeneration++; },
    removed: x => { x.w.tasks = []; },
    preparing: x => { x.t.preparing = true; },
  };
  for (const [name, invalidate] of Object.entries(invalidations)) {
    const x = setup(), pending = x.api.runCard(x.w, x.t);
    await x.entered.promise;
    x.api.instruct(x.w, 'new instruction', true); invalidate(x);
    x.release.resolve(); await pending;
    assert.notEqual(x.t.status, 'WAITING', `${name}: must not use interruption recovery`);
    assert.equal(x.applied.length, 0, `${name}: stale reply must not apply`);
    assert.equal(x.t.resumed, name === 'paused' ? true : undefined);
    assert.equal(x.t.status, name === 'paused' ? 'PAUSED' : 'FAILED');
  }
  // A successful turn can settle just before interruption/ownership invalidation;
  // the common park path must recheck ownership, not only the turn's error handler.
  for (const [name, invalidate] of Object.entries(invalidations)) {
    const x = setup('response'), pending = x.api.runCard(x.w, x.t);
    await x.entered.promise;
    x.onStepEnd(() => { x.api.instruct(x.w, 'late instruction', true); invalidate(x); });
    x.release.resolve(); await pending;
    assert.equal(x.reads(), 1);
    assert.equal(x.t.status, name === 'paused' ? 'PAUSED' : 'FAILED', `${name}: successful turn cannot park a stale execution`);
    assert.equal(x.applied.length, 0, `${name}: stale success cannot publish`);
  }
  {
    const x = setup('runtime', { stopConfirmed: false }), pending = x.api.runCard(x.w, x.t);
    await x.entered.promise; x.api.instruct(x.w, 'new instruction', true); x.release.resolve(); await pending;
    assert.equal(x.t.status, 'PAUSED', 'unconfirmed stop must retain its safety state');
    assert.equal(x.t.stopUnconfirmed, true); assert.equal(x.run.paused, true); assert.equal(x.applied.length, 0);
  }
  finished();
  console.log('Card interrupt: real turn/runCard/instruct gated startup, idle, response, partial edits, resume, lifecycle/owner guards, unconfirmed stop: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
