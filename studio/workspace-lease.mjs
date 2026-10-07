// Durable workspace ownership. Agent execution and scheduling stay in server.mjs.
export function createWorkspaceLeaseStore({ fs, path, crypto, S, RT, INSTANCE, AGENTS, nowIso, pidAlive, LEASE_HUNG_MS, LEASE_RESERVED_TTL_MS }) {
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
  function withLeaseTransaction(fn) {
    if (inTransaction) return fn();
    const f = leasesFile() + '.lock';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let fd;
    try { fd = fs.openSync(f, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error('Workspace lease store is locked'); }
      if (!owner.pid || pidAlive(owner.pid)) throw new Error('Workspace lease store is locked');
      let recovery;
      try { recovery = fs.openSync(f + '.reclaim', 'wx'); } catch { throw new Error('Workspace lease store is locked'); }
      try {
        const current = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!current.pid || pidAlive(current.pid)) throw new Error('Workspace lease store is locked');
        fs.unlinkSync(f); fd = fs.openSync(f, 'wx');
      } finally { fs.closeSync(recovery); fs.unlinkSync(f + '.reclaim'); }
    }
    let snapshot;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, instance: INSTANCE }));
      mergeLeasesFromDisk(); snapshot = structuredClone(S.leases); inTransaction = true;
      return fn();
    } catch (e) { if (snapshot) S.leases = snapshot; throw e; }
    finally { inTransaction = false; fs.closeSync(fd); fs.unlinkSync(f); }
  }
  function saveLeases() {
    return withLeaseTransaction(() => {
      const f = leasesFile(), tmp = f + '.' + INSTANCE + '.tmp';
      // Revocation/STOP records fence stale job snapshots even after the new owner has finished.
      S.leases = S.leases.filter((l) => l.status !== 'RELEASED' || l.revoked || l.jobStopped)
        .concat(S.leases.filter((l) => l.status === 'RELEASED' && !l.revoked && !l.jobStopped).slice(-80));
      try { fs.writeFileSync(tmp, JSON.stringify(S.leases, null, 1)); fs.renameSync(tmp, f); }
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
    if (l.status === 'RESERVED') return pidAlive(l.pid) || age < LEASE_RESERVED_TTL_MS ? 'RESERVED' : 'STALE';
    return pidAlive(l.pid) && age < LEASE_HUNG_MS ? 'ACTIVE' : 'STALE'; // another Studio: alive and beating, or it is not
  }
  const writerOf = (key) => S.leases.find((l) => l.key === key && l.mode === 'write' && ['ACTIVE', 'RESERVED', 'EXTERNAL'].includes(leaseState(l))) || null;
  const retire = (l, reason) => Object.assign(l, { status: 'RELEASED', releasedAt: nowIso(), reason });
  const ownerName = (l) => (l.owner.kind === 'external' ? '外部：' + (l.owner.label || 'external') : AGENTS[l.owner.agent]?.name || l.owner.agent);
  const sameCard = (l, w, t) => l.owner.kind === 'studio' && l.jobId === w.run?.id && l.cardId === t.id && l.owner.agent === t.agent && (l.generation || 0) === (t.leaseGeneration || 0);
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
