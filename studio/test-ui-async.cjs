// Async UI and routine cancellation regressions: source extraction, no providers or IO writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
const fn = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\s*\\([\\s\\S]*?\\r?\\n\\}`))[0];
async function run() {
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
    const env = { S: { workspaces: [w] }, crypto, CONTINUE_RE: /^continue/, launchingWs: new Set(), preparing: new Map(), treeKey: x => x,
      routineDue: () => true, stillStopping: () => false, precheck: () => new Promise(resolve => { release = resolve; }),
      saveSettings() {}, event() {}, log() {}, notify() {}, label: () => 'test', clip: x => x, endLeftSetups: async () => {},
      settingUp: () => false, isDir: () => true, available: () => true, workersFor: () => ['claude'], latestJob: () => null,
      projectContext: () => '', agentName: x => x, planPhase: x => plans.push(x), knownRefs: () => [] };
    vm.createContext(env);
    vm.runInContext(['launching', 'start', 'startJob', 'runRoutines', 'closeWorkspace'].map(name => fn(src, name)).join('\n'), env);
    env.runRoutines(); if (closed) env.closeWorkspace(w); release(''); await new Promise(resolve => setImmediate(resolve));
    assert.equal(plans.length, closed ? 0 : 1, 'closed workspace cannot start a pending routine; open workspace still can');
    assert.equal(!!w.run?.active, !closed);
  }
  console.log('Async UI ordering, draft preservation and closed-routine cancellation: PASS');
}
module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
