// releaseLock must not delete the lock file of a writer that took the folder while the release was still looking it up,
// and a writer that gives the folder back before it starts must not leave the skipped release's lock file behind.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { execFile, execFileSync } = require('node:child_process');
const { mkTmp, makeEnv, newW } = require('./lifecycle-harness.cjs');
const finished = require('./test-finish.cjs')('Lock release');

// a ends while its release waits for git; b takes the folder meanwhile. midway(api, w, b) runs b's part of the race.
async function race(name, midway) {
  const repo = mkTmp('studio-lock-release-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const ctl = { gate: null, hold: null };
  let entered;
  ctl.inGate = new Promise((resolve) => { entered = resolve; });
  const { api, env } = makeEnv(() => 'ok\nSTATUS: DONE', {
    execFile(cmd, args, opts, callback) {
      if (ctl.gate === 'armed' && cmd === 'git' && args.includes('--absolute-git-dir')) {
        ctl.gate = 'held';
        return execFile(cmd, args, opts, (...result) => { ctl.release = () => callback(...result); entered(); });
      }
      if (ctl.hold && cmd === 'git' && args.includes('core.quotepath=false')) { // b's look for recent edits, after its lease is taken
        const hold = ctl.hold; ctl.hold = null;
        return execFile(cmd, args, opts, (...result) => { hold().then(() => callback(...result)); });
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
    ctl.gate = 'armed';
    ctl.ending = api.endWriteStep(w, a, 'codex');
    await ctl.inGate; // a's lease is gone, its release waits for git
    b.status = 'WORKING'; // runTask marks the card before it asks for the folder
    await midway({ api, w, a, b, lock, repo, ctl });
    assert.ok(!w.run.extMod, 'no external modification is reported');
    console.log(`Lock release: ${name}: PASS`);
  } finally {
    clearTimeout(env.S.workspaces[0]?.retryTimer);
    await fs.promises.rm(env.RT, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
    await fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  }
}

(async () => {
  await race('a late release keeps the lock of the writer that took the folder meanwhile', async ({ api, w, b, lock, ctl }) => {
    assert.equal(await api.takeWriteSlot(w, b), true, 'b takes the free folder meanwhile');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).card, 'b');
    ctl.release(); await ctl.ending;
    assert.ok(fs.existsSync(lock), "a's late release keeps b's lock file");
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).card, 'b');
    assert.equal(w.lockTimers?.size, 1, "b's heartbeat still runs");
    b.status = 'DONE'; await api.endWriteStep(w, b, 'claude');
    assert.ok(!fs.existsSync(lock), 'the last writer to leave removes the lock');
  });
  await race('a writer that waits for a recent edit removes the lock a skipped release left', async ({ api, w, b, lock, repo, ctl }) => {
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'someone else'); // b will see this edit and wait
    ctl.hold = async () => { ctl.release(); await ctl.ending; }; // a's release resumes while b holds the lease, so it skips
    assert.equal(await api.takeWriteSlot(w, b), false, 'b gives the folder back and waits');
    assert.equal(b.status, 'WAITING');
    for (let i = 0; i < 100 && fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 20)); // the release runs after the step
    assert.ok(!fs.existsSync(lock), 'no Studio lock file is left while nobody of ours writes');
    assert.equal(w.lockTimers?.size || 0, 0, 'no heartbeat is left');
  });
  finished();
})().catch((e) => { console.error(e); process.exitCode = 1; });
