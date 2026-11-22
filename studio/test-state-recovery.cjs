// Production claimRuntime with deterministic OS identities; real temporary filesystem only.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('State recovery');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'state-files.mjs'), 'utf8');
  const code = source.slice(source.indexOf('export async function claimRuntime')).replace('export async function', 'async function') + '\nreturn claimRuntime;';
  const info = async pid => ({ pid, exists: true, creationDate: 'new', executable: 'node.exe' });
  const build = (io = fs) => new Function('fs', 'path', 'crypto', 'getProcessInfo', 'isPidAlive', code)(io, path, crypto, info, pid => pid === process.pid);
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'state-recovery-'));
  fs.mkdirSync(path.join(rt, 'studio'));
  const file = path.join(rt, 'studio', 'instance.lock'), gate = file + '.reclaim';
  const dead = JSON.stringify({ pid: 2147483000 });
  const clear = () => { for (const f of fs.readdirSync(path.dirname(file))) fs.unlinkSync(path.join(path.dirname(file), f)); };
  const stale = () => { fs.writeFileSync(file, dead); fs.writeFileSync(gate, dead); };
  try {
    const claim = build(); stale();
    const results = await Promise.allSettled([claim(rt), claim(rt)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(lock.pid, process.pid); assert.ok(lock.token);
    assert.equal(fs.readFileSync(gate, 'utf8'), dead, 'dead predecessor is immutable');
    await assert.rejects(claim(rt), /重複啟動/);
    results.find(r => r.status === 'fulfilled').value();
    assert.ok(!fs.existsSync(file), 'winning claimant retains the release token');
    (await claim(rt))(); // recovery did not corrupt subsequent startup
    clear(); stale();
    const recycled = JSON.stringify({ pid: process.pid, creationDate: 'old', executable: 'node.exe' });
    fs.writeFileSync(gate, recycled); (await claim(rt))();
    assert.equal(fs.readFileSync(gate, 'utf8'), recycled, 'PID reuse allows successor, not predecessor deletion');
    for (const bad of ['', '{', '{}', JSON.stringify({ pid: process.pid, creationDate: 'new', executable: 'node.exe' })]) {
      clear(); stale(); fs.writeFileSync(gate, bad);
      await assert.rejects(claim(rt)); assert.equal(fs.readFileSync(file, 'utf8'), dead);
      assert.equal(fs.readFileSync(gate, 'utf8'), bad);
    }
    clear(); stale();
    await assert.rejects(build({ ...fs, linkSync() { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } })(rt), /atomic hard-link/);
    assert.equal(fs.readFileSync(file, 'utf8'), dead);
    clear(); stale(); let failed = false;
    const release = await build({ ...fs, unlinkSync(f) {
      if (f.startsWith(gate + '.') && !f.includes('.candidate-') && !failed) { failed = true; throw Object.assign(new Error('busy'), { code: 'EPERM' }); }
      return fs.unlinkSync(f);
    } })(rt);
    assert.ok(failed); assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid); release();
    finished();
    console.log('State recovery: concurrent dead-guard reclamation preserves winner token, legacy/reused identities, unknown owners and hard-link failure: PASS');
  } finally { fs.rmSync(rt, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
