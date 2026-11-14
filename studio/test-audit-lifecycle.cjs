// Ownership transition regressions. Real lifecycle functions, scripted providers; no agents/network.
const { assert, makeEnv, newW, mkTmp, TMP_DIRS, region } = require('./lifecycle-harness.cjs');
const fs = require('node:fs');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const environments = [];
function setup(overrides = {}) {
  const E = makeEnv(() => 'STATUS: DONE', overrides), w = newW();
  w.project = mkTmp('ownership-project-');
  Object.assign(w.run, { project: w.project, active: false, paused: true, phase: 'working' });
  const t = { id: 'card', title: 'ownership', agent: 'codex', writes: true, status: 'PAUSED', after: [], instructions: 'work' };
  w.tasks.push(t); w.run.convs['codex:work'] = 'old-conversation'; E.env.S.workspaces.push(w);
  environments.push(w); return { ...E, w, t };
}
(async () => {
  try {
    // A second ownership operation cannot drain the old owner and later revoke the replacement's live lease.
    const gate = deferred(); let stops = 0;
    const E = setup({ stopTurn: async () => { stops++; await gate.promise; return true; } });
    const first = E.api.handoffWriter(E.w, 'claude', E.t.id);
    assert.equal(stops, 1);
    await assert.rejects(E.api.handoffWriter(E.w, 'antigravity', E.t.id), /正在交接/);
    await assert.rejects(E.api.useWorktree(E.w, E.t.id), /正在交接/);
    await assert.rejects(E.api.useReadOnly(E.w, E.t.id), /正在交接/);
    assert.equal(stops, 1, 'rejected operations never drain the old conversation again');
    gate.resolve(); await first;
    assert.equal(E.t.agent, 'claude'); assert.equal(E.t.hold, false);
    assert.equal(E.env.S.leases.filter((l) => l.status !== 'RELEASED' && l.mode === 'write').length, 1);
    await E.api.handoffWriter(E.w, 'antigravity', E.t.id);
    assert.equal(E.t.agent, 'antigravity', 'guard released after success');

    // t.hold is also used by automatic quota fallback, not just an in-progress ownership operation.
    const fallback = setup(); fallback.t.hold = true;
    await fallback.api.handoffWriter(fallback.w, 'claude', fallback.t.id);
    assert.equal(fallback.t.agent, 'claude'); assert.equal(fallback.t.hold, false);

    // Switching read-only owns the same transition guard; handoff cannot run through its drain.
    const readGate = deferred();
    const reader = setup({ stopTurn: async () => { await readGate.promise; return true; } });
    const reading = reader.api.useReadOnly(reader.w, reader.t.id);
    await assert.rejects(reader.api.handoffWriter(reader.w, 'claude', reader.t.id), /正在交接/);
    readGate.resolve(); await reading; assert.equal(reader.t.writes, false);

    // Stop / job replacement during either drain or the later transcript read invalidates the handoff.
    for (const when of ['drain', 'transcript']) for (const change of ['stop', 'replace']) {
      const entered = deferred(), release = deferred();
      const wait = async () => { entered.resolve(); await release.promise; };
      const X = setup({ stopTurn: async () => { if (when === 'drain') await wait(); return true; },
        api: async () => { if (when === 'transcript') await wait(); return { items: [] }; } });
      const pending = X.api.handoffWriter(X.w, 'claude', X.t.id);
      await entered.promise;
      if (change === 'stop') X.w.run.stopped = true;
      else X.w.run = { ...X.w.run, id: 'new-job' };
      release.resolve(); await assert.rejects(pending, /工作或卡片已變更/);
      assert.equal(X.t.agent, 'codex'); assert.equal(X.t.leaseGeneration, undefined); assert.equal(X.t.hold, false);
      assert.equal(X.env.S.leases.length, 0, 'no replacement lease published');
    }

    // A failed drain also releases the transition guard so the user can retry.
    let canStop = false; const failure = setup({ stopTurn: async () => canStop });
    Object.assign(failure.w.run, { active: true, paused: false });
    await assert.rejects(failure.api.handoffWriter(failure.w, 'claude', failure.t.id), /沒有真的停/);
    assert.equal(failure.w.run.paused, true); assert.equal(failure.t.stopUnconfirmed, true);
    failure.api.pump(failure.w); assert.equal(failure.env.prompts.length, 0, 'failed drain cannot restart work');
    canStop = true; await failure.api.handoffWriter(failure.w, 'claude', failure.t.id);
    assert.equal(failure.t.agent, 'claude');

    // Setup termination forwards the previously recorded identity, including an unknown identity (PID only).
    const setupKill = new Function('killProcessTree', 'processSnapshot', 'setupStuck',
      region('async function killSetup(e)', '// A kill that did not end') + '\nreturn killSetup;');
    for (const identity of [{ pid: 123 }, { pid: 123, creationDate: 'original', executable: 'cmd.exe' }]) {
      let got; const snapshot = async () => [];
      const kill = setupKill(async (pid, read, expected) => { got = { pid, read, expected }; return { ok: true }; }, snapshot, () => {});
      await kill({ child: { pid: 123 }, t: { worktree: { setupProc: identity } } });
      assert.equal(got.pid, 123); assert.equal(got.read, snapshot); assert.equal(got.expected, identity);
    }
    // Stop can arrive as soon as setupProc.pid is saved, before the spawn-time query returns.
    const setupLifecycle = new Function('processSnapshot', 'saveRun', 'killProcessTree', 'setupStuck',
      region('function rememberSetupProcess(e, child)', '// A kill that did not end') + '\nreturn { rememberSetupProcess, killSetup };');
    const original = { pid: 123, creationDate: 'original', executable: 'cmd.exe' };
    for (const mode of ['known', 'query-failed', 'missing', 'unknown', 'exited']) {
      const capture = deferred(); let snapshots = 0, kills = 0, stuck = 0, received;
      const api = setupLifecycle(() => { snapshots++; return capture.promise; }, () => {}, async (pid, snapshot, expected) => {
        kills++; received = expected;
        return expected.creationDate ? { ok: true } : { ok: false, remaining: [pid] };
      }, async () => { stuck++; });
      const e = { w: { run: { paused: true }, worktreeSetup: 'fixture' }, t: { preparing: true, worktree: {} } };
      const child = { pid: original.pid, exitCode: null, signalCode: null };
      api.rememberSetupProcess(e, child);
      assert.equal(snapshots, 1, 'the only identity capture starts synchronously with spawn');
      assert.equal(e.t.worktree.setupProc.creationDate, undefined, 'the immediate durable record is PID-only');
      const stopping = api.killSetup(e); await api.killSetup(e);
      await Promise.resolve(); assert.equal(kills, 0, 'concurrent early Stop waits for the existing capture');
      if (mode === 'query-failed') capture.resolve(Promise.reject(new Error('CIM unavailable')));
      else {
        if (mode === 'exited') child.exitCode = 0; // even a row for the same recycled PID must not be adopted
        capture.resolve(mode === 'missing' ? [] : mode === 'unknown' ? [{ pid: original.pid }] : [original]);
      }
      await stopping;
      assert.equal(snapshots, 1, 'Stop never starts a fresh identity query'); assert.equal(kills, 1);
      assert.deepEqual(received, mode === 'known' ? original : { pid: original.pid });
      assert.equal(stuck, mode === 'known' ? 0 : 1, 'unknown/failed/exited captures remain conservatively blocked');
      assert.equal(e.t.preparing, true);
    }
    // Once captured, a later card-field change is not authority to adopt another process with the same PID.
    let savedIdentity;
    const saved = setupLifecycle(async () => [original], () => {}, async (pid, snapshot, expected) => {
      savedIdentity = expected; return { ok: true };
    }, () => {});
    const savedEntry = { w: { run: { paused: true } }, t: { preparing: true, worktree: {} } };
    saved.rememberSetupProcess(savedEntry, { pid: original.pid, exitCode: null, signalCode: null });
    await savedEntry.identity;
    savedEntry.t.worktree.setupProc = { ...original, creationDate: 'reused' };
    await saved.killSetup(savedEntry); assert.deepEqual(savedIdentity, original);

    let alive = true, expectedProc;
    const leftover = setup({ processSnapshot: async () => alive ? [original] : [],
      killProcessTree: async (pid, snapshot, expected) => { expectedProc = expected; alive = false; return { ok: true }; } });
    Object.assign(leftover.t, { preparing: true, worktree: { setupProc: original } });
    await leftover.api.endLeftSetups(leftover.w, [leftover.t]);
    assert.equal(expectedProc, original); assert.equal(leftover.t.preparing, false);

    // History replacement must inspect the OLD job before loadRun loses its pending-stop flags.
    for (const flag of ['stopUnconfirmed', 'runtimeStopPending', 'executingSteps', 'recoverySteps', 'runtimeStarts']) {
      let target;
      const H = setup({ readHistory: () => ({ id: 'other-job', status: 'paused', project: target.project, tasks: [], activity: [], convs: {} }),
        openWorkspace: (project) => ({ project }), wsOf: () => target });
      target = H.w;
      if (flag.endsWith('Steps') || flag === 'runtimeStarts') H.w[flag] = new Map([[H.t.id, {}]]);
      else H.t[flag] = true;
      const oldRun = H.w.run, oldTasks = H.w.tasks;
      await assert.rejects(H.api.resume(H.w, 'other-job'), /不能切換歷史工作/);
      assert.equal(H.w.run, oldRun); assert.equal(H.w.tasks, oldTasks);
      if (H.w[flag] instanceof Map) H.w[flag].clear(); else delete H.t[flag];
      await H.api.resume(H.w, 'other-job'); assert.equal(H.w.run.id, 'other-job');
    }

    // Moving a stopped-but-unconfirmed card would hide its old workKey/conversation from the next drain.
    for (const flag of ['stopUnconfirmed', 'runtimeStopPending']) {
      const X = setup(); X.t[flag] = true;
      await assert.rejects(X.api.useWorktree(X.w, X.t.id), /停下中/);
      assert.equal(X.t.workdir, undefined);
    }

    for (const writes of [true, false]) {
      const done = setup(); Object.assign(done.t, { status: 'DONE', writes });
      await assert.rejects(done.api.reassign(done.w, done.t.id, 'claude'), /已完成/);
      await assert.rejects(done.api.handoffWriter(done.w, 'claude', done.t.id), /已完成/);
      assert.equal(done.t.status, 'DONE'); assert.equal(done.t.agent, 'codex'); assert.equal(done.env.prompts.length, 0);
    }
    console.log('Ownership transitions: serialized handoff/read-only/worktree, stale run rejection, history drain guard, completed-card protection: PASS');
  } finally {
    for (const w of environments) { for (const timer of w.lockTimers?.values() || []) clearInterval(timer); clearTimeout(w.retryTimer); }
    for (const dir of [...new Set(TMP_DIRS)].reverse()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
