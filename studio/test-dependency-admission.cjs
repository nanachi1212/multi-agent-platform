const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { makeEnv, newW, mkTmp } = require('./lifecycle-harness.cjs');

(async () => {
  const temp = mkTmp('studio-dependency-admission-'), repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const file = dir => path.join(dir, 'source.txt');
  const runtimes = [];
  try {
    git(repo, 'init', '-qb', 'main');
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(file(repo), 'base');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    // A dependency admits a card to start in this tree. Answering its question continues that same card.
    async function resumedWriter({ sibling = false, move = false, oldHistory = false, edit = true } = {}) {
      fs.writeFileSync(file(repo), 'A');
      git(repo, 'commit', '--allow-empty', '-qam', 'input verified by check');
      const w = newW(); w.project = w.run.project = repo;
      w.run.startedAt = new Date().toISOString();
      let turns = 0, summary = '';
      const { api, env } = makeEnv((_agent, prompt) => {
        if (prompt.includes('Every current card has ended')) { summary = prompt; return '{"needs_user":"Finished"}'; }
        if (prompt.includes('Task: check')) return 'PASS\nSTATUS: DONE';
        if (++turns === 1) {
          if (edit) fs.writeFileSync(file(repo), 'B');
          return 'Waiting for input.\nSTATUS: NEEDS_USER: Continue?';
        }
        return 'Resumed\nSTATUS: DONE';
      }, { execFile });
      runtimes.push(env.RT); env.S.workspaces.push(w);
      const check = { id: 'check', title: 'check', role: 'check', agent: 'codex', writes: true, after: [], status: 'WAITING' };
      const writer = { id: edit ? 'writer' : 'clean-writer', title: 'edit', role: 'build', agent: 'antigravity', writes: true, after: ['check'], status: 'WAITING' };
      w.tasks.push(check, writer);
      const live = () => env.S.leases.filter(l => l.cardId === writer.id && l.mode === 'write' && l.status !== 'RELEASED');
      await api.runTask(w, check); assert.equal(check.status, 'DONE', check.result);
      await api.runTask(w, writer); assert.equal(writer.status, 'NEEDS_USER', writer.result);
      assert.deepEqual(live().map(l => l.status), ['RESERVED']);
      if (oldHistory) delete writer.admittedWorkdir;
      if (sibling) { // A later sibling has never started and must still reject the old PASS.
        const next = { id: 'sibling', title: 'delivery', agent: 'codex', writes: false, after: ['check'], status: 'WAITING' };
        w.tasks.push(next); await api.runTask(w, next);
        assert.equal(next.status, 'FAILED'); assert.equal(check.verdictStale, true);
        assert.equal(live().length, 1, 'rejecting the sibling must preserve the parked writer lease');
      }
      if (move) await api.useWorktree(w, writer.id);
      w.run.phase = 'working';
      api.answer(w, writer.id, 'Continue');
      await w.executingSteps?.get(writer.id)?.done;
      const rejected = move && edit;
      assert.equal(writer.status, rejected ? 'FAILED' : 'DONE', writer.result);
      assert.equal(turns, rejected ? 1 : 2);
      assert.deepEqual(live(), []);
      assert.equal(w.lockTimers?.size || 0, 0);
      if (move) assert.ok(Object.values(w.lockPaths).filter(Boolean).every(p => !fs.existsSync(p)));
      assert.equal(check.status, rejected || sibling ? 'FAILED' : 'DONE');
      if (!rejected && edit) {
        await Promise.all(w.leaderSteps || []);
        assert.match(summary, /驗證後有修改，結論未覆蓋最新版本/);
      }
    }
    await resumedWriter();
    await resumedWriter({ sibling: true, oldHistory: true });
    await resumedWriter({ move: true, oldHistory: true });
    await resumedWriter({ move: true, edit: false });

    // A never-started card may already own a reservation after handoff.
    const handoff = newW(); handoff.project = handoff.run.project = repo;
    const { api: h, env: e } = makeEnv(() => 'PASS\nSTATUS: DONE', { execFile });
    runtimes.push(e.RT); e.S.workspaces.push(handoff);
    const verifier = { id: 'v', title: 'verify', role: 'review', agent: 'codex', writes: false, status: 'DONE', verifiedAt: {
      dir: repo, head: git(repo, 'rev-parse', 'HEAD'), tree: await h.snapTree(repo),
    } };
    const pending = { id: 'p', title: 'deliver', role: 'build', agent: 'codex', writes: true, status: 'WAITING', after: ['v'] };
    handoff.tasks.push(verifier, pending);
    await h.handoffWriter(handoff, 'antigravity', pending.id);
    assert.ok(e.S.leases.some(l => l.cardId === 'p' && l.status === 'RESERVED'));
    fs.writeFileSync(file(repo), 'changed after handoff');
    const earlier = { id: 'e', title: 'earlier', agent: 'codex', writes: false, status: 'WAITING', after: ['v'] };
    handoff.tasks.push(earlier); await h.runTask(handoff, earlier);
    assert.equal(verifier.verdictStale, true);
    handoff.run.phase = 'working'; h.pump(handoff);
    await handoff.executingSteps?.get(pending.id)?.done;
    assert.equal(pending.status, 'FAILED');
    assert.ok(!pending.firstStartedAt);
    assert.ok(!e.S.leases.some(l => l.cardId === 'p' && l.status !== 'RELEASED'));

    // Stop while the real Git preflight still holds its answer. The result is stale
    // by the time Git replies, but the stopped card must never dispatch or invalidate its prerequisite.
    const job = newW(); job.project = job.run.project = repo;
    const checked = Promise.withResolvers(), resumeGit = Promise.withResolvers(), stopped = Promise.withResolvers();
    const snapshots = [];
    const delayedGit = (cmd, args, opts, callback) => execFile(cmd, args, opts, async (...result) => {
      if (args.includes('--show-toplevel') && args.includes('--verify')) {
        checked.resolve(); await resumeGit.promise;
      }
      callback(...result);
    });
    const halted = makeEnv(() => assert.fail('a stopped admission sent work'), { execFile: delayedGit,
      saveRun(w, status) {
        if (status === 'stopped') { snapshots.push(w.tasks.at(-1).status); stopped.resolve(); }
      } });
    runtimes.push(halted.env.RT); halted.env.S.workspaces.push(job);
    const source = { id: 'checked', title: 'check', role: 'check', agent: 'codex', writes: true, status: 'DONE', verdictStale: false,
      verifiedAt: { dir: repo, head: git(repo, 'rev-parse', 'HEAD'), tree: await halted.api.snapTree(repo) } };
    fs.writeFileSync(file(repo), 'changed after the last PASS');
    const target = { id: 'last', title: 'deliver', agent: 'codex', writes: true, after: [source.id], status: 'WAITING' };
    job.tasks.push(source, target);
    const admission = halted.api.runTask(job, target);
    const timeout = AbortSignal.timeout(10000);
    const deadline = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('stop preflight timed out')), { once: true }));
    let stopping;
    try {
      await Promise.race([checked.promise, deadline]);
      stopping = halted.api.stopAndDrain(job);
      await Promise.race([stopped.promise, deadline]);
    } finally { resumeGit.resolve(); await Promise.all([admission, stopping]); }
    assert.equal(job.run.result, 'stopped');
    assert.equal(target.status, 'FAILED', 'stopped preflight must not leave the card WORKING');
    assert.equal(target.result, '已停止');
    assert.equal(snapshots.at(-1), 'FAILED');
    assert.equal(target.firstStartedAt, undefined);
    assert.equal(source.status, 'DONE'); assert.equal(source.verdictStale, false);
    assert.equal(halted.env.prompts.length, 0); assert.equal(job.executingSteps.size, 0);
    assert.ok(!halted.env.S.leases.some(l => l.status !== 'RELEASED'));
  } finally {
    for (const dir of [...runtimes, temp]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
  console.log('Dependency admission: continuation, changed worktree, stale siblings and reservation cleanup PASS');
})().catch(err => { console.error(err); process.exitCode = 1; });
