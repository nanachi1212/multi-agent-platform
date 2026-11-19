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
    pausePending: new Set(),
    STEP_WORD: { WAITING: '待做', WORKING: '工作中', DONE: '已完成', PAUSED: '已暫停', INTERRUPTED: '已中斷', FAILED: '失敗', WAITING_EXTERNAL: '等待外部結果', WAITING_AGENT: '等待其他 AI', NEEDS_USER: '需要 Nana' },
    PARKED: ['WAITING_EXTERNAL', 'WAITING_AGENT', 'NEEDS_USER'], stepsOpen: true,
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
    'projCardHtml',
    'doneDropHtml'
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
  const readOnly = { id: 'read-card', writes: false };
  const reading = { lease: { readers: [{ cardId: readOnly.id, owner: 'ACP worker' }] } };
  assert.equal(sandbox.formatWorkspace(reading, readOnly).leaseStatus, 'READ');
  assert.equal(sandbox.formatWorkspace(reading).leaseStatus, 'READ', 'project reflects its active reader');
  assert.equal(sandbox.formatWorkspace(reading, { ...readOnly, id: 'other-card' }).leaseStatus, 'FREE', 'another card owns the read lease');
  assert.equal(sandbox.formatWorkspace({ lease: { readers: [] } }, readOnly).leaseStatus, 'FREE', 'Stop released the read lease');

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

  const resumed = [{ id: 'resume-card', title: 'Resumed work', status: 'WORKING', result: '已暫停' }];
  assert.ok(!sandbox.boardHtml(resumed, [], false).includes('已暫停'), 'running card does not display the previous pause result');
  sandbox.doneOpen = true;
  const resumedSummary = sandbox.doneDropHtml({ tasks: resumed });
  assert.ok(resumedSummary.includes('正在做…') && !resumedSummary.includes('已暫停'), 'work summary prioritizes the current running state');

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
    sandbox.pausePending.add(wsMock.project);
    const pausing = sandbox.nowHtml({ ...wsMock, tasks: [], run: { ...wsMock.run, active: false, paused: true } }, { ic: '⏸️', cls: '', text: '暫停中' });
    assert.ok(pausing.includes('正在確認成員與工具程序停止') && !pausing.includes('data-resume-job'), 'resume is unavailable while Pause is still draining');
    sandbox.pausePending.clear();
  }

  // 2. Verify server.mjs /api/state response mapping
  // Read server.mjs to ensure GET /api/state sends no unread workspace_summary / raw lease list, and builds blocked_reason
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
  const stateRoute = serverCode.match(/'GET \/api\/state': \(\) => \{[\s\S]*?\n  \},/)?.[0] || '';
  assert.ok(stateRoute.includes('workspaces'), 'GET /api/state route found');
  assert.ok(!serverCode.includes('workspace_summary') && !html.includes('workspace_summary'), 'workspace_summary is neither sent nor read');
  const publicState = vm.runInNewContext("({" + stateRoute + "})['GET /api/state']()", {
    S: { workspaces: [], agents: {}, leases: [{ id: 'private' }], closedWorkspaces: { private: {} } }, teamStats: () => ({}),
  });
  assert.ok(Array.isArray(publicState.workspaces), 'GET /api/state returns the workspace list');
  assert.ok(!Object.hasOwn(publicState, 'leases'), 'GET /api/state leaves out S.leases');
  assert.ok(!Object.hasOwn(publicState, 'closedWorkspaces'), 'closed projects stay out of the public state');
  assert.ok(serverCode.includes('blocked_reason'), 'server.mjs must compute blocked_reason for tasks');

  console.log('UI & API Workspace/Runtime/Blocked: PASS');
};

if (require.main === module) module.exports().catch(err => { console.error(err); process.exitCode = 1; });
