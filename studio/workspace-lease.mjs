// Durable workspace ownership. Agent execution and scheduling stay in server.mjs.
export function createWorkspaceLeaseStore({ fs, path, crypto, S, RT, INSTANCE, AGENTS, nowIso, pidAlive, LEASE_RESERVED_TTL_MS }) {
  // ----- persistence -----
  const leasesFile = () => path.join(RT, 'studio', 'leases.json');
  // Another Studio sharing this folder may have added or changed leases: take its records in (ours stay the truth for our own).
  function mergeLeasesFromDisk() {
    let disk;
    try { disk = JSON.parse(fs.readFileSync(leasesFile(), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!Array.isArray(disk)) throw new Error('Invalid workspace lease store');
    for (const d of disk) {
      const m = S.leases.find((l) => l.id === d.id);
      if (!m) { S.leases.push(d); continue; }
      if (m.instance === INSTANCE && d.status !== 'RELEASED') continue;
      if (d.status === 'RELEASED' && m.status !== 'RELEASED') Object.assign(m, d);
      else if (Date.parse(d.heartbeatAt || 0) > Date.parse(m.heartbeatAt || 0)) Object.assign(m, d);
    }
  }
  // Serialize admission and persistence between processes; malformed/live locks fail closed.
  let inTransaction = false;
  let pendingUnlockToken = null;
  const pendingRecoveryUnlocks = new Map();
  const locked = () => new Error('Workspace lease store is locked');
  function readMainOwner(file) {
    let owner;
    // The main path is exclusively created before its owner is written. Both the first
    // observation and the recovery recheck can see this window (or a removed lock).
    // Unknown ownership is contention, never permission to unlink or enter a transaction.
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw locked(); }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw locked();
    return owner;
  }
  // A recovery guard is immutable while owned. Never unlink somebody else's stale guard:
  // two reclaimers could otherwise both read a dead owner, then one delete the other's new lock.
  // Instead they compete for the same successor path derived from that dead owner's token.
  // A fully written file is published with linkSync (atomic create-if-absent), so a crash cannot
  // expose an empty recovery guard. Old/unknown empty guards still fail closed.
  function takeRecoveryGate(base) {
    const seen = new Set();
    let file = base;
    for (let depth = 0; depth < 64 && !seen.has(file); depth++) {
      seen.add(file);
      const token = crypto.randomUUID(), candidate = base + '.candidate-' + token;
      const owner = { pid: process.pid, instance: INSTANCE, token };
      let published = false;
      try {
        fs.writeFileSync(candidate, JSON.stringify(owner), { flag: 'wx', flush: true });
        try { fs.linkSync(candidate, file); published = true; }
        catch (e) {
          if (e.code !== 'EEXIST') throw new Error('Workspace lease recovery requires atomic hard-link support: ' + (e.code || e.message), { cause: e });
        }
      } finally {
        // An unpublished candidate is never a lock. A transient Windows handle may leave this
        // uniquely named harmless file behind; do not overturn successful guard publication.
        try { fs.unlinkSync(candidate); } catch (e) {
          if (!['ENOENT', 'EPERM', 'EBUSY'].includes(e.code)) console.error('Workspace lease recovery candidate cleanup deferred: ' + e.message);
        }
      }
      if (published) return { file, token };
      let prior;
      try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw locked(); }
      if (!Number.isInteger(prior?.pid) || prior.pid <= 0 || typeof prior.token !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior.token)) throw locked();
      // A completed transaction may retain its own guard after transient unlink failure.
      if (prior.pid === process.pid && prior.instance === INSTANCE && pendingRecoveryUnlocks.get(file) === prior.token) {
        pendingRecoveryUnlocks.delete(file); return { file, token: prior.token };
      }
      if (pidAlive(prior.pid)) throw locked();
      file = base + '.' + prior.token;
    }
    throw locked(); // malformed cyclic or excessively deep chains are not ownership proof
  }
  function dropRecoveryGate(gate) {
    try { fs.unlinkSync(gate.file); pendingRecoveryUnlocks.delete(gate.file); }
    catch (e) {
      // This is our immutable guard; leaving it is safe and can be retried by exact token.
      // Cleanup must not throw after the main fd was acquired (or mask the original error).
      pendingRecoveryUnlocks.set(gate.file, gate.token);
      if (!['ENOENT', 'EPERM', 'EBUSY'].includes(e.code)) console.error('Workspace lease recovery guard cleanup deferred: ' + e.message);
    }
  }
  function withLeaseTransaction(fn) {
    if (inTransaction) return fn();
    const f = leasesFile() + '.lock';
    const token = crypto.randomUUID();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let fd;
    try { fd = fs.openSync(f, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readMainOwner(f);
      // A previous transaction in this same Studio may have committed but encountered a
      // transient Windows EPERM/EBUSY while deleting its lock file. Reclaim only our exact
      // random token; every other live lock continues to fail closed.
      if (owner.pid === process.pid && owner.instance === INSTANCE && owner.token && owner.token === pendingUnlockToken) {
        try { fs.unlinkSync(f); fd = fs.openSync(f, 'wx'); pendingUnlockToken = null; }
        catch { throw new Error('Workspace lease store is locked'); }
      }
      if (!fd) {
        if (!owner.pid || pidAlive(owner.pid)) throw new Error('Workspace lease store is locked');
        const recovery = takeRecoveryGate(f + '.reclaim');
        try {
          const current = readMainOwner(f);
          if (pidAlive(current.pid)) throw locked();
          fs.unlinkSync(f); fd = fs.openSync(f, 'wx');
        } finally { dropRecoveryGate(recovery); }
      }
    }
    let snapshot;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, instance: INSTANCE, token }));
      mergeLeasesFromDisk(); snapshot = structuredClone(S.leases); inTransaction = true;
      return fn();
    } catch (e) { if (snapshot) S.leases = snapshot; throw e; }
    finally {
      inTransaction = false;
      fs.closeSync(fd);
      try { fs.unlinkSync(f); if (pendingUnlockToken === token) pendingUnlockToken = null; }
      catch (e) {
        if (['EPERM', 'EBUSY'].includes(e.code)) pendingUnlockToken = token;
        else throw e;
      }
    }
  }
  function saveLeases() {
    return withLeaseTransaction(() => {
      const f = leasesFile(), tmp = f + '.' + INSTANCE + '.tmp';
      // Revocation/STOP records fence stale job snapshots even after the new owner has finished.
      S.leases = S.leases.filter((l) => l.status !== 'RELEASED' || l.revoked || l.jobStopped)
        .concat(S.leases.filter((l) => l.status === 'RELEASED' && !l.revoked && !l.jobStopped).slice(-80));
      // flush in place: this module gets its fs injected and no imports (tests load it with new Function), so it cannot use state-files' writeJson
      try { fs.writeFileSync(tmp, JSON.stringify(S.leases, null, 1), { flush: true }); fs.renameSync(tmp, f); }
      finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    });
  }
  function loadLeases() {
    withLeaseTransaction(() => {
      for (const l of S.leases) if (l.mode === 'read' && l.instance !== INSTANCE && !pidAlive(l.pid) && l.status !== 'RELEASED') retire(l, 'Studio restarted');
      saveLeases();
    });
  }

  // ----- is the holder still alive? -----
  function leaseState(l) {
    if (l.status === 'RELEASED') return 'RELEASED';
    const age = Date.now() - (Date.parse(l.heartbeatAt || l.acquiredAt) || 0);
    if (l.owner.kind === 'external') return 'EXTERNAL'; // explicit ownership survives process exits and restarts
    if (l.instance === INSTANCE) return l.status; // this Studio: its own memory is the truth
    if (!Number.isInteger(l.pid) || l.pid <= 0 || pidAlive(l.pid)) return l.status === 'RESERVED' ? 'RESERVED' : 'ACTIVE'; // silence is not proof that a writer stopped
    if (l.status === 'RESERVED') return age < LEASE_RESERVED_TTL_MS ? 'RESERVED' : 'STALE';
    return 'STALE';
  }
  const writerOf = (key) => S.leases.find((l) => l.key === key && l.mode === 'write' && ['ACTIVE', 'RESERVED', 'EXTERNAL'].includes(leaseState(l))) || null;
  const retire = (l, reason) => Object.assign(l, { status: 'RELEASED', releasedAt: nowIso(), reason });
  const ownerName = (l) => (l.owner.kind === 'external' ? '外部：' + (l.owner.label || 'external') : AGENTS[l.owner.agent]?.name || l.owner.agent);
  const sameCard = (l, w, t) => l.owner.kind === 'studio' && l.jobId === w.run?.id && l.cardId === t.id && l.owner.agent === t.agent && (l.generation || 0) === (t.leaseGeneration || 0)
    && (l.instance === INSTANCE || Number.isInteger(l.pid) && l.pid > 0 && !pidAlive(l.pid));
  const leaseView = (l) => ({ id: l.id, mode: l.mode, state: leaseState(l), kind: l.owner.kind, agent: l.owner.agent || '', owner: ownerName(l), card: l.cardTitle || '', cardId: l.cardId || '', jobId: l.jobId || '',
    branch: l.branch || '', path: l.path, repo: l.repo || '', since: l.acquiredAt, beat: l.heartbeatAt, reason: l.reason || '', flag: l.flag || '', worktree: l.worktree || l.path, provider: l.provider || l.owner.agent || 'external', session: l.session || '' });

  function newLease(w, t, info, mode) {
    const l = { id: crypto.randomUUID().slice(0, 8), key: info.key, path: info.path, repo: info.repo, branch: info.branch, mode, owner: { kind: 'studio', agent: t.agent },
      generation: t.leaseGeneration || 0, worktree: info.path, provider: t.provider || t.agent, jobId: w.run?.id, cardId: t.id, cardTitle: t.title, project: w.project, status: 'ACTIVE', acquiredAt: nowIso(), heartbeatAt: nowIso(), instance: INSTANCE, pid: process.pid };
    S.leases.push(l);
    return l;
  }

  // Write lease for a card about to modify files. { ok:false, holder } when somebody else holds the tree: nothing is taken.
  function acquireWrite(w, t, info) {
    return withLeaseTransaction(() => {
    const revoked = S.leases.find((l) => l.mode === 'write' && l.jobId === w.run?.id && (l.jobStopped || l.revoked && l.cardId === t.id && l.owner.agent === t.agent && (l.generation || 0) === (t.leaseGeneration || 0)));
    if (revoked) return { ok: false, holder: revoked };
    if (w.run?.stopped) throw new Error('Stopped job cannot acquire a write lease');
    const cur = writerOf(info.key);
    if (cur && !sameCard(cur, w, t)) return { ok: false, holder: cur };
    for (const l of S.leases) if (l.key === info.key && l.mode === 'write' && l.status !== 'RELEASED' && leaseState(l) === 'STALE') retire(l, 'stale: reclaimed by ' + ownerName({ owner: { kind: 'studio', agent: t.agent } }));
    const l = cur || newLease(w, t, info, 'write');
    Object.assign(l, { branch: info.branch, status: 'ACTIVE', heartbeatAt: nowIso(), instance: INSTANCE, pid: process.pid, reason: '', cardTitle: t.title });
    saveLeases();
    return { ok: true, lease: l, reused: !!cur };
    });
  }
  function acquireRead(w, t, info) { withLeaseTransaction(() => { newLease(w, t, info, 'read'); saveLeases(); }); }

  const cardLeases = (w, t, agent) => S.leases.filter((l) => l.status !== 'RELEASED' && l.jobId === w.run?.id && l.cardId === t.id && (!agent || l.owner.agent === agent));
  function releaseCardLeases(w, t, reason, agent) { return withLeaseTransaction(() => { for (const l of cardLeases(w, t, agent)) retire(l, reason); saveLeases(); }); }
  function reserveCardLeases(w, t, reason, agent) { return withLeaseTransaction(() => { for (const l of cardLeases(w, t, agent)) if (l.mode === 'write' && l.status === 'ACTIVE') Object.assign(l, { status: 'RESERVED', reason, heartbeatAt: nowIso() }); saveLeases(); }); }
  // A card whose agent is still winding down (status WORKING) keeps its lease: endWriteStep gives it back once the agent really stopped.
  function releaseJobLeases(w, reason) {
    return withLeaseTransaction(() => {
    for (const l of S.leases) {
      if (l.jobId !== w.run?.id || l.owner.kind !== 'studio') continue;
      if (w.run?.stopped) l.jobStopped = true;
      if (l.status === 'RELEASED') continue;
      if (l.mode === 'write' && (w.executingSteps?.has(l.cardId) || w.tasks.some((t) => t.id === l.cardId && (t.status === 'WORKING' || t.stopUnconfirmed || t.runtimeStopPending)))) continue;
      retire(l, reason);
    }
    saveLeases();
    });
  }
  function reserveJobLeases(w, reason) { return withLeaseTransaction(() => { for (const l of S.leases) if (l.status === 'ACTIVE' && l.mode === 'write' && l.jobId === w.run?.id && l.instance === INSTANCE) Object.assign(l, { status: 'RESERVED', reason, heartbeatAt: nowIso() }); saveLeases(); }); }
  function beatLeases() { let n = 0; for (const l of S.leases) if (l.status !== 'RELEASED' && l.instance === INSTANCE && l.owner.kind === 'studio') { l.heartbeatAt = nowIso(); n++; } if (n) saveLeases(); }


  return { mergeLeasesFromDisk, saveLeases, loadLeases, withLeaseTransaction, leaseState, writerOf, retire, ownerName, sameCard, leaseView, newLease, acquireWrite, acquireRead, cardLeases, releaseCardLeases, reserveCardLeases, releaseJobLeases, reserveJobLeases, beatLeases };
}
