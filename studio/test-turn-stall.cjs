// The real turn(): a silent step is extended only on positive evidence that its command is alive, at most
// STALL_EXTENSIONS times; without a running command, or without evidence, it stops exactly as before.
// Run: node studio/test-turn-stall.cjs   (fake clock, scripted AionCore, no agents)
const assert = require('node:assert/strict');
const { region } = require('./lifecycle-harness.cjs');

(async () => {
  const { processTree } = await import('./codex-runtime.mjs');
  const code = region('// Changes whenever the agent adds or updates a message', '// ---------- External provider operations ----------');
  let now = 1e9; const realNow = Date.now; Date.now = () => now;
  const AION = { pid: 1, parent: 0, creationDate: '/Date(10)/', executable: 'C:\\aioncore.exe' }; // creation times are non-zero: codex-runtime treats 0 as unknown
  const proc = (pid, parent, cpu, extra = {}) => ({ pid, parent, creationDate: '/Date(20)/', executable: 'x.exe', cpu, ...extra });
  const mk = (o = {}) => {
    const logs = [], calls = { stop: 0, snapshots: 0, sleeps: 0 };
    let messages = o.messages || [], runtime = { state: 'processing', is_processing: true };
    const env = {
      applyTurnModel: async () => {}, AGENTS: { codex: {}, claude: {} }, tierCfg: () => ({}),
      api: async (m, p, b) => (o.onApi?.(m, p, b), p.endsWith('/messages')) ? { items: messages } : p.endsWith('/usage') ? null : { runtime },
      clip: (s, n) => String(s).slice(0, n), toolText: (c) => c?.name || '', isAskAnswer: () => false,
      sendMessage: async () => ({ turn_id: 't1', msg_id: 'm0' }), active: new Map(), S: { agents: { codex: { working: 0 }, claude: { working: 0 } } },
      sleep: async (ms) => { now += ms; o.onSleep?.(++calls.sleeps, self); },
      codexRuntime: { prepare: async () => {}, stop: async () => true, trees: (cid, rows) => rows.filter((r) => r.conv && (!cid || r.conv === cid)).map((r) => ({ pid: r.pid })) },
      answerConfirmations: async () => {}, stopTurn: async () => { calls.stop++; runtime = { state: 'idle', is_processing: false }; return true; }, Halt: class extends Error {},
      log: (w, who, role, text) => logs.push(text), refreshCodexLimits() {}, chargeUsage() {}, usageDelta: () => null, usageOf: async () => null,
      agentName: (a) => a, recentEdit: async () => o.recent ?? null, processSnapshot: async () => { calls.snapshots++; return o.rows ? o.rows(calls.snapshots) : []; }, aionProcess: AION, processTree,
    };
    const names = Object.keys(env);
    const api = new Function(...names, code + '\nreturn { turn, stepEvidence, STALL_EXTENSIONS, EVIDENCE_WAIT_MS, steers };')(...names.map((k) => env[k]));
    const self = { api, logs, calls, setMessages: (m) => { messages = m; }, finish: (text) => { messages = [...messages, { id: 'r', type: 'text', position: 'left', status: 'finish', content: { content: text } }]; runtime = { state: 'idle', is_processing: false }; } };
    return self;
  };
  const w = { run: { active: true }, project: 'P' };
  const running = [{ id: 'u', type: 'text', status: 'finish' }, { id: 'tc', type: 'tool_call', status: 'running', content: { name: 'npm test' } }];
  const streaming = [{ id: 'u', type: 'text', status: 'finish' }, { id: 'a', type: 'text', status: 'running', content: { content: 'thinking' } }];
  const codexRows = (cpuAt) => (n) => [AION, proc(2, 1, cpuAt(n), { conv: 'c1' })];
  const stalls = (e) => e.timeout && /分鐘沒有任何新進度/.test(e.message);

  { // evidence twice, then none: two extensions, then the step is stopped
    const t = mk({ messages: running, rows: codexRows((n) => [10, 20, 20, 30, 30, 30][n - 1]) });
    await assert.rejects(t.api.turn('codex', 'c1', 'go', { w, timeout: 300e3, bill: { workdir: '' } }), stalls);
    assert.deepStrictEqual([t.calls.stop, t.calls.snapshots, t.logs.filter((l) => /再等 5 分鐘（第 [12]\/3 次）/.test(l)).length, t.logs.filter((l) => l.includes('停止這一步')).length], [1, 6, 2, 1]);
    assert.ok(t.logs[0].includes('已 5 分鐘沒有新訊息') && t.logs[0].includes('CPU'), t.logs[0]);
  }
  { // always alive: the cap holds
    const t = mk({ messages: running, rows: codexRows((n) => n * 10) });
    await assert.rejects(t.api.turn('codex', 'c1', 'go', { w, timeout: 300e3, bill: { workdir: '' } }), stalls);
    assert.deepStrictEqual([t.calls.stop, t.calls.snapshots, t.logs.filter((l) => l.includes('再等')).length], [1, 2 * t.api.STALL_EXTENSIONS, t.api.STALL_EXTENSIONS]);
    assert.ok(t.logs.at(-1).includes('第 3/3 次'), 'the last extension says it is the last');
  }
  { // no command running (the model is silent): stopped at the first timeout, no process lookups
    const t = mk({ messages: streaming, rows: codexRows(() => 99) });
    await assert.rejects(t.api.turn('codex', 'c1', 'go', { w, timeout: 300e3, bill: { workdir: '' } }), stalls);
    assert.deepStrictEqual([t.calls.stop, t.calls.snapshots, t.logs.length], [1, 0, 0]);
  }
  { // extended once, then real progress arrives and the step finishes normally
    const t = mk({ messages: running, rows: (n) => [AION, proc(2, 1, n * 10, { conv: 'c1' })],
      onSleep: (k, self) => { if (k === 250) self.setMessages([...running, { id: 'tc2', type: 'tool_call', status: 'running', content: { name: 'npm run build' } }]); if (k === 260) self.finish('All green.\nSTATUS: DONE'); } });
    assert.strictEqual(await t.api.turn('codex', 'c1', 'go', { w, timeout: 300e3, bill: { workdir: '' } }), 'All green.\nSTATUS: DONE');
    assert.deepStrictEqual([t.calls.stop, t.logs.filter((l) => l.includes('再等')).length], [0, 1]);
  }
  { // 插話: a queued note is POSTed into the running turn (no stop, no new step); one still queued when the turn ends goes back to the card
    const posts = [], back = [];
    const t = mk({ messages: streaming, onApi: (m, p, b) => { if (m === 'POST') posts.push(b.content); },
      onSleep: (k, self) => { if (k === 2) self.api.steers.set('c1', { notes: ['use blue'], fallback: (n) => back.push(...n) }); if (k === 4) { self.api.steers.get('c1').notes.push('and bold'); self.finish('Blue.\nSTATUS: DONE'); } } });
    assert.strictEqual(await t.api.turn('codex', 'c1', 'go', { w }), 'Blue.\nSTATUS: DONE');
    assert.deepStrictEqual([posts.length, posts[0].includes('use blue'), back, t.calls.stop, t.api.steers.has('c1')], [1, true, ['and bold'], 0, false]);
    assert.ok(t.logs.some((l) => l.includes('插進')), 'logged');
  }
  { // stepEvidence: file activity, process selection, cpu / child / nothing / unreadable
    const ev = (o, agent = 'claude', dir = 'D') => mk(o).api.stepEvidence(agent, 'c1', w, dir, { pause: async () => {} });
    assert.deepStrictEqual(await ev({ recent: { secs: 7, file: 'dist/app.js' } }), { alive: true, why: '7 秒前還有檔案在變（dist/app.js）' });
    assert.deepStrictEqual((await ev({ rows: () => [AION] })).alive, false, 'nothing under AionCore');
    assert.match((await ev({ rows: () => [AION] })).why, /找不到/);
    assert.deepStrictEqual((await ev({ rows: (n) => [AION, proc(2, 1, 5)] })).alive, false, 'same cpu, same children');
    assert.match((await ev({ rows: (n) => [AION, proc(2, 1, n === 1 ? 5 : 9)] })).why, /CPU/);
    assert.match((await ev({ rows: (n) => n === 1 ? [AION, proc(2, 1, 5)] : [AION, proc(2, 1, 5), proc(3, 2, 0)] })).why, /子程序/);
    assert.deepStrictEqual((await ev({ rows: (n) => [AION, proc(2, 1, 5), proc(3, 1, n * 10, { conv: 'c9' })] })).alive, false, 'a Codex session busy elsewhere is not evidence for a Claude step');
    assert.deepStrictEqual((await ev({ rows: (n) => [AION, proc(2, 1, 5), proc(3, 1, n * 10, { conv: 'c1' })] }, 'codex')).alive, true, 'the Codex step sees its own session');
    assert.deepStrictEqual((await ev({ rows: (n) => [AION, proc(2, 1, n * 10), proc(3, 1, 5, { conv: 'c1' })] }, 'codex')).alive, false, 'the Codex step ignores the other agents');
    assert.deepStrictEqual((await ev({ rows: (n) => [AION, proc(2, 1, n * 10)] }, 'claude', '')).alive, true, 'no folder: process evidence still counts');
    assert.match((await ev({ rows: () => { throw new Error('CIM down'); } })).why, /無法讀取程序清單/);
    assert.deepStrictEqual((await ev({ rows: (n) => [{ ...AION, creationDate: '/Date(5)/' }, proc(2, 1, n * 10)] })).alive, false, 'an AionCore identity that no longer matches owns nothing');
  }
  Date.now = realNow;
  console.log('turn stall evidence: extensions on cpu/child/file evidence, cap, silent model, recovery, session selection, steer: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
