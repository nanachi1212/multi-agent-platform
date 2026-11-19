// Exercise the card admission and summary paths using real, disposable Git worktrees.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { makeEnv, newW, mkTmp } = require('./lifecycle-harness.cjs');

(async () => {
  const temp = mkTmp('studio-verdict-');
  const repo = path.join(temp, 'repo'), wt = path.join(temp, 'worktree'), plain = path.join(temp, 'plain');
  fs.mkdirSync(repo); fs.mkdirSync(plain);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const file = dir => path.join(dir, 'source.txt');
  const runtimes = [];
  try {
    git(repo, 'init', '-qb', 'main');
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(file(repo), 'base');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'test-output.log\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    git(repo, 'worktree', 'add', '-qb', 'review', wt);
    git(wt, 'commit', '--allow-empty', '-qm', 'different head');
    async function scenario(dir, role, change) {
      const w = newW(); w.project = w.run.project = dir === plain ? plain : repo;
      w.run.startedAt = new Date().toISOString();
      const { api, env } = makeEnv((_agent, prompt) => {
        if (prompt.includes('Every current card has ended')) return '{"needs_user":"Review coverage?"}';
        if (prompt.includes('Task: verify')) {
          if (role === 'check') fs.writeFileSync(path.join(dir, 'test-output.log'), 'test runner output');
          return (role === 'review' ? 'GO WITH CHANGES' : 'PASS') + '\nSTATUS: DONE';
        }
        if (prompt.includes('Task: edit')) fs.writeFileSync(file(dir), 'after verification');
        return 'ok\nSTATUS: DONE';
      }, { execFile });
      runtimes.push(env.RT);
      env.S.workspaces.push(w);
      const card = (id, writes, extra) => {
        const t = { id, title: id, agent: 'codex', writes, status: 'WAITING', after: [], ...extra };
        w.tasks.push(t); return t;
      };
      const check = card('verify', role === 'check', { role, workdir: dir });
      await api.runTask(w, check); assert.equal(check.status, 'DONE', check.result);
      if (dir === plain) assert.ok(env.logs.some(l => l.text.includes('無法綁定版本')));
      else {
        assert.equal(check.verifiedAt.head, git(dir, 'rev-parse', 'HEAD'));
        assert.equal(check.verifiedAt.tree, await api.snapTree(dir));
      }
      if (change === 'tree') {
        const writer = card('edit', true, { role: 'build', workdir: dir, trust: true });
        await api.runTask(w, writer); assert.equal(writer.status, 'DONE', writer.result);
      }
      if (change === 'head') git(dir, 'commit', '--allow-empty', '-qm', 'advance');
      if (change === 'other') fs.writeFileSync(file(repo), 'only main changed');
      const next = card('deliver', false, { after: ['verify'] });
      await api.runTask(w, next);
      const stale = ['tree', 'head'].includes(change);
      assert.equal(next.status, stale ? 'FAILED' : 'DONE', next.result);
      assert.equal(env.prompts.some(p => p.text.includes('Task: deliver')), !stale);
      if (stale) {
        assert.equal(check.verdictStale, true);
        assert.ok(env.logs.some(l => l.detail?.includes('驗證時是') && l.detail.includes('現在是')));
      }
      await api.summarize(w);
      const summary = env.prompts.find(p => p.text.includes('Every current card has ended'));
      assert.equal(summary.text.includes('驗證後有修改，結論未覆蓋最新版本'), change === 'tree');
    }
    await scenario(repo, 'check');
    await scenario(wt, 'review', 'other');
    await scenario(wt, 'review', 'head');
    await scenario(repo, 'check', 'tree');
    await scenario(plain, 'review');
    // A real writer completes after the reviewer reads the file, before it returns GO.
    // Both cards can legitimately run on the same physical worktree (review holds a read lease).
    async function overlappingReview(dir, writeDir) {
      fs.writeFileSync(file(dir), 'A');
      git(dir, 'commit', '--allow-empty', '-qam', 'review input');
      const w = newW(); w.project = w.run.project = repo;
      w.run.startedAt = new Date().toISOString();
      let confirmRead, finishReview, observed, deliveries = 0;
      const read = new Promise(resolve => { confirmRead = resolve; });
      const finish = new Promise(resolve => { finishReview = resolve; });
      const { api, env } = makeEnv(async (_agent, prompt) => {
        if (prompt.includes('Task: review')) {
          observed = fs.readFileSync(file(dir), 'utf8');
          confirmRead(); await finish;
          return 'GO: reviewed ' + observed + '\nSTATUS: DONE';
        }
        if (prompt.includes('Task: writer')) fs.writeFileSync(file(writeDir), 'B');
        if (prompt.includes('Task: delivery')) deliveries++;
        if (prompt.includes('Every current card has ended')) return '{"needs_user":"Probe finished"}';
        return 'Done\nSTATUS: DONE';
      }, { execFile });
      runtimes.push(env.RT); env.S.workspaces.push(w);
      const card = (id, agent, role, workdir, after = []) => ({
        id, title: id, instructions: id, agent, role, workdir, writes: role === 'build', status: 'WAITING', after, trust: true,
      });
      const review = card('review', 'codex', 'review', dir);
      const writer = card('writer', 'antigravity', 'build', writeDir);
      const delivery = card('delivery', 'codex', 'build', dir, ['review', 'writer']);
      w.tasks.push(review, writer, delivery);
      const running = api.runTask(w, review);
      try {
        await Promise.race([read, running.then(() => { throw Error('Review ended before reading A'); })]);
        await api.runTask(w, writer); assert.equal(writer.status, 'DONE', writer.result);
      } finally { finishReview(); await running; }
      assert.equal(observed, 'A');
      const changed = dir === writeDir;
      assert.equal(review.status, changed ? 'FAILED' : 'DONE', review.result);
      assert.equal(Boolean(review.verifiedAt), !changed);
      if (changed) {
        assert.equal(review.verdictStale, true);
        assert.match(review.detail, /驗證開始時是.*現在是/);
      }
      w.run.phase = 'working'; api.pump(w);
      await w.executingSteps?.get(delivery.id)?.done;
      assert.equal(delivery.status, changed ? 'FAILED' : 'DONE', delivery.result);
      assert.equal(deliveries, changed ? 0 : 1);
    }
    await overlappingReview(wt, wt);
    await overlappingReview(wt, repo);

    const w = newW(); w.project = w.run.project = repo;
    const { api, env } = makeEnv((_agent, prompt) => prompt.includes('Task: parked review')
      ? 'Read the file.\nSTATUS: NEEDS_USER: Continue?' : 'GO\nSTATUS: DONE', { execFile });
    runtimes.push(env.RT); env.S.workspaces.push(w);
    const parked = { id: 'parked', title: 'parked review', role: 'review', agent: 'codex', writes: false, after: [], status: 'WAITING' };
    w.tasks.push(parked);
    await api.runTask(w, parked);
    assert.equal(parked.status, 'NEEDS_USER', parked.result);
    fs.writeFileSync(file(repo), 'changed while waiting');
    api.answer(w, parked.id, 'Continue');
    await api.runTask(w, parked);
    assert.equal(parked.status, 'FAILED', parked.result);
    assert.equal(parked.verdictStale, true);

    for (const dir of [repo, plain]) {
      const w = newW(); w.project = w.run.project = dir;
      const { api, env } = makeEnv((_agent, prompt) => prompt.includes('Task: older review')
        ? 'Read the file.\nSTATUS: NEEDS_USER: Continue?' : 'GO\nSTATUS: DONE', { execFile });
      runtimes.push(env.RT); env.S.workspaces.push(w);
      const legacy = { id: 'legacy', title: 'older review', role: 'review', agent: 'codex', writes: false, after: [], status: 'WAITING' };
      w.tasks.push(legacy);
      await api.runTask(w, legacy);
      assert.equal(legacy.status, 'NEEDS_USER', legacy.result);
      delete legacy.verificationStart; // older history persisted the brief, but no starting version
      fs.writeFileSync(file(dir), 'updated before Studio restarted');
      api.answer(w, legacy.id, 'Continue');
      await api.runTask(w, legacy);
      assert.equal(legacy.status, dir === plain ? 'DONE' : 'FAILED', legacy.result);
      assert.equal(legacy.verifiedAt, null);
      if (dir !== plain) assert.match(legacy.detail, /缺少驗證開始時的版本/);
    }
  } finally {
    for (const dir of [...runtimes, temp]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
  console.log('verdict binding: unchanged, dirty tree, HEAD-only change, non-Git, linked worktree and summary PASS');
})().catch(err => { console.error(err); process.exitCode = 1; });
