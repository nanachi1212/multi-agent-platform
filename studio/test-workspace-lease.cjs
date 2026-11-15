// Targeted ownership checks. The harness executes the production lifecycle functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
async function store(rt, instance, fileSystem = fs) {
  const { createWorkspaceLeaseStore } = await import(pathToFileURL(path.join(__dirname, 'workspace-lease.mjs')));
  const S = { leases: [] };
  const api = createWorkspaceLeaseStore({ fs: fileSystem, path, crypto, S, RT: rt, INSTANCE: instance,
    AGENTS: { codex: { name: 'Codex' }, claude: { name: 'Claude Code' } }, nowIso: () => new Date().toISOString(),
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }, LEASE_RESERVED_TTL_MS: 43200000 });
  return { S, api };
}
module.exports = async function run({ makeEnv, mkTmp, region }) {
  const dirs = [], environments = [], worktrees = [];
  const tmp = (prefix) => { const d = mkTmp(prefix); dirs.push(d); return d; };
  const repo = () => {
    const d = tmp('lease-space-');
    const git = (...args) => execFileSync('git', args, { cwd: d, windowsHide: true, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(d, 'dirty.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
    return { d, git };
  };
  const setup = (project, extra = {}) => {
    const rt = tmp('lease-store-');
    const E = makeEnv(() => 'STATUS: DONE', { RT: rt, execFile, ...extra }); E.api.loadLeases();
    const w = { project, leader: 'claude', workers: ['codex', 'claude'], activity: [], tasks: [],
      run: { id: crypto.randomUUID(), project, startedAt: new Date().toISOString(), convs: {}, phase: 'working', active: false, paused: true, stopped: false, leader: 'claude' } };
    E.env.S.workspaces.push(w);
    const t = { id: crypto.randomUUID(), title: 'ownership regression', instructions: 'work', agent: 'codex', writes: true, status: 'PAUSED', after: [] };
    w.tasks.push(t); environments.push(w); return { ...E, w, t, rt };
  };
  const writers = (E) => E.env.S.leases.filter((l) => l.mode === 'write' && l.status !== 'RELEASED');
  try {
    // A/B/F: canonical identity, multiple readers, independent worktree writers.
    const R = repo(), E = setup(R.d), info = await E.api.workspaceOf(R.d);
    fs.mkdirSync(path.join(R.d, 'sub'));
    assert.equal((await E.api.workspaceOf(path.join(R.d, 'sub'))).key, info.key);
    { // concurrent lookups share one git query, but a finished lookup is never reused
      const [a, b] = await Promise.all([E.api.workspaceOf(R.d), E.api.workspaceOf(R.d)]);
      assert.deepEqual(a, b); assert.notStrictEqual(a, b, 'each caller gets its own copy');
      R.git('checkout', '-qb', 'moved'); assert.equal((await E.api.workspaceOf(R.d)).branch, 'moved', 'a later lookup sees the new branch');
      R.git('checkout', '-q', 'main'); R.git('branch', '-qD', 'moved');
    }
    const first = E.api.acquireWrite(E.w, E.t, info); assert.equal(first.ok, true);
    const other = { ...E.t, id: 'other', agent: 'claude' };
    assert.equal(E.api.acquireWrite(E.w, other, info).ok, false, 'A second writer refused');
    assert.equal(await E.api.takeWriteSlot(E.w, { ...other, writes: false }), true, 'B reviewer allowed');
    assert.equal(await E.api.takeWriteSlot(E.w, { ...other, id: 'review-2', writes: false }), true, 'B second reviewer allowed');
    const wt = path.join(E.rt, 'separate-tree'); R.git('worktree', 'add', '-qb', 'separate', wt); worktrees.push({ repo: R.d, path: wt });
    const wi = await E.api.workspaceOf(wt); assert.notEqual(wi.key, info.key);
    assert.equal(E.api.acquireWrite(E.w, other, wi).ok, true, 'F linked worktree gets own writer');
    assert.equal(first.lease.worktree, info.path); assert.equal(first.lease.provider, 'codex');
    console.log('lease A/B/F canonical identity, writer/read leases, independent worktrees: PASS');
    assert.throws(() => E.api.releaseLease(first.lease.id), /不能強制釋放/);
    E.env.S.leases.find((l) => l.id === first.lease.id).status = 'RESERVED'; E.api.saveLeases();
    assert.throws(() => E.api.releaseLease(first.lease.id), /不能強制釋放/, 'manual release cannot bypass a pending stop');

    // A silent live Studio is not stale, even when another instance loaded the same job/card snapshot.
    const silent = await store(tmp('lease-silent-'), 'current');
    const silentLease = { ...first.lease, id: 'silent', instance: 'other', heartbeatAt: '2000-01-01T00:00:00Z', acquiredAt: '2000-01-01T00:00:00Z' };
    for (const pid of [process.pid, null]) for (const status of ['ACTIVE', 'RESERVED']) {
      Object.assign(silentLease, { pid, status }); silent.S.leases = [silentLease]; silent.api.saveLeases();
      assert.equal(silent.api.leaseState(silentLease), status);
      assert.equal(silent.api.acquireWrite(E.w, E.t, info).ok, false, 'same-card snapshot cannot steal a live or unknown holder');
    }
    const mirrorRepo = repo(), blocked = setup(mirrorRepo.d);
    const mirrorPath = path.join(mirrorRepo.d, '.git', 'studio-writer.lock');
    for (const pid of [process.pid, null]) {
      const contents = JSON.stringify({ owner: 'other Studio', instance: 'other', pid, beat: '2000-01-01T00:00:00Z' });
      fs.writeFileSync(mirrorPath, contents);
      assert.equal(await blocked.api.takeWriteSlot(blocked.w, blocked.t), false, 'old live/unknown mirror blocks writing');
      await assert.rejects(blocked.api.claimWorkspace(mirrorRepo.d), /held by another owner/);
      assert.equal(fs.readFileSync(mirrorPath, 'utf8'), contents);
    }
    console.log('lease silent live/unknown owners and same-card snapshots cannot be taken over: PASS');

    // C/D: revocation survives replacement release, restart, stale pre-handoff records.
    const H = setup(repo().d), hi = await H.api.workspaceOf(H.w.project);
    H.api.acquireWrite(H.w, H.t, hi); const old = structuredClone(H.t);
    H.w.run.convs['codex:work'] = 'old-conversation';
    await H.api.handoffWriter(H.w, 'claude', H.t.id);
    const replacement = writers(H).find((l) => l.owner.agent === 'claude'); assert.equal(replacement.status, 'RESERVED');
    await H.api.handoffWriter(H.w, 'codex', H.t.id);
    assert.equal(H.t.leaseGeneration, 2, 'explicit return to original agent gets a fresh ownership generation');
    const finalWriter = writers(H).find((l) => l.owner.agent === 'codex');
    assert.equal(finalWriter.generation, 2);
    H.api.retire(finalWriter, 'new agent finished'); H.api.saveLeases();
    const restarted = await store(H.rt, 'restarted'); restarted.api.loadLeases();
    assert.equal(restarted.api.acquireWrite(H.w, old, hi).ok, false, 'old writer stays revoked after replacement finishes');
    assert.ok(H.env.S.leases.find((l) => l.owner.agent === 'codex').revoked);
    assert.equal(H.t.agent, 'codex'); assert.equal(H.t.handoffs.length, 2);
    assert.equal(H.w.run.convs['codex:work'], 'old-conversation');
    console.log('lease C/D durable handoff revocation, same branch/worktree and retained conversation: PASS');

    // A failed stop confirmation cannot publish an external claim or move ownership.
    const X = setup(repo().d, { stopTurn: async () => false });
    X.w.run.convs['codex:work'] = 'old-conversation'; X.w.run.active = true; X.w.run.paused = false; X.t.status = 'WORKING';
    X.api.acquireWrite(X.w, X.t, await X.api.workspaceOf(X.w.project));
    await assert.rejects(X.api.claimWorkspace(X.w.project), /還沒有真的停/);
    assert.equal(writers(X)[0].owner.agent, 'codex');
    await assert.rejects(X.api.handoffWriter(X.w, 'claude', X.t.id), /還沒有真的停/);
    assert.equal(X.t.agent, 'codex'); assert.equal(writers(X).length, 1);
    console.log('lease C/G failed cancellation keeps original lease: PASS');

    // PAUSE visible state never substitutes for execution confirmation; STOP is durable.
    const P = setup(repo().d); let resolve;
    P.w.executingSteps = new Map([[P.t.id, { done: new Promise((r) => { resolve = r; }), agent: 'codex' }]]);
    await assert.rejects(P.api.reassign(P.w, P.t.id, 'claude'), /停下中/);
    await assert.rejects(P.api.resume(P.w), /停下中/); resolve(); P.w.executingSteps.clear();
    const infoP = await P.api.workspaceOf(P.w.project); P.api.acquireWrite(P.w, P.t, infoP);
    P.api.retire(writers(P)[0], 'writing card completed before STOP'); P.api.saveLeases();
    P.w.run.active = true; P.w.run.paused = false; P.t.status = 'WAITING'; P.api.stop(P.w);
    const restartP = await store(P.rt, 'after-stop'); restartP.api.loadLeases();
    const staleRun = { ...P.w, run: { ...P.w.run, stopped: false, paused: true } };
    assert.equal(restartP.api.acquireWrite(staleRun, P.t, infoP).ok, false, 'stopped job cannot reacquire from stale snapshot');
    assert.throws(() => P.api.loadRun(P.w, { status: 'stopped' }), /停止或完成/);
    console.log('lease PAUSE drain guard and E STOP tombstone across restart: PASS');

    // Restart never skips a latest STOP record to revive an older paused job.
    const boot = region('// Show each open project', 'await startAion();');
    const ws = { project: 'repo' }, loaded = [];
    const restore = new Function('S', 'historyItems', 'same', 'resumable', 'loadRun', boot);
    restore({ workspaces: [ws] }, () => [{ project: 'repo', status: 'stopped' }, { project: 'repo', status: 'paused' }], (a, b) => a === b, (r) => r.status === 'paused', (_, r) => loaded.push(r));
    assert.equal(loaded.length, 0);
    restore({ workspaces: [ws] }, () => [{ project: 'repo', status: 'paused' }], (a, b) => a === b, (r) => r.status === 'paused', (_, r) => loaded.push(r));
    assert.equal(loaded.length, 1);
    const L = setup(repo().d); L.api.loadRun(L.w, { id: 'paused', status: 'paused', project: L.w.project, tasks: [{ id: 'queued', status: 'WAITING' }], activity: [] });
    assert.equal(L.w.run.active, false); assert.equal(L.w.run.paused, true); L.api.pump(L.w); assert.equal(L.env.prompts.length, 0);
    console.log('lease D/E startup preserves pause and does not revive jobs older than STOP: PASS');

    // History list and detail show the same status: a no-longer-live "running" record is interrupted in both.
    const historyStatus = new Function('S', region('const resumable =', '\nfunction loadRun') + region('const historyStatus =', '\nconst histRow') + 'return historyStatus;')({ workspaces: [{ run: { id: 'live', active: true } }] });
    assert.deepEqual(['dead', 'live'].map((id) => historyStatus({ id, status: 'running' })), ['interrupted', 'running']);
    assert.equal(historyStatus({ id: 'p', status: 'paused' }), 'paused');
    assert.match(region('const hist = req.method', 'if (!fn)'), /historyStatus\(r\)/, 'the /api/history/:id detail uses the same status as the list');
    assert.match(region('const histRow =', 'project: r.project'), /status: historyStatus\(r\)/);
    console.log('history list and detail share the interrupted status: PASS');

    // G: explicit external ownership persists even when its optional PID exits; readers pass.
    const G = setup(repo().d);
    const claim = await G.api.claimWorkspace(G.w.project, { label: 'external', pid: 2147483000, description: 'manual edit', session: 'session-1' });
    assert.equal(claim.state, 'EXTERNAL'); assert.equal(claim.session, 'session-1'); assert.equal(claim.reason, 'manual edit');
    const gs = await store(G.rt, 'external-restart'); gs.api.loadLeases();
    assert.equal(gs.api.acquireWrite(G.w, G.t, await G.api.workspaceOf(G.w.project)).ok, false);
    assert.equal(await G.api.takeWriteSlot(G.w, { ...G.t, id: 'review', writes: false }), true);
    await assert.rejects(G.api.resume(G.w), /外部 Agent 接手/);
    await G.api.releaseClaim(G.w.project);
    assert.equal(G.api.acquireWrite(G.w, G.t, await G.api.workspaceOf(G.w.project)).ok, true);
    console.log('lease G durable external claim, explicit release, reader allowed: PASS');

    // M: same dirty file changes in a linked worktree, although porcelain status is unchanged.
    const M = setup(repo().d), md = path.join(M.rt, 'dirty-worktree');
    execFileSync('git', ['worktree', 'add', '-qb', 'dirty-worktree', md], { cwd: M.w.project, windowsHide: true });
    worktrees.push({ repo: M.w.project, path: md });
    M.t.workdir = md; M.t.status = 'WAITING_EXTERNAL'; M.w.run.active = true; M.w.run.paused = false;
    const file = path.join(md, 'dirty.txt'); fs.writeFileSync(file, 'dirty first');
    const mi = await M.api.workspaceOf(md); M.api.acquireWrite(M.w, M.t, mi); writers(M)[0].status = 'RESERVED'; M.api.saveLeases();
    M.w.run.treeStamps = { [M.api.treeKey(md)]: await M.api.treeStamp(M.w, md) };
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: md, encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(file, 'dirty other'); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: md, encoding: 'utf8', windowsHide: true }), before);
    await M.api.checkWorkspaces(); assert.ok(M.w.run.extMod); assert.equal(M.w.run.paused, true);
    assert.equal(writers(M)[0].flag, 'EXTERNAL_MODIFICATION_DETECTED'); assert.equal(fs.readFileSync(file, 'utf8'), 'dirty other');
    assert.equal(execFileSync('git', ['stash', 'list'], { cwd: md, encoding: 'utf8', windowsHide: true }), '');
    await assert.rejects(M.api.resume(M.w), /EXTERNAL_MODIFICATION_DETECTED/);
    console.log('lease M repeated dirty-file edits in worktree detected; files preserved: PASS');

    // Invalid data / failed persistence must prevent admission instead of silently forgetting leases.
    const broken = tmp('lease-broken-'); fs.mkdirSync(path.join(broken, 'studio')); fs.writeFileSync(path.join(broken, 'studio', 'leases.json'), '{');
    const brokenStore = await store(broken, 'broken'); assert.throws(() => brokenStore.api.loadLeases(), SyntaxError);
    const rtLock = tmp('lease-locked-'), lockStore = await store(rtLock, 'lock-test'); lockStore.api.loadLeases();
    fs.writeFileSync(path.join(rtLock, 'studio', 'leases.json.lock'), JSON.stringify({ pid: process.pid }));
    assert.throws(() => lockStore.api.acquireWrite(E.w, E.t, info), /locked/); assert.equal(lockStore.S.leases.length, 0);
    console.log('lease corrupt/locked persistence prevents admission: PASS');

    // A transient Windows lock-file unlink error must not fail a committed transaction;
    // the next operation reclaims only this Studio's exact token and keeps other locks safe.
    const flakyRt = tmp('lease-unlink-retry-'); let denyUnlock = true;
    const flakyFs = { ...fs, unlinkSync(file) {
      if (denyUnlock && file.endsWith('leases.json.lock')) {
        denyUnlock = false;
        throw Object.assign(new Error('simulated antivirus handle'), { code: 'EPERM' });
      }
      return fs.unlinkSync(file);
    } };
    const flakyStore = await store(flakyRt, 'unlock-retry', flakyFs), retryInfo = await E.api.workspaceOf(E.w.project);
    const flakyAdmission = flakyStore.api.acquireWrite(E.w, E.t, retryInfo);
    assert.equal(flakyAdmission.ok, true, 'transient lock-file unlink error does not overturn successful persistence');
    assert.ok(fs.existsSync(path.join(flakyRt, 'studio', 'leases.json.lock')), 'failed unlink retains a recoverable lock record');
    assert.doesNotThrow(() => flakyStore.api.saveLeases(), 'next transaction safely reclaims its own leftover lock');
    assert.equal(fs.existsSync(path.join(flakyRt, 'studio', 'leases.json.lock')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(flakyRt, 'studio', 'leases.json'), 'utf8')).length, 1);
    console.log('lease transient EPERM unlock is recovered by exact same-Studio token: PASS');


    // Atomic git-dir mirrors protect installations using different leases.json files.
    const Shared = repo(), SA = setup(Shared.d), SB = setup(Shared.d);
    SA.t.status = 'WORKING'; SA.w.run.active = true; SA.w.run.paused = false;
    assert.equal(await SA.api.takeWriteSlot(SA.w, SA.t), true);
    assert.equal(await SB.api.takeWriteSlot(SB.w, SB.t), false, 'other installation sees the active mirror');
    assert.equal(SB.env.prompts.length, 0);
    await SA.api.claimWorkspace(Shared.d, { label: 'outside' });
    assert.equal(await SB.api.takeWriteSlot(SB.w, SB.t), false, 'external mirror blocks independent runtime store too');
    await SA.api.releaseClaim(Shared.d);
    console.log('lease A/G independent runtime stores obey atomic working-tree mirror: PASS');

    // A failed lease-file rename rolls back admission and never grants an in-memory writer.
    const Failed = setup(repo().d);
    const { createWorkspaceLeaseStore } = await import(pathToFileURL(path.join(__dirname, 'workspace-lease.mjs')));
    const failedState = { leases: [] };
    const failStore = createWorkspaceLeaseStore({ fs: { ...fs, renameSync() { throw new Error('simulated disk failure'); } }, path, crypto,
      S: failedState, RT: Failed.rt, INSTANCE: 'failed-write', AGENTS: Failed.env.AGENTS,
      nowIso: () => new Date().toISOString(), pidAlive: () => true, LEASE_RESERVED_TTL_MS: 43200000 });
    const awaitInfo = await Failed.api.workspaceOf(Failed.w.project);
    assert.throws(() => failStore.acquireWrite(Failed.w, Failed.t, awaitInfo), /simulated disk failure/);
    assert.equal(failedState.leases.length, 0);
    console.log('lease failed persistence rolls back writer admission: PASS');


    // STOP of a parked writer removes the retained Git mirror and its heartbeat timer.
    const StopMirror = setup(repo().d);
    StopMirror.t.status = 'WORKING'; StopMirror.w.run.active = true; StopMirror.w.run.paused = false;
    assert.equal(await StopMirror.api.takeWriteSlot(StopMirror.w, StopMirror.t), true);
    StopMirror.api.pause(StopMirror.w);
    const mirror = path.join(StopMirror.w.project, '.git', 'studio-writer.lock');
    assert.equal(fs.existsSync(mirror), true);
    await StopMirror.api.stopAndDrain(StopMirror.w);
    assert.equal(fs.existsSync(mirror), false); assert.equal(StopMirror.w.lockTimers.size, 0);
    assert.equal(writers(StopMirror).length, 0);
    console.log('lease E parked STOP clears reservation mirror and timer: PASS');

    // Failed orphan cancellation forbids replacing its conversation with another writer.
    const orphanCode = region('async function stopTurn(convId)', '// Changes whenever');
    const send = new Function('active', 'api', 'sleep', 'stoppingTurns', 'isCodexConv', orphanCode + '\nreturn sendMessage;')(new Map(), async (method, endpoint) => {
      if (method === 'POST' && endpoint.endsWith('/messages')) throw new Error('CONFLICT already running');
      return method === 'GET' ? { runtime: { state: 'running', is_processing: true, turn_id: 'orphan' } } : {};
    }, async () => {}, new Map(), () => false);
    await assert.rejects(send('conv', 'resume'), (e) => e.stuck && e.stopUnconfirmed);
    const Unconfirmed = setup(repo().d, { turn: async () => { throw Object.assign(new Error('orphan still running'), { stopUnconfirmed: true }); } });
    Unconfirmed.w.run.active = true; Unconfirmed.w.run.paused = false; Unconfirmed.t.status = 'WAITING';
    await Unconfirmed.api.runTask(Unconfirmed.w, Unconfirmed.t);
    assert.equal(Unconfirmed.t.stopUnconfirmed, true); assert.equal(Unconfirmed.w.run.paused, true);
    assert.equal(writers(Unconfirmed)[0].status, 'RESERVED');
    assert.equal(Unconfirmed.api.acquireWrite(Unconfirmed.w, { ...Unconfirmed.t, id: 'new-agent', agent: 'claude' }, await Unconfirmed.api.workspaceOf(Unconfirmed.w.project)).ok, false);
    console.log('lease orphan cancellation failure prevents fresh-conversation writer escape: PASS');

    const raceRt = tmp('lease-race-');
    const runChild = (id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, '--acquire-child', raceRt, id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { err += b; });
      child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
    });
    const children = await Promise.allSettled([runChild('A'), runChild('B')]);
    for (const child of children) if (child.status === 'rejected') throw child.reason;
    const result = children.map((child) => child.value);
    assert.equal(result.filter((x) => x === 'acquired').length, 1, 'exactly one OS process wins');
    assert.equal(JSON.parse(fs.readFileSync(path.join(raceRt, 'studio', 'leases.json'), 'utf8')).filter((l) => l.status === 'RESERVED').length, 1);
    console.log('lease A two OS processes: exactly one writer acquired: PASS');
  } finally {
    for (const w of environments) { for (const timer of w.lockTimers?.values() || []) clearInterval(timer); clearInterval(w.lockTimer); clearTimeout(w.retryTimer); }
    for (const wt of worktrees.reverse()) { try { execFileSync('git', ['worktree', 'remove', '--force', wt.path], { cwd: wt.repo, windowsHide: true, stdio: 'ignore' }); } catch {} }
    for (const d of [...new Set(dirs)].reverse()) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
};
if (require.main === module) {
  if (process.argv[2] === '--acquire-child') {
    (async () => {
      const { api } = await store(process.argv[3], process.argv[4]);
      for (let attempt = 0; ; attempt++) {
        try {
          const got = api.acquireWrite({ project: 'repo', run: { id: process.argv[4] } }, { id: 'card', agent: 'codex', title: 'child' }, { key: 'one-tree', path: 'repo', repo: '', branch: 'main' });
          if (got.ok) { got.lease.status = 'RESERVED'; api.saveLeases(); }
          console.log(got.ok ? 'acquired' : 'blocked'); break;
        } catch (e) { if ((!/locked/.test(e.message) && !['EPERM', 'EBUSY'].includes(e.code)) || attempt > 200) throw e; await new Promise((r) => setTimeout(r, 10)); } // Windows may report a concurrently deleted lock as EPERM
      }
    })().catch((e) => { console.error(e); process.exitCode = 1; });
  } else module.exports(require('./lifecycle-harness.cjs')).catch((e) => { console.error(e); process.exitCode = 1; });
}
