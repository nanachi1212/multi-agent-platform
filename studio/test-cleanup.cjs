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
    for (scenario of ['clean', 'dirty', 'ignored', 'status-error', 'remove-error', 'ref-error', 'moved-ref', 'old-pr', 'squash-pr', 'outside', 'include', 'include-edited']) {
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
      if (scenario === 'dirty' || scenario === 'ignored') fs.writeFileSync(path.join(dir, scenario === 'dirty' ? 'keep.txt' : 'ignored.txt'), 'must survive');
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
        if (scenario === 'include-edited') assert.deepStrictEqual([fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), fs.lstatSync(path.join(dir, 'deps')).isSymbolicLink(), t.worktree.cleanupError], ['edited', true, '仍有修改、未追蹤或忽略的檔案'], 'an edited copy keeps the copy, the link and the worktree');
      }
    }
    console.log('worktree cleanup: dirty/ignored files, failed checks/removal, current PR HEAD, squash merge, moved ref, path containment, .worktreeinclude copy/link and its removal: PASS');
  } finally {
    for (const wt of trees) if (fs.existsSync(wt.path)) git('worktree', 'remove', '--force', wt.path);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
