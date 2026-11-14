// Leader lifecycle regressions: actual server functions, gated I/O, no provider/network/filesystem writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const src = fs.readFileSync(require('node:path').join(__dirname, 'server.mjs'), 'utf8');
const region = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert(i >= 0 && j > i, a); return src.slice(i, j); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function setup(stage = 'create') {
  const entered = deferred(), release = deferred(), prompts = [], messages = new Map(); let calls = 0;
  class Halt extends Error {}
  const w = { project: 'P', leader: 'claude', workers: ['codex'], tasks: [], activity: [],
    run: { id: 'old', project: 'P', leader: 'claude', leaderGen: 0, convs: {}, phase: 'planning', active: true, paused: false, stopped: false, request: 'OLD REQUEST' } };
  const gate = async () => { entered.resolve(); await release.promise; };
  const env = {
    crypto, Halt, dirTag: () => '', tierCfg: () => ({}),
    createConv: async () => { const cid = 'conv' + (++calls); if (calls === 1 && stage === 'create') await gate(); return cid; },
    workersFor: () => ['codex'], available: () => true, agentName: x => x, isDir: () => true,
    endLeftSetups: async () => {}, settingUp: () => false,
    latestJob: () => null, projectContext: () => '', knownRefs: () => [], event: () => {}, log: () => {},
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
    SUBTASK_SHAPE: '', SUBTASK_RULES: '', parseJson: JSON.parse
  };
  const code = region('async function conv(w,', "// This run's conversations")
    + region('async function turn(agent,', '// ---------- External provider')
    + region('const CONTINUE_RE =', '// Start every WAITING')
    + region('function pump(w)', '// ---------- Workspace lease:')
    + region('const MAX_ROUNDS =', 'function askUser(w,')
    + src.match(/^const stillStopping = .*$/m)[0] + '\n'
    + region('async function drainExecution(w,', 'async function stopAndDrain(w)')
    + region('function pause(w)', '// Can be continued')
    + region('const launchingWs =', 'async function reassign(w,')
    + 'return { start, planPhase, pause, pauseAndDrain, resume, turn, pump };';
  const api = new Function(...Object.keys(env), code)(...Object.values(env));
  return { w, env, api, entered, release, prompts };
}
(async () => {
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
