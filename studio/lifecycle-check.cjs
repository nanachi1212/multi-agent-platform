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
    label: () => 'TestProj', refreshClaudeLimits() {}, saveRun() {}, saveSettings() {}, latestJob: () => null,
    Halt: class extends Error {}, active: new Map(), busyConvs: () => [], cancelTurn() {}, convAgent: new Map(),
    available: () => true, workersFor: (w, lead) => w.workers.filter((x) => x !== lead),
    conv: async (w, agent, lead) => agent + (lead ? ':lead' : ':work'),
    turn: async (agent, cid, text) => { prompts.push({ agent, text }); await new Promise((r) => setTimeout(r, 5)); return script(agent, text); },
    execFile: (cmd, args, opts, cb) => cb(new Error('no git / gh in test'), '', ''), isDir: () => true, readHistory() {}, openWorkspace() {}, wsOf() {},
  };
  const names = Object.keys(env);
  const api = new Function(...names, code + '\nreturn { planPhase, pump, summarize, answer, continueCard, wake, parseStatus, finish };')(...names.map((k) => env[k])); // test harness: our own code
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
  // status-line parser
  const { parseStatus } = api;
  assert.deepStrictEqual([parseStatus('Built.\nSTATUS: DONE').kind, parseStatus('Built.\nSTATUS: DONE').text], ['DONE', 'Built.']);
  assert.strictEqual(parseStatus('x\n**STATUS:** WAITING_AGENT: antigravity: review').detail, 'antigravity: review');
  assert.deepStrictEqual(parseStatus('x\nSTATUS：NEEDS_USER：A 還是 B？\nOPTIONS: A | B').options, ['A', 'B']);
  assert.strictEqual(parseStatus('no status here'), null);
  console.log('6 status-line parser: PASS');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
