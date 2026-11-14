// Pure client regressions: no browser, provider process, network, or file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const fn = (name) => {
    const match = html.match(new RegExp(`(?:async )?function ${name}\\s*\\([\\s\\S]*?\\r?\\n\\}`));
    assert.ok(match, `missing ${name}`);
    return match[0];
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const s = {
    S: { agents: [], workspaces: [], runtimes: [] }, curPath: () => '/A', esc,
    laneFolded: () => false, cardBlockedReason: () => '', formatWorkspace: () => ({ fullLine: 'A' }),
    runtimesOf: () => [], askFlag: () => '', look: () => ({ c: '#fff' }), workState: () => null,
    ASKABLE: [], PARKED: [], STEP_WORD: {}, name: (x) => x, workButtons: () => '',
    usageLine: () => '', fmtTok: () => '', hhmm: () => '', blockedHtml: () => '', waitLine: () => '', ICON: {}
  };
  vm.createContext(s);
  vm.runInContext(html.match(/^const LANES = .*$/m)[0], s);
  vm.runInContext(fn('boardHtml'), s);
  for (const [status, expected] of [['WORKING', false], ['DONE', false], ['WAITING', true], ['PAUSED', true], ['FAILED', true]]) {
    const board = s.boardHtml([{ id: 'x', agent: 'a', title: 'card', status }], [{ id: 'a', name: 'a', status: 'available' }], true);
    assert.equal(board.includes('data-reassign'), expected, `${status} reassignment controls`);
    assert.equal(s.boardHtml([{ id: 'x', agent: 'a', title: 'card', status }], [], false).includes('data-reassign'), false, 'history is not editable');
  }
  vm.runInContext(fn('formatRuntimeItem') + '\n' + fn('nowHtml'), s);
  const payload = '<img src=x onerror=alert(1)>';
  s.S.runtimes = [{ purpose: 'backend', port: 1, readiness: { status: 'BLOCKED', reason: payload } }];
  s.runtimesOf = () => s.S.runtimes;
  const rendered = s.nowHtml({ name: 'A', tasks: [], activity: [], run: { active: true, phase: 'planning', request: 'x', leader: 'a' } }, {});
  assert.ok(!rendered.includes(payload), 'runtime errors must not insert raw markup');
  assert.ok(rendered.includes(esc(payload)), 'runtime error remains visible as text');

  const els = { workDlg: { open: true }, workBody: {}, workTitle: {}, workAsk: {} }, pending = [];
  const r = {
    workOpen: { ws: 'A', id: 'A' }, workLoadSeq: 0, $: (id) => els[id],
    fetch: () => new Promise((resolve) => pending.push(resolve)), esc, name: (x) => x,
    workHtml: (d) => 'DETAIL:' + d.title, ASKABLE: [], workLogOpen: false
  };
  vm.createContext(r); vm.runInContext(fn('loadWork'), r);
  const reply = (index, title, ok = true) => pending[index]({ ok, json: async () => ({ agent: title, title, error: title }) });
  const a = r.loadWork(); r.workOpen = { ws: 'B', id: 'B' }; const b = r.loadWork();
  reply(1, 'B'); await b; reply(0, 'A'); await a;
  assert.equal(els.workBody.innerHTML, 'DETAIL:B', 'old card response cannot replace current card');
  const older = r.loadWork(), newer = r.loadWork();
  reply(3, 'B-new'); await newer; reply(2, 'old error', false); await older;
  assert.equal(els.workBody.innerHTML, 'DETAIL:B-new', 'stale same-card error cannot replace newest detail');
  const closed = r.loadWork(); els.workDlg.open = false; reply(4, 'closed'); await closed;
  assert.equal(els.workBody.innerHTML, 'DETAIL:B-new', 'closed dialog ignores pending response');
  // Historical boards must not use the currently selected workspace or expose cleanup actions.
  s.base = (p) => String(p).split('/').pop();
  vm.runInContext(fn('formatWorkspace'), s);
  s.S.workspaces = [{ project: '/A', wsInfo: { branch: 'current-A' }, lease: { writer: { owner: 'live-A', state: 'ACTIVE' } } }];
  const history = s.boardHtml([{ id: 'old', agent: 'a', title: 'old', status: 'DONE', worktree: { branch: 'old-B', cleanupError: 'retry later' } }], [], false, { project: '/B', historical: true });
  assert.ok(history.includes('/B'), 'history identifies its own project');
  assert.ok(!history.includes('live-A') && !history.includes('current-A'), 'history does not borrow live workspace ownership');
  assert.ok(!history.includes('data-wt-cleanup'), 'history exposes no cleanup buttons');
  assert.ok(history.includes('lease: —'), 'history does not claim current lease is free');
  assert.ok(!history.includes(esc(payload)), 'history does not display live runtimes');

  const historyEls = { histHead: {}, history: {}, office: {} }, historyPending = [];
  const h = {
    historyLoadSeq: 0, histCount: 0, current: { project: '/A', name: 'A' },
    W: () => h.current, $: (id) => historyEls[id], fetch: () => new Promise((resolve) => historyPending.push(resolve)),
    sameP: (a, b) => a === b, base: (x) => x, render: () => {}, esc, fmt: (x) => x, STATUS: {}
  };
  vm.createContext(h); vm.runInContext(fn('loadHistory'), h);
  const ha = h.loadHistory('/A'); h.current = { project: '/B', name: 'B' }; const hb = h.loadHistory('/B');
  const historyReply = (n, project) => historyPending[n]({ json: async () => [{ id: project, project, request: project, status: 'done' }] });
  historyReply(1, '/B'); await hb; historyReply(0, '/A'); await ha;
  assert.equal(historyEls.histHead.textContent, '歷史紀錄 · B', 'late history cannot change the selected heading');
  assert.ok(historyEls.history.innerHTML.includes('/B') && !historyEls.history.innerHTML.includes('/A'), 'late history cannot replace the selected list');

  // Exercise the actual click-handler start branch with a delayed response.
  const start = html.match(/if \(b\.id === 'start'\) \{([\s\S]*?)\n  \}/);
  assert.ok(start);
  let finishStart;
  const input = { value: 'send A' };
  const p = { b: { blur() {} }, current: '/A', drafts: { '/A': 'send A', '/B': 'keep B' },
    ws: () => p.current, $: () => input, post: () => new Promise((resolve) => { finishStart = resolve; }) };
  vm.createContext(p); vm.runInContext('function submit() {' + start[1] + '\n}', p);
  const sent = p.submit(); p.current = '/B'; input.value = 'keep B'; finishStart(); await sent;
  assert.equal(input.value, 'keep B', 'completion for A must not clear B input');
  assert.equal(p.drafts['/B'], 'keep B'); assert.equal(p.drafts['/A'], '');
  p.current = '/A'; p.drafts['/A'] = input.value = 'send again';
  const edited = p.submit(); p.drafts['/A'] = input.value = 'new unsent text'; finishStart(); await edited;
  assert.equal(input.value, 'new unsent text', 'completion must not clear newer same-project draft');
  assert.equal(p.drafts['/A'], 'new unsent text');
  assert.equal((html.match(/id="err"/g) || []).length, 1, 'one shared error element');
  assert.equal((html.match(/>收尾者：<\/span>/g) || []).length, 1, 'finisher label occurs once');
  assert.equal((html.match(/>備援者：<\/span>/g) || []).length, 1, 'fallback has its own label');
  assert.ok(!html.includes('const anyActive ='), 'unused helper removed');
  console.log('UI safety regressions: PASS');
}
module.exports = run;
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
