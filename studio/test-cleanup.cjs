const { assert, makeEnv, mkTmp, newW } = require('./lifecycle-harness.cjs');
const fs = require('node:fs'), path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

(async () => {
  const root = mkTmp('studio-cleanup-'), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n'); git('add', '.'); git('commit', '-qm', 'base');
  const initial = git('rev-parse', 'HEAD'), trees = [];
  let scenario, prHead, moved, calls;
  const E = makeEnv(() => '', { RT: root, execFile: (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') return cb(null, JSON.stringify([{ number: 1, headRefOid: prHead }]));
    if (scenario === 'status-error' && args.includes('status') || scenario === 'remove-error' && args.includes('remove') || scenario === 'ref-error' && args.includes('update-ref')) return cb(new Error('injected failure'), '', 'injected failure');
    execFile(cmd, args, opts, (err, out, stderr) => {
      if (!err && scenario === 'moved-ref' && args.includes('remove')) git('update-ref', 'refs/heads/' + trees.at(-1).branch, moved);
      cb(err, out, stderr);
    });
  } });
  try {
    for (scenario of ['clean', 'dirty', 'ignored', 'status-error', 'remove-error', 'ref-error', 'moved-ref', 'old-pr', 'squash-pr', 'dirty-remote', 'outside', 'include', 'include-edited']) {
      calls = []; const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false;
      const t = { id: scenario, title: scenario, agent: 'codex', writes: true, status: 'PAUSED', after: [] }; w.tasks.push(t);
      if (scenario === 'include') { // once: an ignored file and folder, and the include list itself (tracked, like Orca's)
        fs.mkdirSync(path.join(repo, 'deps')); fs.writeFileSync(path.join(repo, 'deps', 'x.txt'), 'dep');
        fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret'); fs.appendFileSync(path.join(repo, '.gitignore'), 'deps/\n');
        fs.writeFileSync(path.join(repo, '.worktreeinclude'), '# copies and links\nignored.txt\ndeps\n.gitignore\nmissing.txt\n*.log\n../outside\n');
        git('add', '.'); git('commit', '-qm', 'include list');
      }
      const { path: dir, branch } = await E.api.useWorktree(w, t.id); trees.push({ path: dir, branch });
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
      if (['clean', 'squash-pr', 'include'].includes(scenario)) {
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
    console.log('worktree cleanup: dirty/ignored files, failed checks/removal, current PR HEAD, squash merge, moved ref, path containment, .worktreeinclude copy/link and its removal, retry budget, keep / retry: PASS');
  } finally {
    for (const wt of trees) if (fs.existsSync(wt.path)) git('worktree', 'remove', '--force', wt.path);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
