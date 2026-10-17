import { execFile } from 'node:child_process';
import { listRuntimes, registerRuntime, updateRuntime } from './runtime-registry.mjs';

// Query failures must not look like an empty process tree. Never terminate by name or bare PID.
export async function processSnapshot() {
  if (process.platform !== 'win32') throw new Error('Codex process confirmation requires Windows');
  const command = 'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';
  const out = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  return [].concat(JSON.parse(out)).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId,
    executable: p.ExecutablePath || '', command: p.CommandLine || '', creationDate: p.CreationDate,
    cpu: Number(p.UserModeTime || 0) + Number(p.KernelModeTime || 0) })); // 100 ns units; only compared with itself
}

const identity = (p) => ({ pid: p.pid, executable: p.executable, creationDate: p.creationDate });
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.creationDate === b.creationDate;
const stillPresent = (rows, old) => rows.some((p) => p.pid === old.pid && (!p.creationDate || sameProcess(p, old)));
const created = (p) => Number(p.creationDate?.match(/^\/Date\((\d+)\)\/$/)?.[1]) || Date.parse(p.creationDate);
export function processTree(rows, root) {
  const current = rows.find((p) => p.pid === root.pid);
  if (current && !current.creationDate) throw new Error('Process identity is unconfirmed');
  if (!sameProcess(current, root)) return [];
  const tree = [current];
  for (let i = 0; i < tree.length; i++) for (const p of rows) {
    if (p.parent === tree[i].pid && !Number.isFinite(created(p))) throw new Error('Child process identity is unconfirmed');
    if (p.parent === tree[i].pid && created(p) >= created(tree[i]) && !tree.some((x) => x.pid === p.pid)) tree.push(p);
  }
  return tree.map(identity);
}

// AionCore v0.2.2 creates one Codex app-server per conversation, before its first message.
// Serialize initialization/restart so the new direct child can be attributed without guessing from its cwd.
export function createCodexRuntimeGuard({ rtDir, api, owner, snapshot = processSnapshot }) {
  let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const records = (cid) => listRuntimes({ rtDir }).filter((r) => r.purpose === 'codex_session' && r.conversation_id === cid && r.status !== 'cleaned');
  const save = (r, changes) => updateRuntime(r.runtime_id, changes, { rtDir });
  function roots(rows) {
    const owned = owner(), parent = rows.find((p) => p.pid === owned?.pid);
    if (!sameProcess(parent, owned) || !parent.executable || parent.executable.toLowerCase() !== owned.executable?.toLowerCase()) throw new Error('AionCore process identity is unconfirmed');
    return rows.filter((p) => p.parent === parent.pid && created(p) >= created(parent) && p.executable && /\bcodex(?:\.cmd|\.exe)?["\s].*\bapp-server\b/i.test(p.command));
  }
  function remember(cid, before, after) {
    const previous = roots(before), added = roots(after).filter((p) => !previous.some((old) => sameProcess(old, p)));
    if (added.length !== 1) throw new Error(`Cannot identify Codex conversation process (${added.length} candidates)`);
    const p = added[0];
    const r = registerRuntime({ rtDir, job_id: 'studio_core', purpose: 'codex_session', root_pid: p.pid, process_identity: p });
    save(r, { conversation_id: cid, quiescent: true, process_tree: [identity(p)] });
  }
  async function prepare(cid) {
    const rows = await snapshot();
    const ownedRoots = roots(rows);
    for (const r of records(cid)) {
      if (r.status === 'stopping') throw new Error('Codex tool processes have not stopped');
      processTree(rows, { pid: r.root_pid, ...r.process_identity });
      if (stillPresent(rows, { pid: r.root_pid, ...r.process_identity }) && !ownedRoots.some((p) => sameProcess(p, { pid: r.root_pid, ...r.process_identity }))) {
        throw new Error('Codex process is not owned by this AionCore instance');
      }
      if (r.status === 'running' && !rows.some((p) => sameProcess(p, { pid: r.root_pid, ...r.process_identity }))) {
        if (!r.quiescent) throw new Error('Codex process exited without tool stop confirmation');
        save(r, { status: 'cleaned' });
      }
    }
    if (!records(cid).some((r) => r.status === 'running')) {
      const before = rows;
      await api('POST', `/api/conversations/${cid}/runtime/ensure`, {});
      remember(cid, before, await snapshot());
    }
    for (const r of records(cid)) {
      if (r.status === 'stopping') throw new Error('Codex tool processes have not stopped');
      save(r, { quiescent: false }); // persist before admitting a message, including across a Studio restart
    }
  }
  // The live process trees of this Studio's Codex sessions (one conversation, or all), from a snapshot the caller took.
  const trees = (cid, rows) => listRuntimes({ rtDir }).filter((r) => r.purpose === 'codex_session' && r.status === 'running' && (!cid || r.conversation_id === cid))
    .flatMap((r) => { try { return processTree(rows, { pid: r.root_pid, ...r.process_identity }); } catch { return []; } });
  return {
    trees,
    create: (create) => serial(async () => {
      const before = await snapshot(), cid = await create();
      await api('POST', `/api/conversations/${cid}/runtime/ensure`, {});
      remember(cid, before, await snapshot());
      return cid;
    }),
    prepare: (cid) => serial(() => prepare(cid)),
    stop: (cid) => serial(async () => {
      let entries = records(cid);
      if (!entries.length || entries.every((r) => r.quiescent)) return true;
      const before = await snapshot();
      for (const r of entries) {
        const tree = processTree(before, { pid: r.root_pid, ...r.process_identity });
        const known = [...(r.process_tree || []), ...tree];
        save(r, { status: 'stopping', child_pids: [...new Set(known.map((p) => p.pid).filter((pid) => pid !== r.root_pid))],
          process_tree: known.filter((p, i) => known.findIndex((x) => sameProcess(p, x)) === i) });
      }
      // Native restart kills this session's Windows Job Object, including children whose parent already exited.
      await api('POST', `/api/conversations/${cid}/runtime/restart`, {});
      const after = await snapshot();
      remember(cid, before, after);
      entries = records(cid).filter((r) => r.status === 'stopping');
      let rows = after;
      for (let i = 0; ; i++) {
        if (entries.every((r) => r.process_tree.every((p) => !stillPresent(rows, p)))) {
          for (const r of entries) save(r, { status: 'cleaned' });
          return true;
        }
        if (i === 5) return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        rows = await snapshot();
      }
    })
  };
}
