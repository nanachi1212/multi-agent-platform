// releaseLock must not delete the lock file of a writer that took the folder while the release was still looking it up.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { execFile, execFileSync } = require('node:child_process');
const { mkTmp, makeEnv, newW } = require('./lifecycle-harness.cjs');
const finished = require('./test-finish.cjs')('Lock release');

(async () => {
  const repo = mkTmp('studio-lock-release-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  let gate = null, entered, released;
  const inGate = new Promise((resolve) => { entered = resolve; });
  const { api, env } = makeEnv(() => 'ok\nSTATUS: DONE', {
    execFile(cmd, args, opts, callback) {
      if (gate === 'armed' && cmd === 'git' && args.includes('--absolute-git-dir')) {
        gate = 'held';
        return execFile(cmd, args, opts, (...result) => { released = () => callback(...result); entered(); });
      }
      return execFile(cmd, args, opts, callback);
    },
  });
  try {
    const w = newW(); w.project = w.run.project = repo;
    Object.assign(w.run, { phase: 'working', startedAt: new Date().toISOString() });
    env.S.workspaces.push(w);
    const card = (id) => ({ id, title: id, instructions: id, role: 'build', agent: id === 'a' ? 'codex' : 'claude', writes: true, trust: true, status: id === 'a' ? 'WORKING' : 'WAITING', after: [] });
    const a = card('a'), b = card('b');
    w.tasks.push(a, b);
    assert.equal(await api.takeWriteSlot(w, a), true, 'a takes the folder');
    const lock = path.join(repo, '.git', 'studio-writer.lock');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).card, 'a');
    a.status = 'DONE';
    w.lockPaths = {}; // the release has to look the lock file up (first use of this folder by this job, e.g. after a restart)
    gate = 'armed';
    const ending = api.endWriteStep(w, a, 'codex');
    await inGate; // a's lease is gone, its release waits for git
    b.status = 'WORKING'; // runTask marks the card before it asks for the folder
    assert.equal(await api.takeWriteSlot(w, b), true, 'b takes the free folder meanwhile');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).card, 'b');
    released(); await ending;
    assert.ok(fs.existsSync(lock), "a's late release keeps b's lock file");
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).card, 'b');
    assert.equal(w.lockTimers?.size, 1, "b's heartbeat still runs");
    assert.ok(!w.run.extMod, 'no external modification is reported');
    b.status = 'DONE'; await api.endWriteStep(w, b, 'claude');
    assert.ok(!fs.existsSync(lock), 'the last writer to leave removes the lock');
    finished();
    console.log('Lock release: a late release keeps the lock of the writer that took the folder meanwhile: PASS');
  } finally {
    await fs.promises.rm(env.RT, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
    await fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
