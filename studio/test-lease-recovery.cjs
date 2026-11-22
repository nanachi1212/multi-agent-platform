// Local filesystem/process fixtures only: no Studio server, provider, or agent is launched.
const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Lease recovery');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const dead = 2147483000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

(async () => {
  const { createWorkspaceLeaseStore } = await import('./workspace-lease.mjs');
  const dirs = [];
  const make = (io = fs, rt, instance = crypto.randomUUID()) => {
    rt ||= fs.mkdtempSync(path.join(os.tmpdir(), 'lease-recovery-'));
    if (!dirs.includes(rt)) dirs.push(rt);
    fs.mkdirSync(path.join(rt, 'studio'), { recursive: true });
    const lock = path.join(rt, 'studio', 'leases.json.lock');
    const api = createWorkspaceLeaseStore({ fs: io, path, crypto, S: { leases: [] }, RT: rt, INSTANCE: instance,
      AGENTS: {}, nowIso: () => new Date().toISOString(), pidAlive: alive, LEASE_RESERVED_TTL_MS: 1000 });
    return { api, rt, lock, gate: lock + '.reclaim' };
  };
  const put = (file, owner) => fs.writeFileSync(file, typeof owner === 'string' ? owner : JSON.stringify(owner));
  const owner = (pid = dead) => ({ pid, instance: 'fixture', token: crypto.randomUUID() });
  const stale = e => put(e.lock, owner());
  assert.equal(alive(dead), false, 'fixture dead PID must really be absent');
  try {
    const e = make(); stale(e);
    const first = owner(), second = owner();
    put(e.gate, first); put(e.gate + '.' + first.token, second);
    put(e.gate + '.candidate-' + crypto.randomUUID(), owner()); // crash before publication: not a lock
    e.api.loadLeases();
    assert.ok(!fs.existsSync(e.lock));
    assert.deepEqual(JSON.parse(fs.readFileSync(e.gate)), first, 'dead ancestor guard is never removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(e.gate + '.' + first.token)), second);
    assert.ok(!fs.existsSync(e.gate + '.' + second.token), 'only our own successor was released');

    for (const bad of ['', '{', {}, { pid: dead }, { ...owner(), token: '../escape' }, owner(process.pid)]) {
      const b = make(); stale(b); put(b.gate, typeof bad === 'string' ? bad : bad);
      const before = fs.readFileSync(b.gate, 'utf8'), primary = fs.readFileSync(b.lock, 'utf8');
      assert.throws(() => b.api.loadLeases(), /locked/);
      assert.equal(fs.readFileSync(b.gate, 'utf8'), before);
      assert.equal(fs.readFileSync(b.lock, 'utf8'), primary);
    }
    const mainLive = make(); put(mainLive.lock, owner(process.pid));
    assert.throws(() => mainLive.api.loadLeases(), /locked/);
    assert.ok(!fs.existsSync(mainLive.gate), 'live main owner is not reclaimed');

    // B read a dead guard before A published its live successor. B must not unlink A's guard.
    let raced = false, successor, rival;
    const raceFs = { ...fs, linkSync(src, dst) {
      if (dst === successor && !raced) { raced = true; put(dst, rival); }
      return fs.linkSync(src, dst);
    } };
    const race = make(raceFs), predecessor = owner(); stale(race); put(race.gate, predecessor);
    successor = race.gate + '.' + predecessor.token; rival = owner(process.pid);
    const primary = fs.readFileSync(race.lock, 'utf8');
    assert.throws(() => race.api.loadLeases(), /locked/);
    assert.equal(raced, true); assert.deepEqual(JSON.parse(fs.readFileSync(successor)), rival);
    assert.equal(fs.readFileSync(race.lock, 'utf8'), primary);

    const unsupported = make({ ...fs, linkSync() { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); } });
    stale(unsupported);
    assert.throws(() => unsupported.api.loadLeases(), /atomic hard-link support.*ENOTSUP/);
    assert.ok(fs.existsSync(unsupported.lock)); assert.ok(!fs.existsSync(unsupported.gate));
    assert.ok(!fs.readdirSync(path.dirname(unsupported.lock)).some(x => x.includes('.candidate-')));

    for (const code of ['EPERM', 'EIO']) {
      const messages = [], report = console.error;
      console.error = message => messages.push(message);
      try {
        const leftover = make({ ...fs, unlinkSync(file) {
          if (file.includes('.candidate-')) throw Object.assign(new Error('candidate cleanup failed'), { code });
          return fs.unlinkSync(file);
        } });
        stale(leftover); leftover.api.loadLeases();
        assert.ok(!fs.existsSync(leftover.lock)); assert.ok(!fs.existsSync(leftover.gate));
        assert.ok(fs.readdirSync(path.dirname(leftover.lock)).some(x => x.includes('.candidate-')));
        if (code === 'EIO') assert.match(messages.join(' '), /cleanup deferred/);
      } finally { console.error = report; }
    }

    // A stale initial observation never authorizes deleting a newly live main owner.
    let changedMain, liveOwner = owner(process.pid);
    const changed = make({ ...fs, linkSync(src, dst) {
      fs.linkSync(src, dst); if (dst === changedMain + '.reclaim') put(changedMain, liveOwner);
    } }); changedMain = changed.lock; stale(changed);
    assert.throws(() => changed.api.loadLeases(), /locked/);
    assert.deepEqual(JSON.parse(fs.readFileSync(changed.lock)), liveOwner);
    assert.ok(!fs.existsSync(changed.gate));

    // A previous reclaimer can publish the main path with open('wx'), drop its recovery
    // guard, and pause before writing its owner. A later reclaimer that already observed
    // the old dead owner must treat this new incomplete/unknown owner as contention.
    for (const contents of ['', '{', 'null', '[]', '{}', '42', '"owner"', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}', '{"pid":"2147483000"}']) {
      let mainPath, entered = false;
      const incomplete = make({ ...fs, linkSync(src, dst) {
        fs.linkSync(src, dst);
        if (dst === mainPath + '.reclaim') put(mainPath, contents);
      } }); mainPath = incomplete.lock; stale(incomplete);
      assert.throws(() => incomplete.api.withLeaseTransaction(() => { entered = true; }), /Workspace lease store is locked/);
      assert.equal(entered, false, 'unknown replacement must never enter a transaction');
      assert.equal(fs.readFileSync(mainPath, 'utf8'), contents, 'unknown replacement is not deleted');
      assert.ok(!fs.existsSync(incomplete.gate), 'our recovery guard is released on rejection');
      // The first observation has the same contract, including JSON null/scalar owners.
      assert.throws(() => incomplete.api.withLeaseTransaction(() => { entered = true; }), /Workspace lease store is locked/);
      assert.equal(entered, false);
      assert.equal(fs.readFileSync(mainPath, 'utf8'), contents);
      assert.ok(!fs.existsSync(incomplete.gate), 'unknown initial owner does not start recovery');
    }

    // Do not hide corruption of the lease data itself behind the retryable lock error.
    const corrupt = make(); put(path.join(corrupt.rt, 'studio', 'leases.json'), '{');
    assert.throws(() => corrupt.api.loadLeases(), SyntaxError);
    assert.ok(!fs.existsSync(corrupt.lock));

    // A normal claimant can win the atomic main lock after stale unlink, before reclaimer open.
    let racingMain, inserted = false;
    const overtaken = make({ ...fs, unlinkSync(file) {
      fs.unlinkSync(file);
      if (file === racingMain && !inserted) { inserted = true; put(file, liveOwner); }
    } }); racingMain = overtaken.lock; stale(overtaken);
    assert.throws(() => overtaken.api.loadLeases(), /EEXIST/);
    assert.deepEqual(JSON.parse(fs.readFileSync(overtaken.lock)), liveOwner);

    let denied = false, guardPath;
    const flaky = make({ ...fs, unlinkSync(file) {
      if (file === guardPath && !denied) { denied = true; throw Object.assign(new Error('busy'), { code: 'EPERM' }); }
      return fs.unlinkSync(file);
    } }); guardPath = flaky.gate; stale(flaky); flaky.api.loadLeases();
    assert.ok(fs.existsSync(flaky.gate)); stale(flaky);
    const stranger = make(fs, flaky.rt, 'another-store');
    assert.throws(() => stranger.api.loadLeases(), /locked/, 'same PID alone cannot reclaim another store token');
    flaky.api.loadLeases(); assert.ok(!fs.existsSync(flaky.gate), 'exact own pending guard is retried');

    let unexpectedGate, failCleanup = true;
    const messages = [], report = console.error;
    console.error = message => messages.push(message);
    try {
      const unexpected = make({ ...fs, unlinkSync(file) {
        if (file === unexpectedGate && failCleanup) { failCleanup = false; throw Object.assign(new Error('guard cleanup failed'), { code: 'EIO' }); }
        return fs.unlinkSync(file);
      } }); unexpectedGate = unexpected.gate; stale(unexpected); unexpected.api.loadLeases();
      assert.ok(!fs.existsSync(unexpected.lock), 'cleanup error cannot leak the acquired main fd/lock');
      assert.match(messages.join(' '), /guard cleanup deferred/);
      stale(unexpected); unexpected.api.loadLeases(); assert.ok(!fs.existsSync(unexpected.gate));
    } finally { console.error = report; }

    const cycle = make(), cyclic = owner(); stale(cycle); put(cycle.gate, cyclic); put(cycle.gate + '.' + cyclic.token, cyclic);
    assert.throws(() => cycle.api.loadLeases(), /locked/);
    const deep = make(); stale(deep); let next = deep.gate;
    for (let i = 0; i < 64; i++) { const p = owner(); put(next, p); next = deep.gate + '.' + p.token; }
    assert.throws(() => deep.api.loadLeases(), /locked/);
    assert.ok(fs.existsSync(deep.lock)); assert.ok(!fs.existsSync(next));

    // Actual contenders start with an abandoned main lock and recovery guard. A separate
    // exclusive critical-section sentinel detects overlapping admissions independently of the store.
    const concurrent = make(); stale(concurrent); put(concurrent.gate, owner());
    const moduleUrl = pathToFileURL(path.join(__dirname, 'workspace-lease.mjs')).href;
    const childScript = `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      (async()=>{const {createWorkspaceLeaseStore}=await import(${JSON.stringify(moduleUrl)});
      const rt=${JSON.stringify(concurrent.rt)}, marker=path.join(rt,'critical'), counter=path.join(rt,'counter');
      const api=createWorkspaceLeaseStore({fs,path,crypto,S:{leases:[]},RT:rt,INSTANCE:crypto.randomUUID(),AGENTS:{},nowIso:()=>new Date().toISOString(),pidAlive:pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}},LEASE_RESERVED_TTL_MS:1000});
      let done=0,tries=0;
      while(done<10&&tries++<3000){try{api.withLeaseTransaction(()=>{
        let fd;try{fd=fs.openSync(marker,'wx')}catch{throw new Error('OVERLAPPING ADMISSION')}
        try{const n=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;const end=Date.now()+5;while(Date.now()<end){};fs.writeFileSync(counter,String(n+1))}finally{fs.closeSync(fd);fs.unlinkSync(marker)}
      });done++}catch(e){if(!/locked|ENOENT|EEXIST/.test(e.message))throw e;await new Promise(r=>setTimeout(r,2))}}
      if(done!==10)throw new Error('contention did not settle');
      })().catch(e=>{console.error(e);process.exitCode=1});`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', childScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      const timer = setTimeout(() => { child.kill(); reject(new Error('contender timed out')); }, 20000);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output || 'contender exit ' + code)); });
    })));
    assert.equal(Number(fs.readFileSync(path.join(concurrent.rt, 'counter'))), 40);
    assert.ok(!fs.existsSync(path.join(concurrent.rt, 'critical')));
    finished();
    console.log('Lease recovery: immutable successor guards, crash residue, unknown/live owners, race exclusion, bounded chains and hard-link failures: PASS');
  } finally { for (const rt of dirs) fs.rmSync(rt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
