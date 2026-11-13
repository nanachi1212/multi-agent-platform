const { assert, makeEnv, mkTmp, newW, region } = require('./lifecycle-harness.cjs');
const fs = require('node:fs'), path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

(async () => {
  // reached through a junction, like CI's 8.3 temp path: a path spelled before its folder exists differs from the real one
  const real = mkTmp('studio-cleanup-'), root = real + '-via'; fs.symlinkSync(real, root, 'junction'); const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\ncache/\nnode_modules/\n'); git('add', '.'); git('commit', '-qm', 'base');
  const initial = git('rev-parse', 'HEAD'), trees = [];
  let scenario, prHead, moved, calls, afterAdd;
  const { processSnapshot } = await import('./codex-runtime.mjs'), { killProcessTree } = await import('./runtime-registry.mjs');
  const E = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree, execFile: (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') return cb(null, JSON.stringify([{ number: 1, headRefOid: prHead }]));
    if (scenario === 'status-error' && args.includes('status') || scenario === 'remove-error' && args.includes('remove') || scenario === 'ref-error' && args.includes('update-ref')) return cb(new Error('injected failure'), '', 'injected failure');
    return execFile(cmd, args, opts, (err, out, stderr) => {
      if (!err && scenario === 'moved-ref' && args.includes('remove')) git('update-ref', 'refs/heads/' + trees.at(-1).branch, moved);
      if (!err && afterAdd && args.includes('worktree') && args.includes('add')) { afterAdd(args.at(-2)); return setTimeout(() => cb(err, out, stderr), 3000); } // the folder exists, Studio records it only after the claim looked
      cb(err, out, stderr);
    });
  } });
  try {
    for (scenario of ['clean', 'setup', 'dirty', 'ignored', 'status-error', 'remove-error', 'ref-error', 'moved-ref', 'old-pr', 'squash-pr', 'dirty-remote', 'outside', 'include', 'include-edited', 'setup-include', 'setup-later', 'setup-zh']) {
      calls = []; const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false;
      w.worktreeSetup = { setup: 'echo made> ignored.txt && mkdir node_modules && echo m> node_modules\\m.txt', 'setup-include': 'echo made> ignored.txt', 'setup-later': 'mkdir cache && echo a> cache\\a.txt', 'setup-zh': 'echo ok' }[scenario] || ''; // setup-include: overwrites the .worktreeinclude copy
      if (scenario === 'setup-zh') { // a non-ASCII .worktreeinclude path: git status quotes it unless read with -z
        fs.writeFileSync(path.join(repo, '秘密.env'), 'secret'); fs.appendFileSync(path.join(repo, '.gitignore'), '秘密.env\n'); fs.appendFileSync(path.join(repo, '.worktreeinclude'), '秘密.env\n');
        git('add', '.'); git('commit', '-qm', 'zh include');
      }
      const t = { id: scenario, title: scenario, agent: 'codex', writes: true, status: 'PAUSED', after: [] }; w.tasks.push(t);
      if (scenario === 'include') { // once: an ignored file and folder, and the include list itself (tracked, like Orca's)
        fs.mkdirSync(path.join(repo, 'deps')); fs.writeFileSync(path.join(repo, 'deps', 'x.txt'), 'dep');
        fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret'); fs.appendFileSync(path.join(repo, '.gitignore'), 'deps/\n');
        fs.writeFileSync(path.join(repo, '.worktreeinclude'), '# copies and links\nignored.txt\ndeps\n.gitignore\nmissing.txt\n*.log\n../outside\n');
        git('add', '.'); git('commit', '-qm', 'include list');
      }
      const { path: dir, branch } = await E.api.useWorktree(w, t.id); trees.push({ path: dir, branch });
      if (scenario === 'setup') assert.deepStrictEqual([fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8').trim(), t.worktree.setupIgnored.map((e) => e.path), !!t.hold, t.preparing, E.env.logs.at(-1).text.includes('設定指令已完成')], ['made', ['ignored.txt', 'node_modules/'], false, false, true], 'the setup command ran in the worktree before the card');
      if (scenario === 'setup') fs.writeFileSync(path.join(dir, 'node_modules', 'later.txt'), 'rebuildable'); // node_modules may change: it goes anyway
      if (scenario === 'setup-later') fs.writeFileSync(path.join(dir, 'cache', 'keep.txt'), 'must survive');
      if (scenario === 'setup-zh') { prHead = git('-C', dir, 'rev-parse', 'HEAD'); assert.ok(!(t.worktree.setupIgnored || []).some((e) => String(e.path || e).includes('秘密') || String(e).includes('\\347')), 'the non-ASCII copy is not the setup command\'s: ' + JSON.stringify(t.worktree.setupIgnored)); fs.writeFileSync(path.join(dir, '秘密.env'), 'edited'); }
      if (scenario === 'setup-include') assert.deepStrictEqual(t.worktree.setupIgnored, [], 'a .worktreeinclude path is never the setup command\'s');
      if (scenario.startsWith('include')) {
        prHead = git('-C', dir, 'rev-parse', 'HEAD');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), 'secret', 'the ignored file is copied');
        assert.ok(fs.lstatSync(path.join(dir, 'deps')).isSymbolicLink() && fs.readFileSync(path.join(dir, 'deps', 'x.txt'), 'utf8') === 'dep', 'the ignored folder is linked');
        assert.deepStrictEqual(t.worktree.included.map((e) => e.rel + ':' + e.kind), ['ignored.txt:file', 'deps:dir']);
        const note = E.env.logs.at(-1).text;
        for (const k of ['補上 ignored.txt（複製）、deps（連結）', '.gitignore（沒有被 gitignore）', 'missing.txt（主資料夾沒有）', '*.log（只支援', '../outside（只支援']) assert.ok(note.includes(k), scenario + ': ' + k + ' in ' + note);
        if (scenario === 'include-edited') fs.writeFileSync(path.join(dir, 'ignored.txt'), 'edited');
      }
      if (['dirty', 'ignored', 'dirty-remote'].includes(scenario)) fs.writeFileSync(path.join(dir, scenario === 'ignored' ? 'ignored.txt' : 'keep.txt'), 'must survive');
      if (scenario === 'moved-ref') { git('commit', '--allow-empty', '-qm', 'advanced'); moved = git('rev-parse', 'HEAD'); }
      if (scenario === 'old-pr' || scenario === 'squash-pr') {
        if (!git('remote')) git('remote', 'add', 'origin', 'https://example.invalid/test/repo.git');
        execFileSync('git', ['commit', '--allow-empty', '-qm', 'new work'], { cwd: dir, windowsHide: true });
        prHead = scenario === 'old-pr' ? initial : git('-C', dir, 'rev-parse', 'HEAD');
      }
      if (scenario === 'outside') t.worktree.path = repo;
      await E.api.cleanupWorktree(w, t);
      assert.ok(!calls.some((c) => c.includes('--force') || c.includes('-D')), 'production cleanup never uses force');
      if (scenario === 'setup-include') assert.deepStrictEqual([fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8').trim(), t.worktree.cleanupError], ['made', '仍有修改、未追蹤或忽略的檔案'], 'a changed copy still stops cleanup');
      if (scenario === 'setup-later') assert.deepStrictEqual([fs.readFileSync(path.join(dir, 'cache', 'keep.txt'), 'utf8'), t.worktree.cleanupError], ['must survive', '仍有修改、未追蹤或忽略的檔案'], 'a file added later to a setup folder stops cleanup');
      if (scenario === 'setup-zh') assert.deepStrictEqual([fs.existsSync(path.join(dir, '秘密.env')) && fs.readFileSync(path.join(dir, '秘密.env'), 'utf8'), t.worktree.cleanupError], ['edited', '仍有修改、未追蹤或忽略的檔案'], 'an edited non-ASCII copy stops cleanup');
      if (['clean', 'setup', 'squash-pr', 'include'].includes(scenario)) {
        assert.strictEqual(t.worktree.cleaned, true, scenario + ': ' + t.worktree.cleanupError); assert.ok(!fs.existsSync(dir)); assert.strictEqual(git('branch', '--list', branch), '');
        if (scenario === 'include') assert.deepStrictEqual([fs.readFileSync(path.join(repo, 'deps', 'x.txt'), 'utf8'), fs.readFileSync(path.join(repo, 'ignored.txt'), 'utf8')], ['dep', 'secret'], 'removing the link and the copy never touches the primary checkout');
      } else {
        assert.ok(!t.worktree.cleaned && t.worktree.cleanupError, scenario);
        assert.ok(git('branch', '--list', branch), 'unremoved branch is preserved');
        assert.strictEqual(fs.existsSync(dir), !['ref-error', 'moved-ref'].includes(scenario));
        if (scenario === 'moved-ref') assert.strictEqual(git('rev-parse', branch), moved);
        if (scenario === 'ignored') assert.strictEqual(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), 'must survive');
        if (scenario === 'dirty-remote') assert.ok(git('remote') && !calls.some((c) => c[0] === 'gh') && t.worktree.cleanupError === '仍有修改或未追蹤的檔案', 'an ordinary dirty tree is refused before GitHub is asked');
        // a failure that may pass by itself is retried in a minute; a check that the tree is not ours / not clean is not
        assert.strictEqual(!!t.worktree.retryAt, ['status-error', 'remove-error', 'ref-error', 'old-pr'].includes(scenario), scenario + ': retry? ' + t.worktree.cleanupError);
        if (scenario === 'include-edited') assert.deepStrictEqual([fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), fs.lstatSync(path.join(dir, 'deps')).isSymbolicLink(), t.worktree.cleanupError], ['edited', true, '仍有修改、未追蹤或忽略的檔案'], 'an edited copy keeps the copy, the link and the worktree');
      }
    }
    // While the worktree is made and its setup command runs, the card cannot start and cannot be handed off.
    { const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false; w.worktreeSetup = 'ping -n 3 127.0.0.1 > nul';
      const t = { id: 'prep', title: 'prep', agent: 'codex', writes: true, status: 'WAITING', after: [] }; w.tasks.push(t);
      // a second card, listed after the first but started before it, finishes its setup first
      const t2 = { id: 'prep2', title: 'prep2', agent: 'claude', writes: true, status: 'WAITING', after: [] }; w.tasks.push(t2);
      const making2 = E.api.useWorktree(w, t2.id);
      await new Promise((r) => setTimeout(r, 400));
      const making = E.api.useWorktree(w, t.id);
      assert.ok(t.preparing, 'preparing from the first moment');
      await assert.rejects(E.api.handoffWriter(w, 'claude', t.id), /準備/, 'no handoff while preparing');
      for (let i = 0; i < 100 && !t.worktree; i++) await new Promise((r) => setTimeout(r, 20)); // now the setup command runs
      w.run.active = true; E.api.pump(w);
      assert.ok(t.status === 'WAITING' && !w.executingSteps?.has(t.id), 'the card does not start during setup');
      // An external claim of that worktree waits until the setup command has ended; the card stays paused.
      E.env.S.workspaces.length = 0; E.env.S.workspaces.push(w);
      const ext = await E.api.claimWorkspace(t.workdir, { label: 'ext' });
      assert.ok(ext && !t.preparing && !w.run.active, 'the external claim waited for the setup command of that worktree');
      await E.api.releaseClaim(t.workdir);
      w.run.active = false; const r = await making; trees.push(r, await making2);
      assert.ok(!t.preparing && t.worktree.setupIgnored, 'ready after setup'); }
    // The whole life of a setup command is tracked: a claim right after `git worktree add` (before Studio records the
    // folder), Stop, closing the project, and a restart all find it.
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const prepCard = (id, cmd) => { const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false; w.worktreeSetup = cmd;
      E.env.S.workspaces.length = 0; E.env.S.workspaces.push(w); const t = { id, title: id, agent: 'codex', writes: true, status: 'WAITING', after: [] }; w.tasks.push(t); return { w, t }; };
    {
      const { w, t } = prepCard('gap', 'ping -n 3 127.0.0.1 > nul');
      let claimed, claimedWhilePreparing;
      afterAdd = (dir) => { afterAdd = null; claimed = E.api.claimWorkspace(dir, { label: 'early' }).then((v) => { claimedWhilePreparing = t.preparing; return v; }); };
      const r = await E.api.useWorktree(w, t.id); trees.push(r);
      assert.ok(await claimed && claimedWhilePreparing === false, 'a claim made before Studio recorded the worktree still waits for the setup command');
      await E.api.releaseClaim(r.path);
    }
    {
      const { w, t } = prepCard('stopped', 'ping -n 60 127.0.0.1 > nul');
      w.run.paused = true; const making = E.api.useWorktree(w, t.id);
      for (let i = 0; i < 300 && !t.worktree?.setupProc; i++) await new Promise((r) => setTimeout(r, 20)); // the command runs
      await assert.rejects(Promise.resolve().then(() => E.api.closeWorkspace(w)), /準備/, 'a project cannot be closed while its worktree is being prepared');
      const pid = t.worktree.setupProc?.pid, began = Date.now();
      await E.api.stopAndDrain(w);
      assert.ok(!t.preparing && Date.now() - began < 30e3 && !alive(pid), 'Stop ends the setup command before it reports stopped');
      trees.push(await making);
    }
    {
      const { spawn } = require('node:child_process');
      const leftover = async (env, id) => { // a setup command a closed Studio left running in a real worktree
        const dir = path.join(root, 'left-' + id); git('worktree', 'add', '-q', dir); trees.push({ path: dir });
        const p = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 > nul'], { windowsHide: true });
        const proc = (await processSnapshot()).find((x) => x.pid === p.pid);
        const w = newW(); w.project = repo; env.S.workspaces.length = 0; env.S.workspaces.push(w);
        const t = { id, title: id, agent: 'codex', writes: true, status: 'WAITING', after: [], preparing: true, workdir: dir, worktree: { path: dir, setupProc: { pid: proc.pid, creationDate: proc.creationDate, executable: proc.executable } } };
        return { w, t, p, dir };
      };
      // Resumed and claimed right after the restart: the card stays blocked and the claim returns only once the old command is gone.
      const L = await leftover(E.env, 'left');
      E.api.loadRun(L.w, { id: 'restart', status: 'paused', tasks: [L.t], activity: [], convs: {} });
      assert.ok(L.t.preparing, 'still blocked while the old command is being ended');
      L.w.run.active = true; L.w.run.paused = false; E.api.pump(L.w);
      assert.ok(L.t.status === 'WAITING' && !L.w.executingSteps?.has(L.t.id), 'the card does not start before the old command has ended');
      L.w.run.active = false; L.w.run.paused = true;
      await E.api.claimWorkspace(L.dir, { label: 'right after restart' });
      assert.ok(!alive(L.p.pid) && !L.t.preparing && !L.t.worktree.setupProc, 'the claim returned only after the old setup command was ended');
      await E.api.releaseClaim(L.dir);
      // The kill fails: everything stays blocked, the identity is kept for a retry, and nothing says it was ended.
      const E2 = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree: async () => ({ ok: false, killed: false }), execFile });
      const F = await leftover(E2.env, 'stuck');
      E2.api.loadRun(F.w, { id: 'restart2', status: 'paused', tasks: [F.t], activity: [], convs: {} });
      for (let i = 0; i < 500 && !F.t.worktree.setupKillError; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(F.t.preparing && F.t.worktree.setupProc?.pid === F.p.pid && F.t.worktree.setupKillError, 'a failed kill keeps the card blocked and the identity for a retry');
      assert.ok(!E2.env.logs.some((l) => l.text.includes('已終止')) && E2.env.logs.some((l) => l.text.includes('無法確認已停止')), 'a failed kill is not reported as ended');
      await assert.rejects(E2.api.resume(F.w), /無法確認已停止/, 'Resume retries and refuses while it cannot be ended');
      await assert.rejects(E2.api.claimWorkspace(F.dir, { label: 'too early' }), /無法確認已停止/, 'a claim retries and refuses while it cannot be ended');
      await assert.rejects(Promise.resolve().then(() => E2.api.closeWorkspace(F.w)), /準備/, 'the project cannot be closed meanwhile');
      E2.env.S.leases = E2.env.S.leases || {};
      const leasesBefore = JSON.stringify(E2.env.S.leases);
      await assert.rejects(E2.api.stopAndDrain(F.w), /無法確認已停止/, 'Stop retries and refuses while it cannot be ended');
      assert.ok(F.t.preparing && F.t.worktree.setupProc?.pid === F.p.pid && !F.w.run.stopped && F.w.tasks.includes(F.t) && JSON.stringify(E2.env.S.leases) === leasesBefore, 'a refused Stop keeps the card, the identity and the leases');
      F.p.kill();
      // No creation time saved (Studio closed before the snapshot came back) and the PID is alive: maybe a reused PID, so it is not killed.
      const E3 = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree: async (pid) => { throw new Error('must not kill PID ' + pid); }, execFile });
      const U = await leftover(E3.env, 'unknown');
      U.t.worktree.setupProc = { pid: U.p.pid, command: 'ping -n 60 127.0.0.1' };
      E3.api.loadRun(U.w, { id: 'restart3', status: 'paused', tasks: [U.t], activity: [], convs: {} });
      for (let i = 0; i < 500 && !U.t.worktree.setupKillError; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(alive(U.p.pid) && U.t.preparing && /無法確認是不是當時的設定指令/.test(U.t.worktree.setupKillError), 'an unconfirmed identity blocks instead of killing');
      await assert.rejects(E3.api.claimWorkspace(U.dir, { label: 'unknown' }), /無法確認/, 'a claim stays refused meanwhile');
      U.p.kill();
      for (let i = 0; i < 200 && alive(U.p.pid); i++) await new Promise((r) => setTimeout(r, 20));
      await E3.api.claimWorkspace(U.dir, { label: 'after it ended' }); // the PID is gone: the retry clears the card
      assert.ok(!U.t.preparing && !U.t.worktree.setupProc, 'once the PID is gone the card is unblocked');
      await E3.api.releaseClaim(U.dir);
      // The real start(), sharing the env's launch lock and setup registry.
      const makeStart = (E, planned) => {
        const deps = { ...E.env, launching: E.api.launching, endLeftSetups: E.api.endLeftSetups, settingUp: E.api.settingUp, resume: E.api.resume,
          stillStopping: () => false, latestJob: () => null, projectContext: () => '', knownRefs: () => [], planPhase: () => { planned.n++; } };
        const names = Object.keys(deps);
        return new Function(...names, region('const CONTINUE_RE =', 'async function planPhase(w)') + '\nreturn start;')(...names.map((k) => deps[k]));
      };
      // Concurrency while a restart's leftover is being ended (a slow kill keeps the window open): a second Resume and a
      // Start are refused, Stop waits for the same cleanup, and the Resume that waited does not revive the stopped job.
      {
        const E4 = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree: async (pid) => { await new Promise((r) => setTimeout(r, 1500)); return killProcessTree(pid); }, execFile });
        const planned = { n: 0 }, start = makeStart(E4, planned);
        const C = await leftover(E4.env, 'race');
        E4.api.loadRun(C.w, { id: 'restart4', status: 'paused', tasks: [C.t], activity: [], convs: {} });
        const r1 = E4.api.resume(C.w);
        await assert.rejects(E4.api.resume(C.w), /正在開始或繼續/, 'a second Resume is refused while the first waits');
        await assert.rejects(start(C.w, 'another job'), /正在開始或繼續/, 'a Start is refused while a Resume waits');
        const stopping = E4.api.stopAndDrain(C.w);
        await assert.rejects(r1, /已被停止|已經停止/, 'the Resume that waited sees the Stop and gives up');
        await stopping;
        assert.ok(!alive(C.p.pid) && !C.t.preparing && C.w.run.stopped && !C.w.run.active && planned.n === 0, 'Stop waited for the old command; nothing was started');
        const s1 = start(C.w, 'job one'), s2 = start(C.w, 'job two');
        await s1; await assert.rejects(s2, /正在開始或繼續|正在工作中/, 'two Starts at once make one job');
        assert.ok(planned.n === 1 && C.w.run.request === 'job one', 'only the first Start made a job');
      }
      // A live setup command whose kill fails: a new job is refused while it runs, Stop keeps the job paused (only a paused
      // job is loaded after a restart) and the card blocked with its identity; once the command is gone, Stop goes through.
      {
        // The failed kill reports a process of the tree as still there (a real one, outliving the command).
        const stray = spawn('ping', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
        for (let i = 0; i < 100 && !(await processSnapshot()).some((r) => r.pid === stray.pid); i++) await new Promise((r) => setTimeout(r, 20));
        const E5 = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree: async (pid) => ({ ok: false, killed: false, rootPid: pid, remaining: [pid, stray.pid] }), execFile });
        const planned = { n: 0 }, start = makeStart(E5, planned);
        const w = newW(); w.project = repo; w.run.project = repo; w.run.active = true; w.worktreeSetup = 'ping -n 3 127.0.0.1 > nul';
        E5.env.S.workspaces.length = 0; E5.env.S.workspaces.push(w);
        const t = { id: 'live', title: 'live', agent: 'codex', writes: true, status: 'WAITING', after: [] }, t2 = { id: 'late', title: 'late', agent: 'claude', writes: true, status: 'WAITING', after: [] };
        w.tasks.push(t, t2);
        const making = E5.api.useWorktree(w, t.id);
        for (let i = 0; i < 300 && !t.worktree?.setupProc?.creationDate; i++) await new Promise((r) => setTimeout(r, 20));
        const pid = t.worktree.setupProc.pid;
        E5.api.pause(w);
        await assert.rejects(start(w, 'new job'), /worktree 在準備/, 'a new job is refused while a setup command runs');
        await assert.rejects(E5.api.stopAndDrain(w), /無法確認已停止/, 'Stop is refused when the kill fails');
        const child = t.worktree.setupLeft?.find((p) => p.pid === stray.pid)?.pid;
        assert.ok(child && alive(child) && t.worktree.setupLeft.every((p) => p.creationDate), 'the process the failed kill left is tracked with its identity');
        assert.ok(w.run.paused && !w.run.stopped && t.preparing && t.worktree.setupProc?.pid === pid && t.worktree.setupKillError, 'the job stays paused and the card blocked with its identity');
        trees.push(await making);
        await assert.rejects(start(w, 'new job'), /無法確認已停止|仍在執行/, 'a new job is refused while the card is stuck');
        process.kill(child); for (let i = 0; i < 300 && (alive(pid) || alive(child)); i++) await new Promise((r) => setTimeout(r, 20));
        await E5.api.stopAndDrain(w); // the command is gone now: the retry clears the card and Stop goes through
        assert.ok(w.run.stopped && !t.preparing && !t.worktree.setupProc && !t.worktree.setupLeft && planned.n === 0, 'Stop went through once the command was gone');
        await assert.rejects(E5.api.useWorktree(w, t2.id), /已經停止/, 'no new worktree on a stopped job');
      }
      const straySpawn = async () => { const s = spawn('ping', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' }); for (let i = 0; i < 100 && !(await processSnapshot()).some((r) => r.pid === s.pid); i++) await new Promise((r) => setTimeout(r, 20)); return s; };
      const gone = async (...pids) => { for (let i = 0; i < 300 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20)); };
      const liveSetup = async (E, id) => {
        const w = newW(); w.project = repo; w.run.project = repo; w.run.active = true; w.worktreeSetup = 'ping -n 3 127.0.0.1 > nul';
        E.env.S.workspaces.length = 0; E.env.S.workspaces.push(w);
        const t = { id, title: id, agent: 'codex', writes: true, status: 'WAITING', after: [] }; w.tasks.push(t);
        const making = E.api.useWorktree(w, t.id);
        for (let i = 0; i < 300 && !t.worktree?.setupProc?.creationDate; i++) await new Promise((r) => setTimeout(r, 20));
        return { w, t, making };
      };
      // A claim already waiting when a Stop's kill fails: it checks again after its wait and gets no write lease.
      {
        const stray = await straySpawn();
        const E6 = makeEnv(() => '', { RT: root, processSnapshot, killProcessTree: async (pid) => ({ ok: false, killed: false, rootPid: pid, remaining: [pid, stray.pid] }), execFile });
        const { w, t, making } = await liveSetup(E6, 'waited');
        const claim = E6.api.claimWorkspace(t.workdir, { label: 'waiting' });
        await new Promise((r) => setTimeout(r, 200)); // the claim waits for the setup command
        await assert.rejects(E6.api.stopAndDrain(w), /無法確認已停止/, 'Stop is refused when the kill fails');
        await assert.rejects(claim, /無法確認已停止/, 'the waiting claim checks again and is refused');
        assert.ok(!E6.env.S.leases.some((l) => l.owner.kind === 'external' && l.status !== 'RELEASED') && t.preparing, 'no external write lease; the card stays blocked');
        trees.push(await making);
        stray.kill(); await gone(stray.pid);
      }
      // The kill leaves a child and the identity lookup then fails: the known PID is kept with no identity, so a retry
      // neither kills it (it could be a reused PID) nor takes it as gone while it is alive.
      {
        const stray = await straySpawn();
        let snapFails = false;
        const E7 = makeEnv(() => '', { RT: root, processSnapshot: async () => { if (snapFails) throw new Error('process list unavailable'); return processSnapshot(); },
          killProcessTree: async (pid) => { snapFails = true; return { ok: false, killed: false, rootPid: pid, remaining: [pid, stray.pid] }; }, execFile });
        const { w, t, making } = await liveSetup(E7, 'unknown-left');
        await assert.rejects(E7.api.stopAndDrain(w), /無法確認已停止/, 'Stop is refused when the kill fails');
        const kept = t.worktree.setupLeft?.find((p) => p.pid === stray.pid);
        assert.ok(kept && !kept.creationDate && t.preparing, 'the known PID is kept, identity unknown');
        trees.push(await making);
        snapFails = false;
        await assert.rejects(E7.api.stopAndDrain(w), /無法確認是不是當時的設定指令/, 'a retry keeps blocking while that PID is alive');
        assert.ok(alive(stray.pid) && t.preparing && w.run.paused && !w.run.stopped, 'it was not killed and the job stays paused');
        stray.kill(); await gone(stray.pid);
        snapFails = false; await E7.api.stopAndDrain(w);
        assert.ok(w.run.stopped && !t.preparing && !t.worktree.setupLeft, 'once that PID is gone, Stop goes through');
      }
    }
    // retry budget: a timed retry finishes a cleanup whose branch deletion failed; three temporary failures stop it; 保留 / 重試清理
    if (git('remote')) git('remote', 'remove', 'origin');
    const fresh = async (id) => { const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false; E.env.S.workspaces.length = 0; E.env.S.workspaces.push(w);
      const t = { id, title: id, agent: 'codex', writes: true, status: 'PAUSED', after: [] }; w.tasks.push(t); const r = await E.api.useWorktree(w, id); t.status = 'DONE'; trees.push(r); return { w, t, ...r }; };
    let c = await fresh('retry1');
    scenario = 'ref-error'; await E.api.cleanupWorktree(c.w, c.t);
    assert.ok(c.t.worktree.removed && c.t.worktree.retryAt > Date.now() && c.t.worktree.cleanupTries === 1);
    scenario = 'clean'; E.api.retryCleanups(c.t.worktree.retryAt);
    for (let i = 0; i < 200 && !c.t.worktree.cleaned; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(c.t.worktree.cleaned && !git('branch', '--list', c.branch), 'the timed retry deleted the branch the first try left');
    c = await fresh('inuse');
    scenario = 'ref-error'; await E.api.cleanupWorktree(c.w, c.t);
    const other = path.join(root, 'other-wt'); git('worktree', 'add', other, c.branch); trees.push({ path: other });
    scenario = 'clean'; await E.api.cleanupWorktree(c.w, c.t);
    assert.deepStrictEqual([!!c.t.worktree.cleaned, c.t.worktree.cleanupError, c.t.worktree.retryAt, !!git('branch', '--list', c.branch)], [false, '分支仍有其他 worktree 使用', 0, true], 'a branch another worktree checked out is kept');
    git('worktree', 'remove', other);
    c = await fresh('retry2');
    scenario = 'remove-error';
    for (let i = 0; i < 3; i++) await E.api.cleanupWorktree(c.w, c.t);
    assert.deepStrictEqual([c.t.worktree.cleanupTries, c.t.worktree.retryAt], [3, 0], 'third temporary failure: no more automatic tries');
    await E.api.worktreeCleanupAction(c.w, c.t.id, 'keep');
    assert.ok(c.t.worktree.kept && E.env.logs.at(-1).text.includes('保留'));
    scenario = 'clean'; await E.api.worktreeCleanupAction(c.w, c.t.id, 'retry');
    assert.ok(c.t.worktree.cleaned && !c.t.worktree.kept && !fs.existsSync(c.path), '重試清理 runs now with a fresh budget');
    console.log('worktree cleanup: dirty/ignored files, failed checks/removal, current PR HEAD, squash merge, moved ref, path containment, .worktreeinclude copy/link and its removal, worktree setup command, retry budget, keep / retry: PASS');
  } finally {
    for (const wt of trees) if (fs.existsSync(wt.path)) git('worktree', 'remove', '--force', wt.path);
    fs.rmdirSync(root); fs.rmSync(real, { recursive: true, force: true, maxRetries: 40, retryDelay: 150 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
