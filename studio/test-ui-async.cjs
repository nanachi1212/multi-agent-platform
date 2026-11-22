// Async UI and routine cancellation regressions: source extraction, no providers or IO writes.
const fs = require('node:fs');
const finished = require.main === module ? require('./test-finish.cjs')('UI async') : () => {};
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
const fn = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\s*\\([\\s\\S]*?\\r?\\n\\}`))[0];
async function testExternalModelDialog() {
  const el = Object.fromEntries([...html.matchAll(/id="(ext\w+)"/g)].map(([, id]) => [id, { value: '', textContent: '', innerHTML: '' }]));
  Object.assign(el.extDlg, { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const requests = [], refreshed = [];
  const ctx = vm.createContext({
    $: id => el[id], S: { external: ['A', 'B'].map(id => ({ id, name: id, baseUrl: 'https://' + id + '.test', model: id + '-manual' })) },
    esc: value => value, refresh: () => refreshed.push(true),
    fetch: (url, options) => new Promise(resolve => requests.push({ url, body: JSON.parse(options.body), resolve })),
  });
  vm.runInContext(html.slice(html.indexOf('let extEditId'), html.indexOf('function seatHtml')) +
    html.slice(html.indexOf("$('extClose').onclick"), html.indexOf("$('histResume').onclick")), ctx);
  const start = (button = 'extFetch') => {
    const pending = el[button].onclick(), request = requests.at(-1);
    return { id: request.body.id, async finish(data, ok = true) { request.resolve({ ok, status: ok ? 200 : 400, json: async () => data }); await pending; } };
  };

  ctx.extOpen('A'); const a = start(); el.extClose.onclick();
  ctx.extOpen('B'); const b = start();
  assert.deepEqual([a.id, b.id], ['A', 'B']);
  await b.finish(['B-01']); await a.finish(['A-01']);
  assert.equal(el.extModels.innerHTML, '<option value="B-01">', 'late A response must leave B’s model list intact');
  assert.equal(el.extModel.value, 'B-manual');
  const old = start(), latest = start();
  await latest.finish(['B-02']); const note = el.extFetchNote.textContent;
  await old.finish({ error: 'stale lookup error' }, false);
  assert.equal(el.extModels.innerHTML, '<option value="B-02">');
  assert.equal(el.extFetchNote.textContent, note); assert.equal(el.extErr.textContent, '');

  for (const id of ['extPlatform', 'extUrl', 'extKey', 'extFull']) {
    ctx.extOpen('B'); await start().finish(['old']);
    const pending = start();
    if (id === 'extFull') el[id].checked = !el[id].checked; else el[id].value = 'changed';
    el[id].oninput();
    assert.equal(el.extModels.innerHTML, '', id + ' discards the old suggestions immediately');
    await pending.finish(['stale']);
    assert.equal(el.extModels.innerHTML, ''); assert.equal(el.extFetchNote.textContent, '');
  }
  ctx.extOpen(''); const escaped = start(); el.extDlg.close(); // native Escape
  await escaped.finish(['closed']); assert.equal(el.extModels.innerHTML, '');
  ctx.extOpen(''); await start().finish({ error: 'current lookup error' }, false);
  assert.ok((el.extFetchNote.textContent + el.extErr.textContent).includes('current lookup error'));

  ctx.extOpen('A'); const saveA = start('extSave'); el.extClose.onclick(); ctx.extOpen('B');
  assert.equal(el.extSave.disabled, false);
  const saveB = start('extSave'); await saveA.finish({});
  assert.ok(el.extDlg.open); assert.equal(el.extSave.disabled, true, 'A cannot close or enable B’s pending save');
  assert.equal(refreshed.length, 1, 'a completed save still refreshes the overview');
  await saveB.finish({ error: 'B save failed' }, false);
  assert.ok(el.extDlg.open); assert.equal(el.extSave.disabled, false); assert.equal(el.extErr.textContent, 'B save failed');
  console.log('External model dialog: reversed A/B replies, edited sources, stale errors and saves: PASS');
}
async function run() {
  await testExternalModelDialog();
  const els = Object.fromEntries(['histTitle', 'histMeta', 'histBoard', 'histChat', 'histResume'].map(x => [x, {}]));
  let onCancel;
  els.histDlg = { opens: 0, showModal() { this.opens++; }, close() {}, addEventListener(type, handler) { assert.equal(type, 'cancel'); onCancel = handler; } };
  const pending = [];
  const h = { historyOpenSeq: 0, histOpenId: null, histOpenProject: '', S: { agents: [], workspaces: [] }, $: x => els[x],
    fetch: () => new Promise(r => pending.push(r)), fmt: x => x, esc: x => x, name: x => x, STATUS: {},
    sameP: (a, b) => a === b, boardHtml: JSON.stringify, chatHtml: JSON.stringify };
  vm.createContext(h); vm.runInContext(fn(html, 'openHistory') + '\n' + fn(html, 'closeHistory'), h);
  vm.runInContext(html.match(/^\$\('histDlg'\)\.addEventListener\('cancel'.*$/m)[0], h);
  const reply = (i, id) => pending[i]({ json: async () => ({ project: id, startedAt: id, request: id, status: 'paused', tasks: [], activity: [] }) });
  const a = h.openHistory('A'), b = h.openHistory('B'); reply(1, 'B'); await b; reply(0, 'A'); await a;
  assert.equal(h.histOpenId, 'B'); assert.equal(els.histDlg.opens, 1, 'late history cannot replace newer modal');
  const c = h.openHistory('C'); h.closeHistory(); reply(2, 'C'); await c;
  assert.equal(h.histOpenId, 'B'); assert.equal(els.histDlg.opens, 1, 'close cancels pending modal response');
  const escaped = h.openHistory('escape'); onCancel(); reply(3, 'escape'); await escaped;
  assert.equal(els.histDlg.opens, 1, 'Escape cancels pending modal response');
  const reopened = h.openHistory('D'); reply(4, 'D'); await reopened;
  assert.equal(h.histOpenId, 'D', 'close then new open is not cancelled by a delayed close event');
  const statusReply = (i, status) => pending[i]({ json: async () => ({ project: 'E', startedAt: 'E', request: 'E', status, tasks: [], activity: [] }) });
  const interrupted = h.openHistory('E'); statusReply(5, 'interrupted'); await interrupted;
  assert.equal(els.histResume.hidden, false, 'an interrupted record (detail matches the list) can be continued');
  const live = h.openHistory('F'); statusReply(6, 'running'); await live;
  assert.equal(els.histResume.hidden, true, 'a still-running (live) job has no resume button');
  // Redraws keep what the user opened or closed: chat via setHtml, card progress via its remembered state.
  const renderProject = fn(html, 'renderProject');
  assert.match(renderProject, /setHtml\(box, chatHtml\(w\.activity\)\)/); assert.doesNotMatch(renderProject, /box\.innerHTML/);
  // A rebuild (new chat message) re-opens the technical details the user had open, matched by text.
  // Two clicks before the save response must create just one enabled routine.
  const projects = { A: { routines: [] }, B: { routines: [] } }, replies = [];
  const form = { request: '每天整理報表', precheck: '', time: '09:30' };
  const box = { querySelector: s => ({ value: form[s.match(/data-rt-(\w+)/)[1]] }),
    querySelectorAll: () => [{ dataset: { rtDay: '1' } }] };
  const button = () => ({ closest: () => box, blur() {} });
  const ui = { current: 'A', ws: () => ui.current, pendingRoutineAdds: new Set(), drafts: { 'rt:A': form.request },
    $: () => ({}), render() {}, crypto, saveSettings() {},
    post: (path, body) => {
      assert.equal(path, '/api/routine/save');
      return new Promise((resolve, reject) => replies.push({ save() { ui.saveRoutine(projects[body.ws], body); resolve(); }, reject }));
    } };
  vm.createContext(ui);
  vm.runInContext([fn(src, 'validRoutine'), fn(src, 'saveRoutine')].join('\n'), ui);
  vm.runInContext('function click(e) {' + html.match(/const rtAdd = [\s\S]*?(?=  const rtDel = )/)[0] + '}', ui);
  const add = () => ui.click({ target: { closest: () => button() } });
  const firstSave = add();
  add(); // even a replacement button from a redraw must refer to the same pending request
  assert.equal(replies.length, 1, 'only one create reaches the server during a double click');
  ui.current = 'B'; const otherSave = add();
  assert.equal(replies.length, 2, 'projects have independent forms');
  ui.drafts['rt:A'] = '明天的工作';
  replies[0].save(); await firstSave; replies[1].save(); await otherSave;
  assert.equal(ui.drafts['rt:A'], '明天的工作');
  assert.deepEqual(Object.values(projects).map(w => w.routines.length), [1, 1]);
  const saved = projects.A.routines[0];
  assert.ok(saved.on && saved.id); assert.equal(saved.request, form.request); assert.equal(saved.time, '09:30');
  ui.current = 'A'; const failedSave = add(); replies[2].reject(new Error('temporary failure')); await failedSave;
  const retrySave = add(); replies[3].save(); await retrySave;
  assert.equal(projects.A.routines.length, 2, 'a later intentional submit or retry remains possible');

  const setHtml = new Function(html.slice(html.indexOf('const setHtml ='), html.indexOf('let doneOpen')) + 'return setHtml;')();
  const detail = (text, open) => ({ open, querySelector: () => ({ textContent: text }) });
  let shown = [detail('A', true), detail('B', false)];
  const chatBox = { _html: 'old', querySelectorAll: (q) => (q.includes('[open]') ? shown.filter((d) => d.open).map((d) => d.querySelector()) : shown),
    set innerHTML(v) { shown = [detail('A', false), detail('B', false), detail('C', false)]; } };
  setHtml(chatBox, 'new');
  assert.deepEqual(shown.map((d) => d.open), [true, false, false], 'only the detail that was open is re-opened');
  assert.match(html, /id="stepsDrop" \$\{stepsOpen \? 'open' : ''\}/); assert.match(html, /stepsDrop'\) stepsOpen = e\.target\.open/);

  const responses = [], renders = [];
  const r = { refreshSeq: 0, refreshAppliedSeq: 0, last: '', lastRender: 0, S: null,
    fetch: () => new Promise(resolve => responses.push(resolve)), render() { renders.push(r.S.revision); }, handleNotices() {}, document: {} };
  vm.createContext(r); vm.runInContext(fn(html, 'refresh'), r);
  const state = (i, revision, ok = true) => responses[i]({ ok, text: async () => JSON.stringify({ revision }) });
  const old = r.refresh(), fresh = r.refresh(); state(1, 2); await fresh; state(0, 1); await old;
  assert.equal(r.S.revision, 2, 'state cannot regress on late response');
  const first = r.refresh(), second = r.refresh(); state(2, 3); await first;
  assert.equal(r.S.revision, 3, 'overlapping poll must not starve rendering');
  state(3, 4); await second;
  const bad = r.refresh(); state(4, 'error', false); await bad;
  assert.equal(r.S.revision, 4, 'HTTP errors cannot replace valid state');
  const staleError = r.refresh(), recovered = r.refresh(); state(6, 5); await recovered;
  r.document.title = 'Connected'; state(5, 'error', false); await staleError;
  assert.equal(r.document.title, 'Connected', 'older failed request cannot overwrite newer connected title');

  let finish;
  const input = { value: 'sent' }, office = {};
  const d = { drafts: { 'i:A': 'sent', 'i:B': 'keep B' }, current: 'A', b: { id: 'instructBtn' }, ws: () => d.current,
    $: id => id === 'instruction' ? input : office, post: () => new Promise(resolve => { finish = resolve; }), render() {} };
  vm.createContext(d);
  vm.runInContext('function submit() {' + html.match(/if \(b\.id === 'instructBtn'\) \{([\s\S]*?)\n  \}/)[1] + '\n}', d);
  const sent = d.submit(); d.drafts['i:A'] = input.value = 'new unsent'; finish(); await sent;
  assert.equal(d.drafts['i:A'], 'new unsent'); assert.equal(input.value, 'new unsent');
  d.drafts['i:A'] = input.value = 'send again'; const switched = d.submit(); d.current = 'B'; input.value = 'keep B'; finish(); await switched;
  assert.equal(d.drafts['i:A'], ''); assert.equal(d.drafts['i:B'], 'keep B'); assert.equal(input.value, 'keep B');

  for (const closed of [false, true]) {
    let release;
    const routine = { id: 'routine', on: true, request: 'scheduled edit', precheck: 'slow check', time: '09:00', lastAt: '' };
    const w = { project: '/test/project', leader: 'codex', tasks: [], routines: [routine] }, plans = [];
    const env = { S: { workspaces: [w], closedWorkspaces: {} }, workspaceSettings: (w) => ({ project: w.project }), crypto, CONTINUE_RE: /^continue/, launchingWs: new Set(), preparing: new Map(), treeKey: x => x,
      routineDue: () => true, stillStopping: () => false, precheck: () => new Promise(resolve => { release = resolve; }),
      saveSettings() {}, event() {}, log() {}, notify() {}, label: () => 'test', clip: x => x, endLeftSetups: async () => {},
      settingUp: () => false, isDir: () => true, available: () => true, workersFor: () => ['claude'], latestJob: () => null,
      projectContext: () => '', agentName: x => x, planPhase: x => plans.push(x), knownRefs: () => [] };
    vm.createContext(env);
    const scheduler = src.slice(src.indexOf('const pendingRoutines ='), src.indexOf('// ---------- Plan limits'));
    vm.runInContext(scheduler + ['launching', 'start', 'startJob', 'closeWorkspace'].map(name => fn(src, name)).join('\n'), env);
    env.runRoutines(); if (closed) env.closeWorkspace(w); release(''); await new Promise(resolve => setImmediate(resolve));
    assert.equal(plans.length, closed ? 0 : 1, 'closed workspace cannot start a pending routine; open workspace still can');
    assert.equal(!!w.run?.active, !closed);
  }
  finished();
  console.log('Async UI ordering, draft preservation and closed-routine cancellation: PASS');
}
module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
