// All scripted lifecycle regressions; no agents or network.
const { assert, nodeCrypto, src, region, TMP_DIRS, mkTmp, makeEnv, newW, settle } = require('./lifecycle-harness.cjs');

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
    if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"design","agent":"codex","instructions":"x"},{"title":"build","agent":"antigravity","instructions":"y","writes":false}]}';
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

  // 13) delivery policy reaches the 工頭 (plan + final check) and every worker; 'pr' mode stops before merging
  for (const mode of ['auto', 'pr']) {
    ({ env, api } = makeEnv((agent, text) => {
      if (text.includes('LEADER (foreman)')) return '{"message":"ok","subtasks":[{"title":"ship","agent":"codex","instructions":"x"}]}';
      if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
      return 'ok' + String.fromCharCode(10) + 'STATUS: DONE';
    }));
    w = Object.assign(newW(), { delivery: mode }); env.S.workspaces.push(w);
    await api.planPhase(w); await settle(); await settle();
    const plan = env.prompts.find((p) => p.text.includes('LEADER (foreman)')).text;
    const work = env.prompts.find((p) => p.text.includes('Task: ship')).text;
    const check = env.prompts.find((p) => p.text.includes('Every current card has ended')).text;
    for (const [name, text] of [['plan', plan], ['worker', work], ['check', check]]) {
      assert.ok(text.includes(mode === 'auto' ? 'Delivery policy (autonomous)' : 'Delivery policy (stop at the pull request)'), mode + ' ' + name + ': policy present');
      assert.ok(text.includes('a destructive operation that could permanently lose the user'), mode + ' ' + name + ': stop conditions present');
      if (mode === 'auto') {
        assert.ok(text.includes('Review triage') && text.includes('Blocker or P1 finding is always fixed') && text.includes('P2 that is directly caused by or inside what this PR changes is fixed'), name + ': triage tiers present');
        assert.ok(text.includes('every other P2 and every P3 is NOT fixed') || text.includes('Every other P2 and every P3 is NOT fixed'), name + ': other P2 / P3 are recorded, not fixed');
        assert.ok(text.includes('Review ONCE') && text.includes('At most two fix rounds'), name + ': the review loop is bounded');
      } else assert.ok(!text.includes('Review triage'), name + ': no review chain in pr mode');
      if (mode === 'auto' && name !== 'plan') assert.ok(text.includes('Recorded, not fixed'), name + ': recorded findings are reported');
      assert.ok(!text.includes('Ordinary P1/P2 review findings are fixed'), name + ': the old blanket P1/P2 rule is gone');
      assert.strictEqual(text.includes('squash merge'), mode === 'auto', mode + ' ' + name + ': merge only in auto');
    }
    assert.ok(plan.includes('ONE worker card') && work.includes('STATUS: NEEDS_USER') && !plan.includes('STATUS: NEEDS_USER'), mode + ': role-specific wording');
    assert.strictEqual(check.includes('complete only when the work is delivered'), mode === 'auto');
    assert.ok(mode === 'auto' || (plan.includes('Do NOT merge') && work.includes('Do NOT merge')));
  }
  console.log('13 delivery policy in plan / worker / final check (auto to merge, pr stops): PASS');

  // 14) one writer per working tree; read-only cards run alongside it
  const nfs = require('fs'), nos = require('os'), npath = require('path'), { execFileSync } = require('child_process');
  const waitFor = async (cond, ms = 12000) => { for (let t0 = Date.now(); Date.now() - t0 < ms;) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  const planOf = (subtasks) => JSON.stringify({ message: 'ok', subtasks });
  for (const readerB of [false, true]) {
    const running = new Set(); let maxRunning = 0;
    ({ env, api } = makeEnv(async (agent, text) => {
      if (text.includes('LEADER (foreman)')) return planOf([{ title: 'edit A', agent: 'codex', instructions: 'a' }, { title: 'edit B', agent: 'antigravity', instructions: 'b', writes: !readerB }]);
      if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
      running.add(agent); maxRunning = Math.max(maxRunning, running.size);
      await new Promise((r) => setTimeout(r, 80)); running.delete(agent);
      return 'ok' + String.fromCharCode(10) + 'STATUS: DONE';
    }));
    w = newW(); env.S.workspaces.push(w);
    await api.planPhase(w);
    assert.ok(await waitFor(() => w.run.result === 'done'), 'job done (readerB=' + readerB + ')');
    assert.strictEqual(maxRunning, readerB ? 2 : 1, readerB ? 'a read-only card runs alongside the writer' : 'two writers never overlap');
    const bPrompt = env.prompts.find((p) => p.text.includes('Task: edit B')).text;
    assert.ok(readerB ? bPrompt.includes('READ-ONLY card') : bPrompt.includes('only one allowed to modify'), 'access rules in the card brief');
  }

  // 15) lock file, outside writer, tree changed meanwhile, pause / stop meaning (real git repo)
  const tmpRepos = [];
  const mkRepo = () => {
    const d = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'studio-lock-'));
    tmpRepos.push(d);
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, stdio: 'pipe' });
    g('init', '-q'); nfs.writeFileSync(npath.join(d, 'a.txt'), '1'); g('add', '.'); g('commit', '-q', '-m', 'init');
    return { d, g, lock: npath.join(d, '.git', 'studio-writer.lock') };
  };
  const repoEnv = (repo, script) => {
    return makeEnv(script, { execFile: (cmd, args, opts, cb) => require('child_process').execFile(cmd, args, opts, cb) }); // the real git for the repo checks
  };
  const oneCard = (title, extra = {}) => planOf([{ title, agent: 'codex', instructions: 'x', ...extra }]);
  const stdScript = (title, onWork) => async (agent, text) => {
    if (text.includes('LEADER (foreman)')) return oneCard(title);
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (onWork) return onWork(text);
    return 'ok' + String.fromCharCode(10) + 'STATUS: DONE';
  };
  const mkW = (repo) => { const x = newW(); x.project = repo.d; x.run.project = repo.d; return x; };
  const LOCKS = {};

  // a) the lock file exists while a writer works and is gone afterwards; the fingerprint is saved
  let repo = mkRepo(), sawLock = false;
  ({ env, api } = repoEnv(repo, stdScript('ship', () => { sawLock = nfs.existsSync(repo.lock) && JSON.parse(nfs.readFileSync(repo.lock, 'utf8')).owner === 'Multi-Agent Studio'; return 'ok' + String.fromCharCode(10) + 'STATUS: DONE'; })));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => w.run.result === 'done'));
  assert.ok(sawLock, 'lock file present while the writer works');
  assert.ok(!nfs.existsSync(repo.lock), 'lock file removed when no writer is left');
  assert.ok(w.run.treeStamp && w.run.leftAt, 'fingerprint of the tree saved');

  // b) another program holds a fresh lock: the writer waits, then goes when the lock is gone
  repo = mkRepo();
  nfs.writeFileSync(repo.lock, JSON.stringify({ owner: 'Other Agent', instance: 'zzzz', pid: process.pid, card: 'their edit', beat: new Date().toISOString() }));
  ({ env, api } = repoEnv(repo, stdScript('ship')));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => /Other Agent/.test(w.tasks[0]?.blockReason || '')), 'writer waits for the outside lock');
  assert.strictEqual(w.tasks[0].status, 'WAITING'); assert.ok(env.logs.some((l) => l.text.includes('先不動')));
  nfs.rmSync(repo.lock); api.pump(w);
  assert.ok(await waitFor(() => w.run.result === 'done'), 'goes after the lock is gone');
  // a stale lock (owner dead / old heartbeat) does not block
  repo = mkRepo();
  nfs.writeFileSync(repo.lock, JSON.stringify({ owner: 'Gone', instance: 'zzzz', pid: process.pid, card: 'old', beat: new Date(Date.now() - 10 * 60e3).toISOString() }));
  ({ env, api } = repoEnv(repo, stdScript('ship')));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => w.run.result === 'done'), 'a stale lock is ignored');

  // c) an automatic wake (CI result) after somebody committed meanwhile: Studio asks before writing
  for (const answerIs of ['接手', '暫停']) {
    repo = mkRepo(); let turns = 0;
    ({ env, api } = repoEnv(repo, stdScript('ship', () => (++turns === 1 ? 'PR open' + String.fromCharCode(10) + 'STATUS: WAITING_EXTERNAL: the nightly build' : 'ok' + String.fromCharCode(10) + 'STATUS: DONE'))));
    w = mkW(repo); env.S.workspaces.push(w);
    await api.planPhase(w);
    assert.ok(await waitFor(() => w.tasks[0]?.status === 'WAITING_EXTERNAL' && w.run.treeStamp), 'parked on the external wait, tree fingerprint saved');
    repo.g('commit', '-q', '--allow-empty', '-m', 'somebody else');
    api.wake(w, w.tasks[0], 'CI finished');
    assert.ok(await waitFor(() => w.tasks[0].status === 'NEEDS_USER' && w.tasks[0].takeover), 'asks before writing over changes');
    assert.deepStrictEqual(w.tasks[0].ask.options, ['確認接手，繼續', '先不要（暫停）']);
    assert.strictEqual(turns, 1, 'no second turn before the user decides');
    api.answer(w, w.tasks[0].id, answerIs === '接手' ? '確認接手，繼續' : '先不要（暫停）');
    if (answerIs === '接手') { assert.ok(await waitFor(() => w.run.result === 'done'), 'continues after 確認接手'); assert.strictEqual(turns, 2); }
    else { assert.ok(await waitFor(() => w.run.paused === true), '先不要 pauses'); assert.strictEqual(turns, 1); }
  }
  // d) somebody is editing right now (file changed after Studio left): wait
  repo = mkRepo(); let turns4 = 0;
  ({ env, api } = repoEnv(repo, stdScript('ship', () => (++turns4 === 1 ? 'x' + String.fromCharCode(10) + 'STATUS: WAITING_EXTERNAL: build' : 'ok' + String.fromCharCode(10) + 'STATUS: DONE'))));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => w.tasks[0]?.status === 'WAITING_EXTERNAL' && w.run.leftAt));
  await new Promise((r) => setTimeout(r, 30)); nfs.writeFileSync(npath.join(repo.d, 'b.txt'), 'someone is typing');
  api.wake(w, w.tasks[0], 'CI finished');
  assert.ok(await waitFor(() => /秒前有檔案被改過/.test(w.tasks[0].blockReason || '')), 'waits while someone edits');
  assert.strictEqual(turns4, 1);

  // e) PAUSE: the writer stops, the lock is released, nothing resumes by itself; 繼續 (manual) continues even if files changed
  repo = mkRepo(); let turns5 = 0;
  ({ env, api } = repoEnv(repo, stdScript('ship', async () => { if (++turns5 === 1) { await new Promise((r) => setTimeout(r, 120)); if (w.run.paused) throw new env.Halt('已暫停'); } return 'ok' + String.fromCharCode(10) + 'STATUS: DONE'; })));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => w.tasks[0]?.status === 'WORKING' && nfs.existsSync(repo.lock)));
  api.pause(w);
  assert.ok(await waitFor(() => nfs.existsSync(repo.lock) && w.tasks[0].status === 'PAUSED' && !w.executingSteps?.size), 'paused: writer stopped, reservation mirror retained');
  api.wake(w, w.tasks[0], 'CI finished'); // not parked -> no effect; and a paused run never starts anything
  await new Promise((r) => setTimeout(r, 150)); assert.strictEqual(turns5, 1, 'nothing runs while paused');
  repo.g('commit', '-q', '--allow-empty', '-m', 'edited while paused');
  await api.resume(w);
  assert.ok(await waitFor(() => w.run.result === 'done'), '繼續 continues without asking');
  assert.ok(!w.tasks.some((t) => t.takeover));

  // f) STOP ends the job for good: no 繼續, nothing wakes
  repo = mkRepo();
  ({ env, api } = repoEnv(repo, stdScript('ship', async () => { await new Promise((r) => setTimeout(r, 120)); if (w.run.stopped) throw new env.Halt('已停止'); return 'ok' + String.fromCharCode(10) + 'STATUS: DONE'; })));
  w = mkW(repo); env.S.workspaces.push(w);
  await api.planPhase(w);
  assert.ok(await waitFor(() => w.tasks[0]?.status === 'WORKING'));
  api.stop(w);
  assert.ok(await waitFor(() => w.tasks[0].status === 'FAILED' && !nfs.existsSync(repo.lock)), 'stopped: the card ends and the lock is released');
  assert.strictEqual(w.tasks[0].status, 'FAILED'); assert.strictEqual(w.tasks[0].result, '已停止');
  await assert.rejects(api.resume(w), /已經停止，不能繼續/);
  await new Promise((r) => setTimeout(r, 400)); // let background git calls finish before the temporary repos go (Windows keeps a folder busy while git runs in it)
  for (const d of tmpRepos) nfs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  console.log('14 one writer per tree + lock file + outside writer + changed-while-away + pause / stop meaning: PASS');

  // 15) Workspace lease + handoff + restart safety (cases A-J; real git repos, leases persisted in a file, "restart" = new Studio memory + the same file)
  const realExec = (cmd, args, opts, cb) => require('child_process').execFile(cmd, args, opts, cb);
  const DONE = 'ok' + String.fromCharCode(10) + 'STATUS: DONE';
  const mkGate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const mkCard = (wk, agent, title, extra = {}) => { const t = { id: nodeCrypto.randomUUID().slice(0, 8), title, instructions: 'do it', agent, status: 'WAITING', writes: true, after: [], result: '', ...extra }; wk.tasks.push(t); return t; };
  const startJob = (apiX, wk, id) => { wk.run.id = id; wk.run.phase = 'working'; wk.run.startedAt = new Date().toISOString(); apiX.pump(wk); };
  const leaseEnv = (script, rt, extra = {}) => { const m = makeEnv(script, { RT: rt, execFile: realExec, ...extra }); m.api.loadLeases(); return m; };
  const writeLeases = (envX) => envX.S.leases.filter((l) => l.mode === 'write' && l.status !== 'RELEASED');
  const jobOf = (repo, leaderId = 'claude') => { const x = mkW(repo); x.leader = leaderId; x.run.leader = leaderId; return x; };
  const savedRuns = [];
  const keepRuns = { saveRun: (wk, status) => savedRuns.push({ status, run: JSON.parse(JSON.stringify(wk.run)), tasks: JSON.parse(JSON.stringify(wk.tasks)) }) };

  // A) same working tree: a second writer is refused, nothing is written; it goes once the first is done
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), g1 = mkGate(); const ran = [];
    const E = leaseEnv(async (agent, text) => { if (!text.includes('Task: ')) return '{"done":true,"report":"ok"}'; ran.push(agent); if (agent === 'codex') await g1.p; if (agent === 'claude') nfs.writeFileSync(npath.join(repo.d, 'claude-was-here.txt'), 'x'); return DONE; }, rt);
    const w1 = jobOf(repo), w2 = jobOf(repo, 'antigravity'); E.env.S.workspaces.push(w1, w2);
    const c1 = mkCard(w1, 'codex', 'edit pdf'), c2 = mkCard(w2, 'claude', 'claude edit');
    startJob(E.api, w1, 'j1');
    assert.ok(await waitFor(() => c1.status === 'WORKING' && writeLeases(E.env).length === 1), 'Codex holds the write lease');
    startJob(E.api, w2, 'j2');
    assert.ok(await waitFor(() => c2.status === 'WAITING' && c2.blocked), 'Claude is refused');
    assert.deepStrictEqual([c2.blocked.owner, c2.blocked.card, c2.blocked.state], ['Codex', 'edit pdf', 'ACTIVE']);
    assert.ok(/此工作區目前由 Codex 使用中/.test(c2.blockReason) && c2.blockReason.includes('edit pdf'), 'the message names who and which card');
    assert.ok(!ran.includes('claude') && !nfs.existsSync(npath.join(repo.d, 'claude-was-here.txt')), 'the second writer never started and wrote nothing');
    g1.open(); assert.ok(await waitFor(() => c1.status === 'DONE'));
    assert.ok(await waitFor(() => c2.status === 'DONE'), 'goes by itself as soon as the first writer gave the lease back');
    assert.ok(await waitFor(() => writeLeases(E.env).length === 0), 'the lease is given back when the card ends');
  }

  // B) a reader (review) runs alongside the writer and takes no write lease
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), g1 = mkGate(), g2 = mkGate();
    const E = leaseEnv(async (agent) => { await (agent === 'codex' ? g1.p : g2.p); return DONE; }, rt);
    const w1 = jobOf(repo), w2 = jobOf(repo, 'claude'); E.env.S.workspaces.push(w1, w2);
    const c1 = mkCard(w1, 'codex', 'edit'), r1 = mkCard(w2, 'antigravity', 'review', { writes: false });
    startJob(E.api, w1, 'j1'); assert.ok(await waitFor(() => c1.status === 'WORKING' && writeLeases(E.env).length === 1));
    startJob(E.api, w2, 'j2'); assert.ok(await waitFor(() => r1.status === 'WORKING' && E.env.S.leases.some((l) => l.mode === 'read')), 'the reviewer runs at the same time');
    assert.deepStrictEqual(writeLeases(E.env).map((l) => l.owner.agent), ['codex']);
    assert.ok(E.env.S.leases.some((l) => l.mode === 'read' && l.owner.agent === 'antigravity' && l.status === 'ACTIVE'), 'recorded as a read lease');
    g1.open(); g2.open(); assert.ok(await waitFor(() => c1.status === 'DONE' && r1.status === 'DONE'));
  }

  // C) handoff Codex -> Claude, D) restart afterwards
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), gClaude = mkGate(); const turnsBy = [];
    let wk;
    const E = leaseEnv(async (agent) => {
      turnsBy.push(agent);
      if (agent === 'codex') { for (let i = 0; i < 200 && !wk.tasks[0].interrupted; i++) await new Promise((r) => setTimeout(r, 15)); return ''; }
      await gClaude.p; return DONE;
    }, rt, keepRuns);
    wk = jobOf(repo); E.env.S.workspaces.push(wk);
    const c = mkCard(wk, 'codex', 'fix PR 91');
    startJob(E.api, wk, 'jc'); assert.ok(await waitFor(() => c.status === 'WORKING' && writeLeases(E.env).length === 1));
    const before = JSON.parse(JSON.stringify({ run: wk.run, tasks: wk.tasks }));
    const res = await E.api.handoffWriter(wk, 'claude');
    assert.strictEqual(res.to, 'claude');
    assert.ok(await waitFor(() => c.agent === 'claude' && c.status === 'WORKING' && writeLeases(E.env).length === 1), 'Claude is the only writer now');
    assert.strictEqual(writeLeases(E.env)[0].owner.agent, 'claude');
    const codexLease = E.env.S.leases.find((l) => l.owner.agent === 'codex');
    assert.ok(codexLease.status === 'RELEASED' && /交接給 Claude/.test(codexLease.reason), 'the Codex lease was released by the handoff');
    assert.deepStrictEqual(c.handoffs.map((h) => h.from + '>' + h.to), ['codex>claude']);
    assert.ok(wk.run.convs['codex:work'], 'the Codex conversation is kept');
    const info = await E.api.workspaceOf(repo.d);
    const again = await E.api.acquireWrite(wk, { id: c.id, title: c.title, agent: 'codex' }, info);
    assert.strictEqual(again.ok, false, 'Codex cannot take the writer role back');
    const codexTurns = turnsBy.filter((a) => a === 'codex').length;
    gClaude.open(); assert.ok(await waitFor(() => c.status === 'DONE'));
    assert.strictEqual(turnsBy.filter((a) => a === 'codex').length, codexTurns, 'Codex never runs again after the handoff');
    // D) restart: the old (pre-handoff) record of the job must not bring Codex back to life
    const rt2 = rt; const ran2 = [];
    const wkPaused = jobOf(repo); wkPaused.run = { ...before.run, paused: true, active: false }; wkPaused.tasks = before.tasks.map((t) => ({ ...t, status: 'PAUSED' }));
    const E1b = leaseEnv(async () => DONE, mkTmp('lease-rt-'));
    // lease file of a Studio that handed the paused card to Claude and was then closed
    const rtD = mkTmp('lease-rt-'); const repoD = mkRepo(); let wD;
    const ED1 = leaseEnv(async () => DONE, rtD, keepRuns);
    wD = jobOf(repoD); ED1.env.S.workspaces.push(wD);
    const cD = mkCard(wD, 'codex', 'fix', { status: 'PAUSED' }); wD.run.id = 'jd'; wD.run.paused = true; wD.run.active = false; wD.run.phase = 'working'; wD.run.startedAt = new Date().toISOString();
    const infoD = await ED1.api.workspaceOf(repoD.d);
    const lD = ED1.api.newLease(wD, cD, infoD, 'write'); lD.status = 'RESERVED'; ED1.api.saveLeases();
    const oldRecord = JSON.parse(JSON.stringify({ run: wD.run, tasks: wD.tasks }));
    await ED1.api.handoffWriter(wD, 'claude'); // the paused card (and its reservation) moves to Claude
    assert.ok(writeLeases(ED1.env).length === 1 && writeLeases(ED1.env)[0].owner.agent === 'claude' && writeLeases(ED1.env)[0].status === 'RESERVED', 'the reservation moved to Claude');
    const ED2 = leaseEnv(async (agent) => { ran2.push(agent); return DONE; }, rtD); // restart: new memory, same lease file
    const wD2 = jobOf(repoD); ED2.env.S.workspaces.push(wD2); wD2.run = { ...oldRecord.run, paused: true, active: false }; wD2.tasks = oldRecord.tasks; // stale record: the card still says Codex
    await assert.rejects(ED2.api.resume(wD2), /工作區已由另一個 Agent 接手，本工作保持暫停/);
    assert.strictEqual(ran2.length, 0, 'nothing runs after the restart');
    assert.ok(writeLeases(ED2.env).every((l) => l.owner.agent === 'claude'), 'the writer is still Claude');
  }

  // E) STOP: the job ends for good, the lease is released, a restart does not bring it back
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; const ran = [];
    savedRuns.length = 0;
    const E = leaseEnv(async (agent) => { ran.push(agent); for (let i = 0; i < 100 && !wk.run.stopped; i++) await new Promise((r) => setTimeout(r, 15)); throw new E0.env.Halt('已停止'); }, rt, keepRuns);
    var E0 = E;
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'long edit');
    startJob(E.api, wk, 'je'); assert.ok(await waitFor(() => c.status === 'WORKING' && writeLeases(E.env).length === 1));
    E.api.stop(wk);
    assert.ok(await waitFor(() => c.status === 'FAILED' && writeLeases(E.env).length === 0), 'stopped: lease released, card kept');
    assert.strictEqual(c.result, '已停止');
    assert.ok(savedRuns.some((r) => r.status === 'stopped'), 'the record is saved as stopped (not resumable)');
    const ranAfter = ran.length;
    const E2 = leaseEnv(async (agent) => { ran.push(agent); return DONE; }, rt); // restart
    const w2 = jobOf(repo); E2.env.S.workspaces.push(w2); const rec = savedRuns.find((r) => r.status === 'stopped'); w2.run = { ...rec.run, active: false, paused: false }; w2.tasks = rec.tasks;
    await assert.rejects(E2.api.resume(w2), /已經停止，不能繼續/);
    assert.strictEqual(ran.length, ranAfter, 'the stopped job does not run again'); assert.strictEqual(writeLeases(E2.env).length, 0);
  }

  // F) PAUSE: card + conversation kept, the lease is RESERVED (still the owner's), resume re-checks ownership
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; let runs = 0;
    const E = leaseEnv(async (agent) => { if (++runs === 1) { for (let i = 0; i < 100 && !wk.run.paused; i++) await new Promise((r) => setTimeout(r, 15)); throw new E.env.Halt('已暫停'); } return DONE; }, rt);
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'pausable');
    startJob(E.api, wk, 'jf'); assert.ok(await waitFor(() => c.status === 'WORKING' && writeLeases(E.env).length === 1 && wk.run.convs['codex:work'] && runs === 1));
    E.api.pause(wk);
    assert.ok(await waitFor(() => c.status === 'PAUSED' && writeLeases(E.env)[0]?.status === 'RESERVED'), 'paused: the lease is RESERVED, not released');
    assert.ok(wk.run.convs['codex:work'] && wk.tasks.includes(c), 'conversation and card are kept');
    const w2 = jobOf(repo, 'antigravity'); E.env.S.workspaces.push(w2); const c2 = mkCard(w2, 'claude', 'intruder'); startJob(E.api, w2, 'jf2');
    assert.ok(await waitFor(() => c2.status === 'WAITING' && c2.blocked?.state === 'RESERVED'), 'nobody else can slip in while it is paused');
    await E.api.claimWorkspace(repo.d, { label: 'Claude session', pid: process.pid }); // ownership changes while paused
    await assert.rejects(E.api.resume(wk), /工作區已由外部 Agent 接手，本工作保持暫停/);
    await E.api.releaseClaim(repo.d);
    await E.api.resume(wk); assert.ok(await waitFor(() => c.status === 'DONE'), 'after the claim is gone the owner resumes (re-checked)');
  }

  // G) stale lease: crashed Studio (dead pid) is reclaimed; a live other Studio / a RESERVED one is not
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo();
    const E0 = leaseEnv(async () => DONE, rt); const wk0 = jobOf(repo); E0.env.S.workspaces.push(wk0);
    const info = await E0.api.workspaceOf(repo.d);
    const mk = (extra) => ({ id: 'old' + Math.random().toString(16).slice(2, 6), key: info.key, path: info.path, repo: '', branch: 'main', mode: 'write', owner: { kind: 'studio', agent: 'codex' }, jobId: 'x', cardId: 'y', cardTitle: 'old', status: 'ACTIVE', acquiredAt: new Date(Date.now() - 3600e3).toISOString(), heartbeatAt: new Date(Date.now() - 3600e3).toISOString(), instance: 'dead0000', pid: 2147483000, ...extra });
    const run = (leases) => { nfs.writeFileSync(npath.join(rt, 'studio', 'leases.json'), JSON.stringify(leases)); const E = leaseEnv(async () => DONE, rt); const wk = jobOf(repo); E.env.S.workspaces.push(wk); return { E, wk, c: mkCard(wk, 'claude', 'new writer') }; };
    nfs.mkdirSync(npath.join(rt, 'studio'), { recursive: true });
    // crashed: ACTIVE, owner pid dead -> STALE -> reclaimed
    let x = run([mk({})]); let r = await x.E.api.acquireWrite(x.wk, x.c, info); assert.strictEqual(x.E.api.leaseState(x.E.env.S.leases.find((l) => l.id.startsWith('old'))), 'RELEASED'); assert.ok(r.ok, 'a stale lease is reclaimed');
    assert.ok(/stale/.test(x.E.env.S.leases.find((l) => l.id.startsWith('old')).reason));
    // the old writer is clearly alive (its pid is running, heartbeat fresh): never taken over
    x = run([mk({ pid: process.pid, instance: 'other-studio', heartbeatAt: new Date().toISOString() })]); r = await x.E.api.acquireWrite(x.wk, x.c, info); assert.strictEqual(r.ok, false, 'a live writer is never taken over');
    // a pause reservation of a closed Studio is kept (it is the owner's); it only expires after a long time
    x = run([mk({ status: 'RESERVED' })]); r = await x.E.api.acquireWrite(x.wk, x.c, info); assert.strictEqual(r.ok, false, 'RESERVED is kept');
    x = run([mk({ status: 'RESERVED', heartbeatAt: new Date(Date.now() - 20 * 3600e3).toISOString() })]); r = await x.E.api.acquireWrite(x.wk, x.c, info); assert.ok(r.ok, 'an ancient RESERVED lease of a gone Studio expires');
    // an external claim whose process is gone is stale too
    x = run([mk({ owner: { kind: 'external', label: 'gone' }, pid: 2147483000, status: 'ACTIVE' })]); r = await x.E.api.acquireWrite(x.wk, x.c, info); assert.ok(!r.ok, 'external ownership requires explicit release even after its process exits');
  }

  // H) different worktrees of one repository: each has its own writer
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), g = mkGate();
    const wtDir = npath.join(nos.tmpdir(), 'studio-wt-' + nodeCrypto.randomUUID().slice(0, 6)); tmpRepos.push(wtDir);
    repo.g('worktree', 'add', '-q', '-b', 'branch-b', wtDir);
    const E = leaseEnv(async () => { await g.p; return DONE; }, rt);
    const w1 = jobOf(repo), w2 = jobOf({ d: wtDir }, 'antigravity'); E.env.S.workspaces.push(w1, w2);
    const c1 = mkCard(w1, 'codex', 'in main tree'), c2 = mkCard(w2, 'claude', 'in worktree B');
    startJob(E.api, w1, 'jh1'); startJob(E.api, w2, 'jh2');
    assert.ok(await waitFor(() => c1.status === 'WORKING' && c2.status === 'WORKING' && writeLeases(E.env).length === 2), 'both worktrees have a writer at the same time');
    assert.strictEqual(new Set(writeLeases(E.env).map((l) => l.key)).size, 2);
    g.open(); assert.ok(await waitFor(() => c1.status === 'DONE' && c2.status === 'DONE'));
  }

  // I) external takeover: Studio stops, ownership moves to "external", a restart does not bring Codex back
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; const ran = [];
    const E = leaseEnv(async (agent) => { ran.push(agent); for (let i = 0; i < 200 && !wk.run.paused; i++) await new Promise((r) => setTimeout(r, 15)); throw new E.env.Halt('已暫停'); }, rt, keepRuns);
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'codex edit');
    startJob(E.api, wk, 'ji'); assert.ok(await waitFor(() => c.status === 'WORKING' && writeLeases(E.env).length === 1));
    savedRuns.length = 0;
    const claim = await E.api.claimWorkspace(repo.d, { label: 'Claude session (台股選股)', pid: process.pid });
    assert.strictEqual(claim.kind, 'external');
    assert.ok(await waitFor(() => wk.run.paused === true && c.status === 'PAUSED'), 'Studio stopped its writer and paused the job');
    assert.deepStrictEqual(writeLeases(E.env).map((l) => l.owner.kind), ['external'], 'the owner is now external');
    const ranBefore = ran.length;
    const E2 = leaseEnv(async (agent) => { ran.push(agent); return DONE; }, rt); // Studio restart
    const w2 = jobOf(repo); E2.env.S.workspaces.push(w2); w2.run = { ...wk.run, paused: true, active: false }; w2.tasks = JSON.parse(JSON.stringify(wk.tasks));
    await assert.rejects(E2.api.resume(w2), /工作區已由外部 Agent 接手，本工作保持暫停/);
    E2.api.pump(w2); await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(ran.length, ranBefore, 'Codex is not revived by the restart'); assert.deepStrictEqual(writeLeases(E2.env).map((l) => l.owner.kind), ['external']);
  }

  // J) unknown changes while Studio holds the tree: no reset / stash / overwrite, stop writing, flag it
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; let turns = 0;
    const E = leaseEnv(async () => (++turns === 1 ? 'x' + String.fromCharCode(10) + 'STATUS: WAITING_EXTERNAL: CI' : DONE), rt, keepRuns);
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'parked writer');
    startJob(E.api, wk, 'jj'); assert.ok(await waitFor(() => c.status === 'WAITING_EXTERNAL' && wk.run.treeStamp && writeLeases(E.env)[0]?.status === 'RESERVED'));
    nfs.writeFileSync(npath.join(repo.d, 'a.txt'), 'edited by somebody else'); // not Studio's agent
    const headBefore = repo.g('rev-parse', 'HEAD').toString();
    await E.api.checkWorkspaces();
    assert.ok(wk.run.extMod && /沒有在執行/.test(wk.run.extMod.why), 'EXTERNAL_MODIFICATION_DETECTED');
    assert.strictEqual(wk.run.paused, true, 'writing is stopped');
    assert.strictEqual(nfs.readFileSync(npath.join(repo.d, 'a.txt'), 'utf8'), 'edited by somebody else', 'the file was not touched');
    assert.strictEqual(repo.g('stash', 'list').toString().trim(), '', 'no stash'); assert.strictEqual(repo.g('rev-parse', 'HEAD').toString(), headBefore, 'no reset / commit');
    assert.strictEqual(writeLeases(E.env)[0].flag, 'EXTERNAL_MODIFICATION_DETECTED');
    await assert.rejects(E.api.resume(wk), /EXTERNAL_MODIFICATION_DETECTED/);
    await E.api.resume(wk, undefined, { confirmExternal: true }); assert.strictEqual(wk.run.extMod, null, 'confirmed: ownership re-confirmed and writing may continue');
    // while an agent is executing, a cooperating outside lock file is the visible sign of a second writer
    const rt2 = mkTmp('lease-rt-'), repo2 = mkRepo(), g2 = mkGate(); let wk2, running2 = false;
    const E2 = leaseEnv(async (agent, text) => { if (!text.includes('Task: ')) return '{"done":true,"report":"ok"}'; running2 = true; await g2.p; return DONE; }, rt2, keepRuns);
    wk2 = jobOf(repo2); E2.env.S.workspaces.push(wk2); const c2 = mkCard(wk2, 'codex', 'running writer');
    startJob(E2.api, wk2, 'jj2'); assert.ok(await waitFor(() => c2.status === 'WORKING' && running2), 'the agent is executing');
    nfs.writeFileSync(repo2.lock, JSON.stringify({ owner: 'Other Program', instance: 'zz', pid: process.pid, card: 'its edit', beat: new Date().toISOString() }));
    await E2.api.checkWorkspaces();
    assert.ok(wk2.run.extMod && /Other Program/.test(wk2.run.extMod.why), 'a second writer appearing mid-run is flagged'); assert.strictEqual(wk2.run.paused, true);
    g2.open();
  }

  // K) independent worktree for a blocked card; read-only switch; cleanup after merge
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), g1 = mkGate(); const seenDirs = [];
    let wt;
    const E = leaseEnv(async (agent, text) => { if (text.includes('Task: blocked card')) { const m = text.match(/Work only inside this folder: (.+)/); seenDirs.push(m && m[1].trim()); wt = m && m[1].trim(); nfs.writeFileSync(npath.join(wt, 'feature.txt'), 'f'); repo.g('-C', wt, 'add', '.'); repo.g('-C', wt, 'commit', '-q', '-m', 'feature'); repo.g('merge', '-q', '--ff-only', (await E.api.workspaceOf(wt)).branch); return DONE; } await g1.p; return DONE; }, rt);
    const w1 = jobOf(repo), w2 = jobOf(repo, 'antigravity'); E.env.S.workspaces.push(w1, w2);
    const c1 = mkCard(w1, 'codex', 'holder'), c2 = mkCard(w2, 'claude', 'blocked card');
    startJob(E.api, w1, 'jk1'); assert.ok(await waitFor(() => c1.status === 'WORKING' && writeLeases(E.env).length === 1));
    startJob(E.api, w2, 'jk2'); assert.ok(await waitFor(() => c2.status === 'WAITING' && c2.blocked));
    const r = await E.api.useWorktree(w2, c2.id);
    assert.ok(await waitFor(() => c2.status === 'DONE'), 'the blocked card runs in its own worktree at the same time');
    assert.ok(seenDirs[0] && seenDirs[0] !== repo.d && /studio.worktrees/.test(seenDirs[0].split('\\').join('/')), 'it worked in the worktree folder');
    assert.ok(await waitFor(() => c2.worktree?.cleaned === true), 'merged: the worktree and its branch were cleaned up');
    assert.ok(!nfs.existsSync(r.path) && !repo.g('branch', '--list', r.branch).toString().trim(), 'worktree folder and branch are gone');
    g1.open(); assert.ok(await waitFor(() => c1.status === 'DONE'));
    // read-only switch
    const rt3 = mkTmp('lease-rt-'), repo3 = mkRepo(), g3 = mkGate();
    const E3 = leaseEnv(async (agent, text) => { if (agent === 'codex') await g3.p; return DONE; }, rt3);
    const a1 = jobOf(repo3), a2 = jobOf(repo3, 'antigravity'); E3.env.S.workspaces.push(a1, a2);
    const h1 = mkCard(a1, 'codex', 'holder2'), b2 = mkCard(a2, 'claude', 'review me');
    startJob(E3.api, a1, 'jk3'); assert.ok(await waitFor(() => h1.status === 'WORKING' && writeLeases(E3.env).length === 1));
    startJob(E3.api, a2, 'jk4'); assert.ok(await waitFor(() => b2.status === 'WAITING' && b2.blocked));
    E3.api.useReadOnly(a2, b2.id); assert.ok(await waitFor(() => b2.status === 'DONE'), 'switched to read-only, it runs next to the writer'); g3.open();
  }
  console.log('15 workspace lease A-K: same tree blocked, reader allowed, handoff, restart safety, stop, pause, stale, worktrees, external takeover, unknown changes: PASS');

  // 16) review findings of PR #23 (regressions)
  // P1: STOP does not give the lease back until the agent has really stopped
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; let release;
    const E = leaseEnv(async (agent, text) => { if (!text.includes('Task: ')) return '{"done":true,"report":"ok"}'; await new Promise((r) => { release = r; }); throw new E.env.Halt('已停止'); }, rt, keepRuns);
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'winding down');
    startJob(E.api, wk, 'jr1'); assert.ok(await waitFor(() => c.status === 'WORKING' && writeLeases(E.env).length === 1 && release));
    E.api.stop(wk);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(writeLeases(E.env).length, 1, 'the lease is still held while the agent winds down');
    const other = jobOf(repo, 'antigravity'); E.env.S.workspaces.push(other); const oc = mkCard(other, 'claude', 'another writer'); other.run.id = 'jr1b';
    const got = await E.api.acquireWrite(other, oc, await E.api.workspaceOf(repo.d));
    assert.strictEqual(got.ok, false, 'nobody can take the tree before the agent stopped');
    release(); assert.ok(await waitFor(() => c.status === 'FAILED' && writeLeases(E.env).length === 0), 'released once the agent really stopped');
  }
  // P2: pausing while a step winds down: the agent's own edits are not "unknown changes"
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let wk; let release; let first = true;
    const E = leaseEnv(async (agent, text) => { if (!text.includes('Task: ')) return '{"done":true,"report":"ok"}'; if (first) { first = false; nfs.writeFileSync(npath.join(repo.d, 'agent-edit.txt'), 'its own edit'); await new Promise((r) => { release = r; }); throw new E.env.Halt('已暫停'); } return DONE; }, rt, keepRuns);
    wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'pauses');
    startJob(E.api, wk, 'jr2'); assert.ok(await waitFor(() => c.status === 'WORKING' && release));
    E.api.pause(wk); await E.api.checkWorkspaces();
    assert.ok(!wk.run.extMod, 'a step that is winding down is not an outside edit');
    release(); assert.ok(await waitFor(() => c.status === 'PAUSED' && writeLeases(E.env)[0]?.status === 'RESERVED'));
    await E.api.checkWorkspaces(); assert.ok(!wk.run.extMod, 'the tree it left is the new baseline');
  }
  // P2: a pending "may Studio take over?" question is not overtaken by the watcher
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let turns = 0;
    const E = leaseEnv(async (agent, text) => { if (!text.includes('Task: ') && !text.startsWith('Update')) return '{"done":true,"report":"ok"}'; return ++turns === 1 ? 'x' + String.fromCharCode(10) + 'STATUS: WAITING_EXTERNAL: CI' : DONE; }, rt, keepRuns);
    const wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'asks first');
    startJob(E.api, wk, 'jr3'); assert.ok(await waitFor(() => c.status === 'WAITING_EXTERNAL' && wk.run.treeStamp));
    repo.g('commit', '-q', '--allow-empty', '-m', 'meanwhile'); E.api.wake(wk, c, 'CI finished');
    assert.ok(await waitFor(() => c.status === 'NEEDS_USER' && c.takeover));
    await E.api.checkWorkspaces();
    assert.ok(!wk.run.extMod && wk.run.active, 'the watcher leaves the question alone');
    E.api.answer(wk, c.id, '確認接手，繼續'); assert.ok(await waitFor(() => c.status === 'DONE'), 'the user can still answer it');
  }
  // P2: a lease the card already owned stays RESERVED when it has to wait again
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(); let turns = 0;
    const E = leaseEnv(async (agent, text) => { if (!text.includes('Task: ') && !text.startsWith('Update')) return '{"done":true,"report":"ok"}'; return ++turns === 1 ? 'x' + String.fromCharCode(10) + 'STATUS: WAITING_EXTERNAL: CI' : DONE; }, rt, keepRuns);
    const wk = jobOf(repo); E.env.S.workspaces.push(wk); const c = mkCard(wk, 'codex', 'keeps its lease');
    startJob(E.api, wk, 'jr4'); assert.ok(await waitFor(() => c.status === 'WAITING_EXTERNAL' && wk.run.leftAt && writeLeases(E.env)[0]?.status === 'RESERVED'));
    await new Promise((r) => setTimeout(r, 30)); nfs.writeFileSync(npath.join(repo.d, 'typing.txt'), 'someone is editing now');
    E.api.wake(wk, c, 'CI finished');
    assert.ok(await waitFor(() => /秒前有檔案被改過/.test(c.blockReason || '')));
    assert.deepStrictEqual(writeLeases(E.env).map((l) => l.status), ['RESERVED'], 'the owner keeps its reservation while it waits');
    const other = jobOf(repo, 'antigravity'); E.env.S.workspaces.push(other); const oc = mkCard(other, 'claude', 'intruder'); other.run.id = 'jr4b';
    assert.strictEqual((await E.api.acquireWrite(other, oc, await E.api.workspaceOf(repo.d))).ok, false, 'nobody else slips in');
  }
  // P2: two Studios sharing one lease file see each other and never overwrite each other's records
  {
    const rt = mkTmp('lease-rt-'), repo = mkRepo(), g = mkGate();
    const A = leaseEnv(async () => { await g.p; return DONE; }, rt), B = leaseEnv(async () => DONE, rt); // B loaded the (empty) file before A took the tree
    const wa = jobOf(repo), wb = jobOf(repo, 'antigravity'); A.env.S.workspaces.push(wa); B.env.S.workspaces.push(wb);
    const ca = mkCard(wa, 'codex', 'A writes'), cb = mkCard(wb, 'claude', 'B wants in');
    startJob(A.api, wa, 'jr5a'); assert.ok(await waitFor(() => ca.status === 'WORKING' && writeLeases(A.env).length === 1));
    wb.run.id = 'jr5b';
    const got = await B.api.acquireWrite(wb, cb, await B.api.workspaceOf(repo.d));
    assert.strictEqual(got.ok, false, 'B sees the lease A took, although B loaded the file before');
    B.api.saveLeases();
    const onDisk = JSON.parse(nfs.readFileSync(npath.join(rt, 'studio', 'leases.json'), 'utf8'));
    assert.ok(onDisk.some((l) => l.owner.agent === 'codex' && l.status === 'ACTIVE'), "B's save kept A's record");
    g.open(); assert.ok(await waitFor(() => ca.status === 'DONE'));
  }
  console.log('16 review findings (stop timing, pause wind-down, takeover question, kept reservation, two Studios): PASS');

  await require('./test-workspace-lease.cjs')({ makeEnv, mkTmp, region });

  // status-line parser
  const { parseStatus } = api;
  assert.deepStrictEqual([parseStatus('Built.\nSTATUS: DONE').kind, parseStatus('Built.\nSTATUS: DONE').text], ['DONE', 'Built.']);
  assert.strictEqual(parseStatus('x\n**STATUS:** WAITING_AGENT: antigravity: review').detail, 'antigravity: review');
  assert.deepStrictEqual(parseStatus('x\nSTATUS：NEEDS_USER：A 還是 B？\nOPTIONS: A | B').options, ['A', 'B']);
  assert.strictEqual(parseStatus('no status here'), null);
  console.log('6 status-line parser: PASS');
  await require('./test-runtime.cjs').runRuntimeTests();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [...TMP_DIRS, ...tmpRepos]) { try { require('fs').rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch { /* temp folder still in use */ } }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
