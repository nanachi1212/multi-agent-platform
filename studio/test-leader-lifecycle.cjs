// Leader lifecycle regressions: actual server functions, gated I/O, no provider/network/filesystem writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const src = fs.readFileSync(require('node:path').join(__dirname, 'server.mjs'), 'utf8');
const region = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert(i >= 0 && j > i, a); return src.slice(i, j); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function setup(stage = 'create', overrides = {}) {
  const entered = deferred(), release = deferred(), prompts = [], messages = new Map(); let calls = 0;
  class Halt extends Error {}
  const w = { project: 'P', leader: 'claude', workers: ['codex'], tasks: [], activity: [],
    run: { id: 'old', project: 'P', leader: 'claude', leaderGen: 0, convs: {}, phase: 'planning', active: true, paused: false, stopped: false, request: 'OLD REQUEST' } };
  const gate = async () => { entered.resolve(); await release.promise; };
  const env = {
      applyTurnModel: async () => {}, AGENTS: { codex: {}, claude: {} },
    crypto, Halt, dirTag: () => '', tierCfg: () => ({}),
    createConv: async () => { const cid = 'conv' + (++calls); if (calls === 1 && stage === 'create') await gate(); return cid; },
    workersFor: () => ['codex'], available: () => true, agentName: x => x, isDir: () => true,
    endLeftSetups: async () => {}, settingUp: () => false,
    latestJob: () => null, projectContext: () => '', knownRefs: () => [], events: [], event: (type, data) => env.events.push({ type, ...data }), log: () => {},
    saveSettings: () => {}, label: () => 'project', notify: () => {},
    missionNote: () => '', planPrompt: r => r.request, parsePlan: JSON.parse, FIX_JSON: 'fix',
    addCards: (w, cards) => w.tasks.push(...cards), pump: () => {}, processNotes: () => {},
    finish: () => { throw Error('unexpected finish'); },
    busyConvs: r => Object.values(r.convs).filter(x => env.active.has(x)), cancelTurn: () => {},
    workKey: t => t.agent + ':work', reserveJobLeases: () => {}, saveRun: () => {}, stopTurn: async () => true,
    cleanupCardRuntimes: async () => {}, setTimeout, clearTimeout,
    S: { agents: { claude: { working: 0 } }, leases: [] }, usageOf: async () => null,
    active: new Map(), convActivity: new Map(), steers: new Map(), sleep: async () => {},
    sendMessage: async (cid, prompt) => { prompts.push({ prompt, job: w.run.id }); messages.set(cid, prompt); return { turn_id: cid, msg_id: 'sent' }; },
    api: async (method, url) => {
      if (!url.endsWith('/messages')) return { runtime: { state: 'idle', is_processing: false } };
      if (stage === 'response' && messages.size === 1) await gate();
      return { items: [{ id: 'sent' }, { type: 'text', position: 'left', content: { content: JSON.stringify({ subtasks: [{ title: messages.get(url.split('/')[3]) }] }) } }] };
    },
    chargeUsage: () => {}, usageDelta: () => {}, isAskAnswer: () => false,
    leaseBlocker: async () => null, saveLeases: () => {}, watchExternal: () => {},
    clip: x => String(x || ''), handoffNote: () => '', memoryNote: () => '', deliveryRules: () => '',
    SUBTASK_SHAPE: '', SUBTASK_RULES: '', parseJson: JSON.parse, ...overrides
  };
  const code = region('async function conv(w,', "// This run's conversations")
    + region('async function turn(agent,', '// ---------- External provider')
    + region('const CONTINUE_RE =', '// Start every WAITING')
    + region('function pump(w)', '// ---------- Workspace lease:')
    + region('const MAX_ROUNDS =', 'function askUser(w,')
    + region('function routineSlot(', '// ---------- Plan limits')
    + region('async function drainExecution(w,', 'async function stopAndDrain(w)')
    + region('function pause(w)', '// Can be continued')
    + region('const launchingWs =', 'async function reassign(w,')
    + 'return { start, planPhase, pause, pauseAndDrain, resume, turn, pump, runRoutines };';
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  return { w, env, api, entered, release, prompts };
}
(async () => {
  const due = new Date(2026, 10, 19, 9, 30, 10);
  const routine = (id) => ({ id, request: 'schedule ' + id, on: true, time: '09:30', days: [due.getDay()],
    since: new Date(2026, 10, 18).toISOString(), lastAt: '', lastResult: '' });
  for (const withCheck of [false, true]) {
    let finishCheck, checks = 0;
    const x = setup('routine', { execFile: (_cmd, _args, _opts, cb) => { checks++; finishCheck = () => cb(null, '', ''); } });
    const [a, b] = [routine('A'), routine('B')];
    if (withCheck) a.precheck = 'before A';
    Object.assign(x.w, { run: null, routines: [a, b] });
    x.env.S.workspaces = [x.w];
    x.api.runRoutines(due); x.api.runRoutines(due);
    if (withCheck) {
      assert.equal(checks, 1);
      assert.deepEqual([a.lastAt, b.lastAt], ['', ''], 'pending prechecks and later routines keep their slots');
      finishCheck();
    }
    await tick();
    const firstId = x.w.run.id;
    assert.equal(x.w.run.request, a.request);
    assert.deepEqual([a.lastAt, b.lastAt, b.lastResult], [due.toISOString(), '', ''], 'a launch in progress cannot consume B');
    x.api.runRoutines(due); await tick();
    assert.equal(b.lastAt, '', 'B waits while A is active');
    x.w.run.active = false;
    const next = new Date(+due + 60000);
    x.api.runRoutines(next); x.api.runRoutines(next); await tick();
    assert.equal(x.w.run.request, b.request);
    assert.equal(b.lastAt, next.toISOString());
    x.w.run.active = false;
    x.api.runRoutines(next); await tick();
    assert.deepEqual(x.env.events.filter(e => e.type === 'routine.start').map(e => [e.routine, e.job]), [['A', firstId], ['B', x.w.run.id]]);
    assert.equal(x.env.events.filter(e => e.type === 'routine.error').length, 0);
  }
  {
    const x = setup('routine');
    const daily = ['A', 'B'].map(id => ({ ...routine(id), days: [0, 1, 2, 3, 4, 5, 6] }));
    Object.assign(x.w, { run: null, routines: daily }); x.env.S.workspaces = [x.w];
    x.api.runRoutines(due); await tick();
    assert.equal(x.w.run.request, 'schedule A');
    x.w.run.active = false;
    const tomorrow = new Date(+due + 24 * 60 * 60000);
    x.api.runRoutines(tomorrow); await tick();
    assert.equal(x.w.run.request, 'schedule B', 'an older pending routine must not starve when A spans another slot');
    x.w.run.active = false; x.api.runRoutines(tomorrow); await tick();
    assert.equal(x.w.run.request, 'schedule A');
    x.w.run.active = false; x.api.runRoutines(tomorrow); await tick();
    assert.deepEqual(x.env.events.filter(e => e.type === 'routine.start').map(e => e.routine), ['A', 'B', 'A']);
  }
  {
    const launching = deferred();
    const x = setup('routine', { endLeftSetups: () => launching.promise });
    const r = routine('A');
    Object.assign(x.w, { run: null, routines: [r] }); x.env.S.workspaces = [x.w];
    const manual = x.api.start(x.w, 'manual job');
    x.api.runRoutines(due); await tick();
    assert.deepEqual([r.lastAt, r.lastResult], ['', ''], 'manual launch has the project before it publishes w.run');
    launching.resolve(); await manual; await tick();
    x.w.run.active = false; x.api.runRoutines(due); await tick();
    assert.equal(x.w.run.request, r.request);
  }
  console.log('Routines: simultaneous due slots, precheck, manual start and repeated polls: PASS');
  for (const stage of ['create', 'response']) for (const next of ['start', 'resume']) {
    const x = setup(stage), old = x.w.run;
    const pending = x.api.planPhase(x.w); await x.entered.promise;
    let drained = false;
    const pausing = x.api.pauseAndDrain(x.w).then(() => { drained = true; });
    await tick(); assert.equal(drained, false, 'Pause waits for the whole leader operation');
    assert.equal(old.paused, true);
    await assert.rejects(x.api.start(x.w, 'NEW REQUEST'), /停下中/);
    await assert.rejects(x.api.resume(x.w), /停下中/);
    x.release.resolve(); await pending; await pausing;
    assert.equal(x.w.tasks.length, 0, 'old plan cannot publish cards after Pause');
    assert.equal(x.w.leaderSteps.size, 0);
    if (next === 'start') await x.api.start(x.w, 'NEW REQUEST');
    else await x.api.resume(x.w);
    await tick();
    assert.deepEqual(x.w.tasks.map(t => t.title), [next === 'start' ? 'NEW REQUEST' : 'OLD REQUEST']);
    assert.equal(x.w.leaderSteps.size, 0);
    if (stage === 'create') assert.equal(x.prompts.length, 1, 'old conversation creation never sends its request');
    assert.equal(x.prompts.at(-1).job, x.w.run.id);
  }
  // Phase guards must remain synchronous even though the operation is tracked with a promise.
  {
    const x = setup(); Object.assign(x.w.run, { phase: 'working' });
    x.w.tasks = [{ id: 'done', title: 'done', status: 'DONE', agent: 'codex' }];
    x.api.pump(x.w); x.api.pump(x.w);
    assert.equal(x.w.run.summarizing, true);
    assert.equal(x.w.leaderSteps.size, 1, 'back-to-back pump calls must schedule only one summary');
    await x.entered.promise;
    const stopping = x.api.pauseAndDrain(x.w); x.release.resolve(); await stopping;
    assert.equal(x.prompts.length, 0); assert.equal(x.w.leaderSteps.size, 0);
  }
  // Defense in depth: even if the same run is made active again, a pre-Pause turn startup is invalidated.
  const x = setup(), usage = deferred(), old = x.w.run;
  const startup = deferred(); x.env.usageOf = async () => { startup.resolve(); return usage.promise; };
  // The closures above retain env values; use a direct extraction for the controlled usage gate.
  const turn = new Function(...Object.keys(x.env), region('async function turn(agent,', '// ---------- External provider') + 'return turn;')(...Object.values(x.env));
  const running = turn('claude', 'cid', 'must not send', { w: x.w, lead: true });
  await startup.promise; x.api.pause(x.w); Object.assign(old, { active: true, paused: false }); usage.resolve(null);
  await assert.rejects(running, /執行已停止/); assert.equal(x.prompts.length, 0);
  console.log('Leader lifecycle: pending creation/response drain, Start/Resume isolation, epoch-guarded turn startup: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
