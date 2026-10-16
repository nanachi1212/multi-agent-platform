// Targeted tests for Workspace, Runtime, and Blocked reason in Studio API & UI
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = async function () {
  console.log('--- Running UI Workspace, Runtime & Blocked Reason Tests ---');

  // 1. Verify index.html UI helper functions and component rendering
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // Extract relevant script block or eval in synthetic context
  const sandbox = {
    console,
    S: { workspaces: [], agents: [], runtimes: [] },
    STEP_WORD: { WAITING: '待做', WORKING: '工作中', DONE: '已完成', PAUSED: '已暫停', INTERRUPTED: '已中斷', FAILED: '失敗', WAITING_EXTERNAL: '等待外部結果', WAITING_AGENT: '等待其他 AI', NEEDS_USER: '需要 Nana' },
    PARKED: ['WAITING_EXTERNAL', 'WAITING_AGENT', 'NEEDS_USER'],
    ICON: { DONE: '✅', WORKING: '⏳', WAITING: '🕒', PAUSED: '⏸️' },
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    base: (p) => path.basename(String(p || '')),
    name: (id) => id,
    look: () => ({ c: '#fff', ab: 'AI' }),
    curPath: () => 'E:\\CodexProject\\TWstock',
    LEASE_WORD: { ACTIVE: '修改中', RESERVED: '保留中', STALE: '已失效', RELEASED: '已釋放' },
    STATE_LOOK: { need: ['🔴', 'bad'], open: ['🟡', 'on'], wait: ['🟡', 'on'], done: ['✅', 'ok'], idle: ['⚪', ''] },
    wsStatus: () => ['ok', '正常', 'ok'],
    when: () => '剛剛',
    laneFolded: () => false, // board lane fold state (localStorage in the page)
    workState: () => null, workButtons: () => '', ASKABLE: ['WORKING', 'WAITING_EXTERNAL', 'WAITING_AGENT', 'NEEDS_USER'], // work-progress helpers (own tests in lifecycle-check 17)
  };

  // Extract functions from index.html:
  // formatWorkspace, formatRuntimeItem, cardBlockedReason, workspaceLine, runtimeHtml, blockedHtml, waitLine, attention, boardHtml, projCardHtml, nowHtml
  const fnNames = [
    'formatWorkspace',
    'formatRuntimeItem',
    'cardBlockedReason',
    'workspaceLine',
    'runtimesOf',
    'fmtTok',
    'usageLine',
    'runtimeHtml',
    'blockedHtml',
    'waitLine',
    'attention',
    'askFlag',
    'boardHtml',
    'projCardHtml'
  ];

  vm.runInNewContext(html.match(/^const LANES = .*$/m)[0].replace('const ', 'globalThis.'), sandbox); // the page's own lanes, not a copy
  for (const fn of fnNames) {
    const m = html.match(new RegExp(`function ${fn}\\s*\\([\\s\\S]*?\\r?\\n\\}`));
    assert.ok(m, `Function ${fn} should exist in index.html`);
    vm.runInNewContext(m[0], sandbox);
  }

  // Test formatRuntimeItem
  const backendReady = sandbox.formatRuntimeItem({
    purpose: 'backend',
    port: 3018,
    readiness: { status: 'BACKEND_READY' }
  });
  assert.equal(backendReady, 'Backend 3018 — READY', 'Backend ready matches requirement');

  const smokeRunning = sandbox.formatRuntimeItem({
    purpose: 'smoke',
    port: 3028,
    status: 'running',
    job_id: '123'
  });
  assert.equal(smokeRunning, 'Smoke 3028 — RUNNING — Job #123', 'Smoke running matches requirement');

  const testStopped = sandbox.formatRuntimeItem({
    purpose: 'test',
    port: 3019,
    status: 'stopped'
  });
  assert.equal(testStopped, 'Test 3019 — STOPPED', 'Test stopped matches requirement');

  const backendBlocked = sandbox.formatRuntimeItem({
    purpose: 'backend',
    port: 3018,
    readiness: { status: 'BLOCKED', reason: 'MiningProcessLockError' }
  });
  assert.equal(backendBlocked, 'Backend 3018 — BLOCKED · MiningProcessLockError', 'Backend blocked includes reason');

  // Test cardBlockedReason
  const b1 = sandbox.cardBlockedReason({ blocked: { owner: 'Claude' } });
  assert.equal(b1, 'Blocked：workspace currently owned by Claude', 'Blocked by owner matches requirement');

  const b2 = sandbox.cardBlockedReason({ blockReason: 'unknown process PID 12345 owns production data lock' });
  assert.equal(b2, 'Blocked：unknown process PID 12345 owns production data lock', 'Blocked by lock matches requirement');

  const b3 = sandbox.cardBlockedReason({ wait: { recoveryReason: 'backend 3018 port has unknown process PID 12345' } });
  assert.equal(b3, 'Blocked：backend 3018 port has unknown process PID 12345', 'Blocked from recoveryReason normalized');

  // Test formatWorkspace
  const wsMock = {
    project: 'E:\\CodexProject\\TWstock',
    name: 'TWstock',
    leader: 'claude',
    tasks: [],
    run: { id: 'job-1', active: true, leader: 'claude', request: 'feature test', phase: 'working' },
    activity: [],
    wsInfo: { repo: 'TWstock', branch: 'feat/auto-watch-v1', path: 'E:\\CodexProject\\TWstock' },
    lease: {
      writer: { owner: 'Claude Code', repo: 'TWstock', branch: 'feat/auto-watch-v1', state: 'ACTIVE' },
      readers: []
    }
  };
  const wsFmt = sandbox.formatWorkspace(wsMock);
  assert.equal(wsFmt.writerSummary, 'Writer: Claude Code / TWstock / feat/auto-watch-v1', 'Workspace writer summary matches requirement');
  assert.ok(wsFmt.fullLine.includes('Writer: Claude Code / TWstock / feat/auto-watch-v1'), 'fullLine includes writer');
  assert.ok(wsFmt.fullLine.includes('Readers: —'), 'fullLine includes readers');
  assert.ok(wsFmt.fullLine.includes('branch: feat/auto-watch-v1'), 'fullLine includes branch');
  assert.ok(wsFmt.fullLine.includes('lease: ACTIVE'), 'fullLine includes lease status');

  // Test boardHtml (Card rendering)
  sandbox.S.workspaces = [wsMock];
  sandbox.S.runtimes = [
    { purpose: 'backend', port: 3018, readiness: { status: 'BACKEND_READY' }, workspace: 'E:\\CodexProject\\TWstock' },
    { purpose: 'smoke', port: 3028, status: 'running', job_id: '123', card_id: 'card-1' }
  ];

  const tasks = [
    {
      id: 'card-1',
      title: 'Auto watch feature',
      agent: 'claude',
      status: 'WORKING',
      writes: true
    },
    {
      id: 'card-2',
      title: 'Review feature',
      agent: 'codex',
      status: 'WAITING',
      blocked: { owner: 'Claude' },
      writes: true
    }
  ];
  wsMock.tasks = tasks;

  const boardResult = sandbox.boardHtml(tasks, [{ id: 'claude', name: 'Claude Code', status: 'available' }, { id: 'codex', name: 'Codex', status: 'available' }], true);

  assert.ok(boardResult.includes('📁 <b>Workspace</b>'), 'Card must display Workspace');
  assert.ok(boardResult.includes('Writer: Claude Code / TWstock / feat/auto-watch-v1'), 'Card must display Workspace writer');
  assert.ok(boardResult.includes('⚡ <b>Runtime</b>'), 'Card must display Runtime');
  assert.ok(boardResult.includes('Smoke 3028 — RUNNING — Job #123') || boardResult.includes('Backend 3018 — READY'), 'Card must display formatted runtime');
  assert.ok(boardResult.includes('🚫 Blocked：workspace currently owned by Claude'), 'Card must display specific blocked reason');
  assert.ok(boardResult.includes('Blocked</span>'), 'Blocked card must have Blocked tag');

  // Test projCardHtml (Project rendering)
  const projResult = sandbox.projCardHtml(wsMock);
  assert.ok(projResult.includes('<b>Workspace</b>'), 'Project card must display Workspace');
  assert.ok(projResult.includes('<b>Runtime</b>'), 'Project card must display Runtime');

  // Test nowHtml (Job rendering)
  const fnNow = html.match(/function nowHtml\s*\([\s\S]*?\r?\n\}/);
  if (fnNow) {
    vm.runInNewContext(fnNow[0], sandbox);
    const nowResult = sandbox.nowHtml(wsMock, { ic: '🟢', cls: 'ok', text: '工作中' });
    assert.ok(nowResult.includes('<dt>Workspace</dt>'), 'nowHtml (Job) must display Workspace');
    assert.ok(nowResult.includes('<dt>Runtime</dt>'), 'nowHtml (Job) must display Runtime');
  }

  // 2. Verify server.mjs /api/state response mapping
  // Read server.mjs to ensure GET /api/state builds workspace_summary and blocked_reason
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
  assert.ok(serverCode.includes('workspace_summary'), 'server.mjs must provide workspace_summary');
  assert.ok(serverCode.includes('blocked_reason'), 'server.mjs must compute blocked_reason for tasks');

  console.log('UI & API Workspace/Runtime/Blocked: PASS');
};

if (require.main === module) module.exports().catch(err => { console.error(err); process.exitCode = 1; });
