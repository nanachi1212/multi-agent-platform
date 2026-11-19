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
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    git(repo, 'worktree', 'add', '-qb', 'review', wt);
    git(wt, 'commit', '--allow-empty', '-qm', 'different head');
    async function stopDuringVerdictCheck() {
      const w = newW();
      w.project = w.run.project = repo;
      Object.assign(w.run, { phase: 'working', active: false, paused: true });
      let headRead, releaseHead, observeStop;
      const stopAccepted = new Promise(resolve => { observeStop = resolve; });
      const { api, env } = makeEnv(() => 'ok\nSTATUS: DONE', {
        execFile(cmd, args, opts, callback) {
          if (cmd !== 'git' || !args.includes('--show-toplevel') || !args.includes('--verify')) {
            return execFile(cmd, args, opts, callback);
          }
          headRead = new Promise(resolve => {
            execFile(cmd, args, opts, (...result) => {
              releaseHead = () => callback(...result);
              resolve();
            });
          });
        },
        event(type, data) { if (type === 'job.end' && data.status === 'stopped') observeStop(); },
      });
      runtimes.push(env.RT);
      env.S.workspaces.push(w);
      const check = { id: 'verify', title: 'verify', role: 'check', agent: 'codex', status: 'DONE', result: 'PASS',
        verifiedAt: { dir: repo, head: git(repo, 'rev-parse', 'HEAD'), tree: await api.snapTree(repo) } };
      const writer = { id: 'deliver', title: 'deliver', role: 'build', agent: 'codex', status: 'WAITING', writes: true, after: [check.id] };
      const waiting = { id: 'next', title: 'next', role: 'review', agent: 'claude', status: 'WAITING', writes: false, after: [writer.id] };
      w.tasks.push(check, writer, waiting);
      const diskLeases = () => JSON.parse(fs.readFileSync(path.join(env.RT, 'studio', 'leases.json'), 'utf8'));
      await api.resume(w);
      assert.ok(headRead, 'resume entered the prerequisite version check');
      await headRead;
      assert.equal(writer.firstStartedAt, undefined, 'the writer has not started during version verification');
      const stop = api.stopAndDrain(w);
      try {
        await Promise.race([stopAccepted, stop.then(() => assert.fail('Stop returned while Git was held'))]);
        assert.ok(diskLeases().some(l => l.cardId === writer.id && l.status === 'RESERVED'), 'retain the writer lease while draining');
      } finally {
        releaseHead();
        await stop;
      }
      assert.equal(w.run.result, 'stopped');
      assert.equal(env.prompts.length, 0, 'no worker or leader was dispatched after Stop');
      assert.deepEqual([check.status, check.result], ['DONE', 'PASS']);
      assert.deepEqual(w.tasks.slice(1).map(t => t.status), ['FAILED', 'FAILED']);
      assert.equal(diskLeases().filter(l => l.status !== 'RELEASED').length, 0);
    }
    async function scenario(dir, role, change) {
      const w = newW(); w.project = w.run.project = dir === plain ? plain : repo;
      w.run.startedAt = new Date().toISOString();
      const { api, env } = makeEnv((_agent, prompt) => {
        if (prompt.includes('Every current card has ended')) return '{"needs_user":"Review coverage?"}';
        if (prompt.includes('Task: verify')) return (role === 'review' ? 'GO WITH CHANGES' : 'PASS') + '\nSTATUS: DONE';
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
    await stopDuringVerdictCheck();
    await scenario(repo, 'check');
    await scenario(wt, 'review', 'other');
    await scenario(wt, 'review', 'head');
    await scenario(repo, 'check', 'tree');
    await scenario(plain, 'review');
  } finally {
    for (const dir of [...runtimes, temp]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 });
  }
  console.log('verdict binding: Stop during validation, unchanged, dirty tree, HEAD-only change, non-Git, linked worktree and summary PASS');
})().catch(err => { console.error(err); process.exitCode = 1; });
