// Self-check for Studio's card lifecycle: runs the real code from server.mjs with scripted agent replies.
// Run: node studio/lifecycle-check.cjs   (no agents, no network)
const assert = require('assert');
const nodeCrypto = require('crypto');
const src = require('fs').readFileSync(require('path').join(__dirname, 'server.mjs'), 'utf8').replace(/\r\n/g, '\n');
const region = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('region ' + a); return src.slice(i, j); };
const code = region('function handoffNote(run)', '// ---------- Plan limits') + region('async function planPhase(w)', '// Changing the Leader mid-run');

function makeEnv(script) {
  const logs = [], notices = [], prompts = [];
  const env = {
    AGENTS: { claude: { name: 'Claude Code' }, codex: { name: 'Codex' }, antigravity: { name: 'Antigravity' } },
    S: { workspaces: [] }, crypto: nodeCrypto, logs, notices, prompts,
    log: (w, who, role, text, detail) => logs.push({ who, role, text, detail }),
    notify: (title, body, kind) => notices.push({ title, body, kind }),
    label: () => 'TestProj', refreshClaudeLimits() {}, saveRun() {}, saveSettings() {}, latestJob: () => null, clip: (x, n) => String(x ?? '').slice(0, n), AUTO_MAX: 5, AFTER_DONE: ['stop', 'suggest', 'auto'],
    started: [], start: async (w, request, cont) => { env.started.push({ request, cont }); }, setTimeout: (fn) => queueMicrotask(fn),
    Halt: class extends Error {}, active: new Map(), busyConvs: () => [], cancelTurn() {}, convAgent: new Map(),
    available: () => true, workersFor: (w, lead) => w.workers.filter((x) => x !== lead),
    tierCfg: (w, agent, hard) => ({ model: hard ? 'strong' : 'cheap', effort: '' }),
    workKey: (t) => t.agent + ':work' + (t.hard ? ':hard' : ''),
    conv: async (w, agent, lead, hard) => agent + (lead ? ':lead' : ':work') + (hard ? ':hard' : ''),
    turn: async (agent, cid, text) => { prompts.push({ agent, cid, text }); await new Promise((r) => setTimeout(r, 5)); return script(agent, text); },
    execFile: (cmd, args, opts, cb) => cb(new Error('no git / gh in test'), '', ''), isDir: () => true, readHistory() {}, openWorkspace() {}, wsOf() {},
  };
  const names = Object.keys(env);
  const api = new Function(...names, code + '\nreturn { planPhase, pump, summarize, answer, continueCard, wake, parseStatus, finish, autoNext, instruct };')(...names.map((k) => env[k])); // test harness: our own code
  return { env, api };
}
const newW = () => ({ project: 'P', leader: 'claude', workers: ['claude', 'codex', 'antigravity'], tasks: [], activity: [],
  run: { id: 'r', project: 'P', leader: 'claude', request: 'Build feature X and get it reviewed', convs: {}, phase: 'planning', leaderGen: 0, rounds: 0, ask: null, active: true, paused: false, stopped: false, summarizing: false } });
const settle = () => new Promise((r) => setTimeout(r, 300));

(async () => {
  // 1) dependency chain + waiting on another agent + auto wake + Leader confirms
  let implTurns = 0, reviewTurns = 0, leaderChecks = 0;
  let { env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return JSON.stringify({ message: 'ok', subtasks: [
      { title: 'impl', agent: 'codex', instructions: 'build' },
      { title: 'review', agent: 'antigravity', instructions: 'review', after: [] },
      { title: 'merge', agent: 'codex', instructions: 'merge', after: [1] } ] });
    if (text.includes('Every current card has ended')) { leaderChecks++; return '{"done":true,"report":"全部完成"}'; }
    if (text.includes('"impl"') || text.includes('Task: impl')) { implTurns++; return implTurns === 1 ? 'Opened PR.\nSTATUS: WAITING_AGENT: antigravity: review' : 'Applied review.\nSTATUS: DONE'; }
    if (text.includes('Task: review')) { reviewTurns++; return 'Looks good, one nit.\nSTATUS: DONE'; }
    if (text.includes('Task: merge')) return 'Merged.\nSTATUS: DONE';
    return 'STATUS: DONE';
  });
  let w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle(); await settle();
  assert.deepStrictEqual(w.tasks.map((t) => t.status), ['DONE', 'DONE', 'DONE'], JSON.stringify(w.tasks.map((t) => [t.title, t.status])));
  assert.strictEqual(implTurns, 2, 'impl was woken once after the review');
  const wakePrompt = env.prompts.find((p) => p.agent === 'codex' && p.text.startsWith('Update from Multi-Agent Studio'));
  assert.ok(wakePrompt && wakePrompt.text.includes('Looks good, one nit.'), 'impl got the review result');
  const mergePrompt = env.prompts.find((p) => p.text.includes('Task: merge'));
  assert.ok(mergePrompt.text.includes('Results of the earlier cards'), 'merge got the review result');
  assert.strictEqual(leaderChecks, 1); assert.strictEqual(w.run.result, 'done');
  console.log('1 chain + agent wait + auto wake + leader done: PASS');

  // 2) NEEDS_USER on a card → user answers → card continues; external wait without PR → manual continue
  let askTurns = 0, extTurns = 0;
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"design","agent":"codex","instructions":"x"},{"title":"build","agent":"antigravity","instructions":"y"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (text.includes('Task: design') || (agent === 'codex' && text.startsWith('Update'))) { askTurns++; return askTurns === 1 ? 'Two layouts.\nSTATUS: NEEDS_USER: 要 A 還是 B？\nOPTIONS: A | B' : 'Used ' + (text.includes('"""\nB\n"""') ? 'B' : '?') + '.\nSTATUS: DONE'; }
    extTurns++; return extTurns === 1 ? 'Started nightly build.\nSTATUS: WAITING_EXTERNAL: the nightly build' : 'Build fine.\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle();
  assert.deepStrictEqual(w.tasks.map((t) => t.status), ['NEEDS_USER', 'WAITING_EXTERNAL']);
  assert.deepStrictEqual(w.tasks[0].ask, { question: '要 A 還是 B？', options: ['A', 'B'] });
  assert.strictEqual(w.tasks[1].wait.manual, true, 'no PR → honest manual continue');
  assert.ok(env.notices.some((n) => n.title.includes('需要你處理')) && env.notices.some((n) => n.title.includes('需要你按「繼續」')));
  assert.strictEqual(w.run.active, true, 'run stays open while cards wait');
  api.answer(w, w.tasks[0].id, 'B'); api.continueCard(w, w.tasks[1].id); await settle(); await settle();
  assert.deepStrictEqual(w.tasks.map((t) => t.status), ['DONE', 'DONE']);
  assert.strictEqual(w.tasks[0].result, 'Used B.');
  assert.strictEqual(w.run.result, 'done');
  console.log('2 needs user + answer, manual external continue: PASS');

  // 3) Leader is not done → adds cards; bad JSON once → auto retry, raw text only as detail
  let checks = 0, planCalls = 0;
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) { planCalls++; return 'Sure! Here is my plan: subtasks are impl'; } // not JSON
    if (text.startsWith('Your last reply was not the JSON')) return planCalls === 1 && checks === 0 ? '{"message":"ok","subtasks":[{"title":"impl","agent":"codex","instructions":"x"}]}' : '{"done":true,"report":"完成"}';
    if (text.includes('Every current card has ended')) { checks++; return checks === 1 ? '{"done":false,"message":"還要驗證","subtasks":[{"title":"verify","agent":"antigravity","instructions":"v"}]}' : '{"done":true,"report":"完成"}'; }
    return 'ok\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle(); await settle();
  assert.deepStrictEqual(w.tasks.map((t) => [t.title, t.status]), [['impl', 'DONE'], ['verify', 'DONE']]);
  assert.strictEqual(w.run.result, 'done');
  const fixLog = env.logs.find((l) => l.text.includes('格式不對'));
  assert.ok(fixLog && fixLog.detail.includes('Sure! Here is my plan'), 'raw reply kept as technical detail');
  assert.ok(!env.logs.some((l) => !l.detail && /subtasks|\{"/.test(l.text)), 'no raw JSON in plain log text');
  console.log('3 leader adds cards + JSON auto-retry + friendly log: PASS');

  // 4) Plan fails twice → plain message, run fails, no JSON in the message
  ({ env, api } = makeEnv(() => 'I cannot do JSON today'));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle();
  const last = env.logs.filter((l) => l.who === 'studio').at(-1);
  assert.ok(last.text.startsWith('工頭這次沒有成功建立工作清單') && last.detail.includes('I cannot do JSON'));
  assert.strictEqual(w.run.result, 'failed');
  console.log('4 plan fails twice → friendly message + detail: PASS');

  // 5) No STATUS line → asked once; waiting on an agent with no open card → woken at once
  let t5 = 0;
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"solo","agent":"codex","instructions":"x"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    t5++;
    if (t5 === 1) return 'I did half.'; // no status
    if (t5 === 2) return 'STATUS: WAITING_AGENT: antigravity: a review'; // nobody has antigravity work → wake now
    return 'Finished without the review.\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle(); await settle();
  assert.strictEqual(w.tasks[0].status, 'DONE');
  assert.ok(env.prompts.some((p) => p.text.startsWith('Your last reply had no STATUS line')));
  assert.ok(env.prompts.some((p) => p.text.includes('has no open card in this job')));
  console.log('5 missing status re-asked + no-deadlock wake: PASS');
  // 7) after-done modes: stop asks for nothing, suggest keeps 1-3 next steps, auto starts the first (max 5 in a row)
  const modeScript = (agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"t","agent":"codex","instructions":"x"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok","next":[{"title":"加測試","why":"保護剛做的功能","request":"add tests"},{"title":"更新文件","request":"update docs"}]}';
    return 'ok\nSTATUS: DONE';
  };
  for (const mode of ['stop', 'suggest', 'auto']) {
    ({ env, api } = makeEnv(modeScript));
    w = Object.assign(newW(), { afterDone: mode, autoRounds: 0 }); env.S.workspaces.push(w);
    await api.planPhase(w); await settle();
    const check = env.prompts.find((p) => p.text.includes('Every current card has ended')).text;
    assert.strictEqual(check.includes('"next"'), mode !== 'stop', mode + ': next steps asked only when wanted');
    assert.strictEqual(w.run.suggestions.length, mode === 'stop' ? 0 : 2, mode + ': suggestions kept');
    assert.deepStrictEqual(env.started.map((x) => x.request), mode === 'auto' ? ['add tests'] : [], mode + ': auto start only in auto mode');
    if (mode === 'auto') {
      assert.strictEqual(env.started[0].cont, true); assert.strictEqual(w.autoRounds, 1);
      w.autoRounds = 5; api.autoNext(w, w.run);
      assert.strictEqual(env.started.length, 1, 'stops after 5 in a row');
      assert.ok(env.notices.some((n) => n.title.includes('自動持續開發先停下')));
    }
  }
  console.log('7 after-done modes (stop / suggest / auto + limit): PASS');

  // 8) instructions mid-job: the Leader tells the working card, cancels a waiting card and adds one
  let implTurn = 0;
  ({ env, api } = makeEnv(async (agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"impl","agent":"codex","instructions":"build it red"},{"title":"docs","agent":"antigravity","instructions":"write docs","after":[0]}]}';
    if (text.includes('the user sent new instructions')) {
      const id = (n) => text.match(new RegExp('id (\\w+) \\[\\w+\\] ' + n))[1];
      return JSON.stringify({ message: '改成藍色，文件先不寫', tell: [{ card: id('impl'), note: 'use blue instead of red' }], cancel: [id('docs')], add: [{ title: 'check colors', agent: 'antigravity', instructions: 'check' }] });
    }
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (text.includes('Task: impl')) { implTurn++; await new Promise((r) => setTimeout(r, 120)); return 'Built it red.\nSTATUS: DONE'; }
    if (text.startsWith('New instruction from the user')) return 'Switched to blue.\nSTATUS: DONE';
    return 'ok\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w);
  api.instruct(w, '改用藍色，不要寫文件');
  await settle(); await settle();
  const byTitle = (x) => w.tasks.find((t) => t.title === x);
  assert.ok(env.prompts.some((p) => p.agent === 'codex' && p.text.includes('use blue instead of red')), 'working worker got the note in the same task');
  assert.deepStrictEqual([byTitle('impl').status, byTitle('impl').result], ['DONE', 'Switched to blue.']);
  assert.deepStrictEqual([byTitle('docs').status, byTitle('docs').result], ['FAILED', '依你的指示取消']);
  assert.strictEqual(byTitle('check colors').status, 'DONE');
  assert.ok(env.logs.some((l) => l.text === '你的指示：改用藍色，不要寫文件'));
  assert.strictEqual(w.run.result, 'done');
  console.log('8 instructions mid-job (tell working card / cancel / add): PASS');

  // 9) hard cards use the hard conversation; 立刻打斷 stops the working step and the card continues with the note
  let stopped = false;
  ({ env, api } = makeEnv(async (agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"impl","agent":"codex","instructions":"build","hard":true},{"title":"docs","agent":"antigravity","instructions":"docs"}]}';
    if (text.includes('the user sent new instructions')) {
      const id = text.match(/id (\w+) \[\w+\] impl/)[1];
      return JSON.stringify({ message: '改好了', tell: [{ card: id, note: 'use blue' }], cancel: [], add: [] });
    }
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (text.includes('Task: impl')) { for (let i = 0; i < 40 && !w.tasks[0].interrupted; i++) await new Promise((r) => setTimeout(r, 10)); stopped = w.tasks[0].interrupted; return ''; }
    if (text.startsWith('Update from Multi-Agent Studio')) return (text.includes('use blue') && text.includes('stopped your previous step') ? 'Blue now.' : 'no note?') + '\nSTATUS: DONE';
    return 'ok\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w);
  await new Promise((r) => setTimeout(r, 30));
  api.instruct(w, '改藍色', true);
  await settle(); await settle();
  assert.ok(stopped, 'the working step saw the interrupt');
  assert.ok(env.prompts.some((p) => p.agent === 'codex' && p.text.includes('Task: impl')), 'hard card ran');
  assert.deepStrictEqual([w.tasks[0].status, w.tasks[0].result, w.tasks[0].hard], ['DONE', 'Blue now.', true]);
  assert.ok(env.logs.some((l) => l.text.startsWith('已打斷 Codex')));
  assert.ok(!w.tasks.some((t) => t.hold), 'holds cleared');
  assert.strictEqual(w.run.result, 'done');
  console.log('9 hard card + interrupt now (stop, Leader note, continue): PASS');

  // 10) model strategies pick real catalog models; a failed normal card is retried once on the strong model
  const tierSrc = region('const STRATEGIES = {', 'function setStrategy(');
  const catalogs = { claude: { models: ['default', 'opus', 'fable', 'sonnet', 'haiku', 'claude-sonnet-5'].map((value) => ({ value })), efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    codex: { models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna'].map((value) => ({ value })), efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    antigravity: { models: [], efforts: [] } };
  const tiers = new Function('S', 'AGENTS', tierSrc + '\nreturn tiersOf;')({ agents: catalogs }, { claude: {}, codex: {}, antigravity: {} }); // test harness: our own code
  const pick = (strategy) => { const t = tiers({ strategy, agentCfg: { claude: { model: 'haiku' } } }); return [t.claude.normal.model, t.claude.hard.model, t.codex.normal.model, t.codex.hard.model, t.codex.hard.effort]; };
  assert.deepStrictEqual(pick('save'), ['sonnet', 'opus', 'gpt-6-luna', 'gpt-6.1-sol', 'high']);
  assert.deepStrictEqual(pick('balanced'), ['sonnet', 'opus', 'gpt-6-luna', 'gpt-6.1-sol', 'xhigh']);
  assert.deepStrictEqual(pick('quality'), ['opus', 'fable', 'gpt-6.1-sol', 'gpt-6.1-sol', 'max']);
  assert.deepStrictEqual(pick('custom').slice(0, 2), ['haiku', 'haiku'], 'custom uses the seat settings');
  let workerTries = 0;
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"tricky","agent":"codex","instructions":"x"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (++workerTries === 1) throw new Error('model gave up');
    return 'done on the strong model\nSTATUS: DONE';
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle(); await settle();
  const workerCids = env.prompts.filter((p) => p.agent === 'codex').map((p) => p.cid);
  assert.deepStrictEqual(workerCids, ['codex:work', 'codex:work:hard'], 'retry runs on the hard conversation');
  assert.deepStrictEqual([w.tasks[0].status, w.tasks[0].escalated, w.run.result], ['DONE', true, 'done']);
  assert.ok(env.logs.some((l) => l.text.includes('自動改用強模型重試')));
  console.log('10 model strategies resolve to real models + failed normal card retried on the strong model: PASS');

  // 11) a worker that keeps working is never timed out; a stuck step is stopped; "already running" recovers or resets
  const turnCode = region('// Stops whatever the conversation is doing', '// ---------- Team ----------');
  const makeTurn = (script) => {
    const state = { running: false, cancels: 0, posts: 0 };
    const api = async (method, path, body) => {
      if (method === 'POST' && path.endsWith('/messages')) { state.posts++; return script.post(state); }
      if (method === 'POST' && path.endsWith('/cancel')) { state.cancels++; state.cancelTurnId = body.turn_id; script.cancel(state); return {}; }
      if (path.endsWith('/messages')) return { items: [{ id: 'm1', type: 'text', position: 'left', status: 'finish', created_at: script.mark(state), content: { content: 'done' } }] };
      return { runtime: { turn_id: 'turn_orphan', ...script.runtime(state) } };
    };
    const env = { api, sleep: () => new Promise((r) => setTimeout(r, 1)), active: new Map(), S: { agents: { codex: { working: 0 } } },
      answerConfirmations: async () => {}, refreshCodexLimits() {}, Halt: class extends Error {} };
    const fn = new Function(...Object.keys(env), turnCode + String.fromCharCode(10) + 'return { turn, sendMessage };')(...Object.values(env)); // test harness: our own code
    return { ...fn, state };
  };
  const idleRt = { state: 'idle', is_processing: false }, busyRt = { state: 'running', is_processing: true };
  // A: busy for ~150 ms with new messages all the time, idle limit 60 ms -> no timeout
  let T = makeTurn({ post: (st) => { st.running = true; st.t0 = Date.now(); return { turn_id: 't', msg_id: 'm0' }; },
    cancel: () => {}, mark: (st) => Math.random(), runtime: (st) => (Date.now() - st.t0 > 150 ? idleRt : busyRt) });
  assert.strictEqual(await T.turn('codex', 'c1', 'x', { timeout: 60, progressEvery: 5 }), 'done');
  assert.strictEqual(T.state.cancels, 0, 'a working agent is not cancelled');
  // B: busy and silent -> timeout error, the step is stopped (cancel -> idle)
  T = makeTurn({ post: (st) => { st.running = true; return { turn_id: 't', msg_id: 'm0' }; },
    cancel: (st) => { st.running = false; }, mark: () => 'same', runtime: (st) => (st.running ? busyRt : idleRt) });
  await assert.rejects(T.turn('codex', 'c1', 'x', { timeout: 60, progressEvery: 5 }), (e) => e.timeout === true && /沒有任何新進度/.test(e.message));
  assert.strictEqual(T.state.cancels, 1); assert.strictEqual(T.state.running, false, 'conversation left idle');
  // C: "already running" on send -> cancel the old step, send again, turn completes
  T = makeTurn({ post: (st) => { if (st.posts === 1) { st.running = true; throw new Error('AionCore POST /api/conversations/c1/messages → 409 {"code":"CONFLICT"}'); } return { turn_id: 't', msg_id: 'm0' }; },
    cancel: (st) => { st.running = false; }, mark: () => 'x', runtime: (st) => (st.running ? busyRt : idleRt) });
  assert.strictEqual(await T.turn('codex', 'c1', 'x', { timeout: 60, progressEvery: 5 }), 'done');
  assert.deepStrictEqual([T.state.posts, T.state.cancels], [2, 1]);
  assert.strictEqual(T.state.cancelTurnId, 'turn_orphan', 'an orphan turn is cancelled by the turn id the conversation reports');
  // D: it will not stop -> error marked stuck (the card then gets a fresh conversation)
  T = makeTurn({ post: () => { throw new Error('AionCore POST /api/conversations/c1/messages → 409 {"code":"CONFLICT"}'); },
    cancel: () => {}, mark: () => 'x', runtime: () => busyRt });
  await assert.rejects(T.turn('codex', 'c1', 'x'), (e) => e.stuck === true);
  console.log('11 idle-based timeout, stuck step stopped, "already running" recovery: PASS');

  // 12) a stuck worker conversation gets a fresh one; the 工頭 sees the real failure reason, no strong-model upgrade for tooling errors
  let tries = 0;
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"build","agent":"codex","instructions":"x"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (++tries === 1) throw Object.assign(new Error('AionCore POST /api/conversations/c1/messages → 409 CONFLICT'), { stuck: true });
    return 'ok' + String.fromCharCode(10) + 'STATUS: DONE';
  }));
  w = newW(); w.run.convs = { 'codex:work': 'old-conv' }; env.S.workspaces.push(w);
  await api.planPhase(w); await settle(); await settle();
  assert.deepStrictEqual([w.tasks[0].status, w.tasks[0].convReset, w.tasks[0].escalated], ['DONE', true, undefined]);
  assert.ok(env.logs.some((l) => l.text.includes('改開一個新的對話')));
  // a card that timed out: friendly result, raw reason kept, and the 工頭's final-check prompt carries it
  ({ env, api } = makeEnv((agent, text) => {
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"slow","agent":"codex","instructions":"x"}]}';
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    throw Object.assign(new Error('逾時：25 分鐘沒有任何新進度，Studio 已停止這一步'), { timeout: true });
  }));
  w = newW(); env.S.workspaces.push(w);
  await api.planPhase(w); await settle();
  assert.strictEqual(w.tasks[0].status, 'FAILED'); assert.strictEqual(w.tasks[0].escalated, undefined, 'a timeout is not retried on the strong model');
  assert.ok(w.tasks[0].result.startsWith('沒有完成：25 分鐘沒有任何新進度'));
  const check12 = env.prompts.find((p) => p.text.includes('Every current card has ended')).text;
  assert.ok(check12.includes('[technical reason: 逾時：25 分鐘沒有任何新進度') && check12.includes('never ask the user to read logs'));
  console.log('12 stuck conversation reset + failure reason reaches the 工頭: PASS');

  // status-line parser
  const { parseStatus } = api;
  assert.deepStrictEqual([parseStatus('Built.\nSTATUS: DONE').kind, parseStatus('Built.\nSTATUS: DONE').text], ['DONE', 'Built.']);
  assert.strictEqual(parseStatus('x\n**STATUS:** WAITING_AGENT: antigravity: review').detail, 'antigravity: review');
  assert.deepStrictEqual(parseStatus('x\nSTATUS：NEEDS_USER：A 還是 B？\nOPTIONS: A | B').options, ['A', 'B']);
  assert.strictEqual(parseStatus('no status here'), null);
  console.log('6 status-line parser: PASS');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
