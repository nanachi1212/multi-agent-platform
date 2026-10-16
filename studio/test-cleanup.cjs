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
    for (scenario of ['clean', 'dirty', 'ignored', 'status-error', 'remove-error', 'ref-error', 'moved-ref', 'old-pr', 'squash-pr', 'outside']) {
      calls = []; const w = newW(); w.project = repo; w.run.project = repo; w.run.active = false;
      const t = { id: scenario, title: scenario, agent: 'codex', writes: true, status: 'PAUSED', after: [] }; w.tasks.push(t);
      const { path: dir, branch } = await E.api.useWorktree(w, t.id); trees.push({ path: dir, branch });
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
      if (['clean', 'squash-pr'].includes(scenario)) {
        assert.strictEqual(t.worktree.cleaned, true); assert.ok(!fs.existsSync(dir)); assert.strictEqual(git('branch', '--list', branch), '');
      } else {
        assert.ok(!t.worktree.cleaned && t.worktree.cleanupError, scenario);
        assert.ok(git('branch', '--list', branch), 'unremoved branch is preserved');
        assert.strictEqual(fs.existsSync(dir), !['ref-error', 'moved-ref'].includes(scenario));
        if (scenario === 'moved-ref') assert.strictEqual(git('rev-parse', branch), moved);
        if (scenario === 'ignored') assert.strictEqual(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), 'must survive');
      }
    }
    console.log('worktree cleanup: dirty/ignored files, failed checks/removal, current PR HEAD, squash merge, moved ref and path containment: PASS');
  } finally {
    for (const wt of trees) if (fs.existsSync(wt.path)) git('worktree', 'remove', '--force', wt.path);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
