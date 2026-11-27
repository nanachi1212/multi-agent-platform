import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { processSnapshot, processTree } from './codex-runtime.mjs';
import { stopShellJob } from './managed-shell.mjs';
import { writeJson } from './state-files.mjs'; // circular with state-files.mjs: only functions cross, none run at load

// ---------- System Process & Port Helpers (Windows-first) ----------

function execPowerShell(cmd) {
  return new Promise((resolve, reject) => {
    const command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + cmd;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(String(stdout || ''));
    });
  });
}

function execCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(String(stdout || ''));
    });
  });
}

// The one "is this process alive" check (server.mjs uses it too). Unsure counts as alive: only ESRCH means gone,
// and a PID that is not a number (a bad record) counts as alive. No PID, or a number <= 0, is not a process.
export function isPidAlive(pid) {
  if (!pid || (typeof pid === 'number' && pid <= 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

export async function getProcessInfo(pid) {
  if (!isPidAlive(pid)) return { pid, exists: false, command: '', executable: '' };
  if (process.platform === 'win32' && Number.isInteger(pid)) { // only a real number goes into the PowerShell filter
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue | Select-Object -Property ProcessId, Name, ExecutablePath, CommandLine, CreationDate | ConvertTo-Json -Compress`;
      const out = await execPowerShell(psCmd);
      if (out && out.trim()) {
        const data = JSON.parse(out.trim());
        return {
          pid,
          exists: true,
          name: data.Name || '',
          executable: data.ExecutablePath || '',
          command: data.CommandLine || data.Name || '',
          creationDate: data.CreationDate || ''
        };
      }
    } catch (e) {}
  }
  return { pid, exists: isPidAlive(pid), command: '', executable: '' };
}

// Windows reuses PIDs, so ParentProcessId alone can adopt an unrelated process (reports/evidence/INCIDENT-w1-pid-reuse.md).
// processTree follows only children created at or after their parent. A failed snapshot throws: it is not an empty tree.
export async function getChildPids(parentPid, snapshot = processSnapshot, expectedIdentity = null) {
  if (!parentPid || !isPidAlive(parentPid)) return [];
  const rows = await snapshot();
  const root = rows.find((p) => p.pid === parentPid);
  if (root && expectedIdentity && !sameIdentity(root, { ...expectedIdentity, pid: parentPid })) throw new Error('Root process identity changed');
  return root ? processTree(rows, root).slice(1).map((p) => p.pid) : [];
}

// A saved identity is the same process only while PID, creation time and executable all still match.
const sameIdentity = (a, b) => a.pid === b.pid && String(a.creationDate) === String(b.creationDate)
  && String(a.executable || '').toLowerCase() === String(b.executable || '').toLowerCase();

/**
 * Kill each saved identity that a fresh snapshot still shows unchanged; a reused PID is never touched.
 * Returns every verified PID, including ones whose kill failed, so callers keep waiting on (and reporting) them.
 */
export async function killIdentities(list, snapshot = processSnapshot) {
  const verified = [];
  for (const old of list) {
    if (!old?.creationDate || !old?.executable) throw new Error('Process identity is unconfirmed');
    // ponytail: one snapshot per kill (~1 s each) so an earlier kill cannot free a PID this loop then reuses; batch if trees get large
    if (!(await snapshot()).some((p) => sameIdentity(p, old))) continue;
    verified.push(old.pid);
    try { process.kill(old.pid, 'SIGKILL'); } catch (e) {} // already exited, or still alive and reported by the caller
  }
  return verified;
}

/**
 * Terminate a process tree.
 * CRITICAL RULE: Kills only the root and its verified descendants, one PID at a time (no taskkill /T: it walks ParentProcessId again).
 * Children are killed only if a fresh snapshot, taken after the root died, still shows the same creation time and executable.
 * NEVER kills by process name (no Stop-Process -Name python).
 */
export async function killProcessTree(rootPid, snapshot = processSnapshot, expectedIdentity = null) {
  if (!rootPid || !isPidAlive(rootPid)) return { ok: true, killed: false };
  let children, root;
  const expected = expectedIdentity ? { ...expectedIdentity, pid: rootPid } : null;
  const unconfirmed = () => ({ ok: false, killed: false, rootPid, children: [], remaining: [rootPid],
    left: [expected?.creationDate && expected?.executable ? expected : { pid: rootPid }] });
  try {
    const rows = await snapshot(); root = rows.find((p) => p.pid === rootPid);
    // A successful query without the root is not permission to kill its bare PID. In particular,
    // keep a caller's saved identity: a later snapshot must never adopt a recycled root.
    if (!root?.creationDate || !root.executable || expected && !sameIdentity(root, expected)) return unconfirmed();
    children = processTree(rows, root).slice(1);
  } catch (e) { return unconfirmed(); } // unknown tree: kill nothing, retain the caller's identity
  // `left`: what is still there, with the identity from this snapshot, taken before anything was killed (a later snapshot
  // could show a reused PID); a PID it did not show has no identity.
  const known = [root, ...children].filter(Boolean);
  const idOf = (pid) => { const p = known.find((x) => x.pid === pid); return p?.creationDate ? { pid, creationDate: p.creationDate, executable: p.executable } : { pid }; };

  // Revalidate the root immediately before killing it, just as killIdentities does for children.
  // Use this same snapshot to retain newly born descendants that still connect to the verified root.
  // Never replace an earlier identity for a PID: an ambiguous/reused member keeps the whole stop blocked.
  try {
    const rows = await snapshot();
    if (!rows.some((p) => sameIdentity(p, root))) throw new Error('Root process identity changed');
    const fresh = processTree(rows, root).slice(1);
    for (const p of fresh) {
      const old = known.find((x) => x.pid === p.pid);
      if (!p.creationDate || !p.executable || old && !sameIdentity(old, p)) throw new Error('Child process identity is unconfirmed');
    }
    for (const p of fresh) if (!known.some((old) => old.pid === p.pid)) known.push(p);
    children = known.slice(1); // retain earlier descendants too, even if their parent has already exited
  } catch (e) { return { ok: false, killed: false, rootPid, children: [], remaining: known.map((p) => p.pid), left: known.map((p) => idOf(p.pid)) }; }
  try { process.kill(rootPid, 'SIGKILL'); } catch (e) {} // already exited, or still alive and reported below
  let victims = [];
  try { victims = await killIdentities(children, snapshot); }
  catch (e) { const remaining = [rootPid, ...children.map((p) => p.pid)].filter(isPidAlive); return { ok: false, killed: true, rootPid, children: [], remaining, left: remaining.map(idOf) }; }

  const pids = [rootPid, ...victims];
  for (let i = 0; i < 20 && pids.some(isPidAlive); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = pids.filter(isPidAlive);
  return { ok: remaining.length === 0, killed: true, rootPid, children: victims, remaining, left: remaining.map(idOf) };
}

// Runtime readiness and smoke requests always connect to IPv4 loopback. A listener
// on another local address is not evidence of ownership of that endpoint.
export async function getPortOccupant(port) {
  if (!port || typeof port !== 'number') return null;
  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Property LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress`;
      const out = await execPowerShell(psCmd);
      if (out && out.trim()) {
        const data = JSON.parse(out.trim());
        if ([].concat(data).some((row) => typeof row?.LocalAddress !== 'string' || !Number.isInteger(row.OwningProcess) || row.OwningProcess <= 0)) throw new Error('Unconfirmed listener metadata');
        const listeners = [].concat(data).filter((row) => ['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1'].includes(row.LocalAddress));
        const pids = [...new Set(listeners.map((row) => row.OwningProcess))];
        // An IPv6 wildcard can be dual-stack. Do not guess which listener serves IPv4.
        if (pids.length > 1) throw new Error('Ambiguous loopback listeners');
        if (pids.length === 1 && Number.isInteger(pids[0]) && pids[0] > 0) return pids[0];
        if (!listeners.length) return null;
      }
    } catch (e) {
      // A confirmed ambiguity is an answer, not a query failure: do not let the fallback pick one.
      if (e.message === 'Ambiguous loopback listeners') throw new Error('Cannot confirm loopback port ownership: ' + e.message, { cause: e });
    }

    try {
      // No `-p tcp`: that lists IPv4 only and would hide a dual-stack `[::]` listener.
      const stdout = await execCmd('netstat', ['-ano']);
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'TCP' && parts[3] === 'LISTENING') {
          const addr = parts[1];
          const p = parseInt(addr.split(':').pop(), 10);
          const host = addr.slice(0, addr.lastIndexOf(':')).replace(/^\[|\]$/g, '');
          if (p === port && ['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1'].includes(host)) {
            const pid = parseInt(parts[4], 10);
            if (pid) pids.add(pid);
          }
        }
      }
      if (pids.size > 1) throw new Error('Ambiguous loopback listeners');
      return pids.size === 1 ? [...pids][0] : null;
    } catch (e) { throw new Error('Cannot confirm loopback port ownership: ' + e.message, { cause: e }); }
  }
  return null;
}

// ---------- Safety checks ----------

export function isSafeTempDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const base = path.resolve(os.tmpdir(), 'MultiAgentStudio');
  const target = path.resolve(dirPath);
  const relative = path.relative(base, target);
  // Only individual run directories; never the temp root or a project directory.
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
      || relative.split(path.sep).length < 2) return false;
  let current = target;
  while (current !== path.dirname(base)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return false;
    if (current === base) break;
    current = path.dirname(current);
  }
  return true;
}

/** A PID is owned only when its OS creation time and executable still match. */
export async function verifyRuntimeProcess(runtime) {
  const info = await getProcessInfo(runtime.root_pid);
  if (!info.exists) {
    const descendants = (runtime.child_pids || []).filter(isPidAlive);
    return { ok: runtime.created_by === 'studio' && descendants.length === 0, alive: false,
      reason: descendants.length ? `Unverified orphan PIDs: ${descendants.join(', ')}` : '', info };
  }
  const identity = runtime.process_identity;
  const ok = runtime.created_by === 'studio' && identity?.creationDate && identity?.executable
    && String(identity.creationDate) === String(info.creationDate)
    && identity.executable.toLowerCase() === info.executable.toLowerCase();
  return { ok: !!ok, alive: true, info,
    reason: ok ? '' : `Unknown/reused PID ${runtime.root_pid} (${info.command || info.executable || 'command unavailable'}); process ownership is unverified` };
}

export async function cleanupRuntime(runtime, { rtDir = null, customRuntimes = null } = {}) {
  let receipt = {};
  if (runtime.shell_job != null) {
    if (runtime.created_by !== 'studio') return { ok: false, reason: 'Runtime owner is unknown' };
    try { receipt = await stopShellJob(runtimeRoot(rtDir), runtime); }
    catch (e) { return { ok: false, reason: e.message }; }
  } else {
    const verified = await verifyRuntimeProcess(runtime);
    if (!verified.ok) return { ok: false, reason: verified.reason || 'Runtime owner is unknown' };
    if (verified.alive) {
      const killed = await killProcessTree(runtime.root_pid, processSnapshot, runtime.process_identity);
      if (!killed.ok) return { ok: false, reason: `Runtime processes have not stopped: ${killed.remaining.join(', ')}` };
    }
  }
  if (runtime.temp_dir && isSafeTempDir(runtime.temp_dir)) {
    fs.rmSync(runtime.temp_dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  updateRuntime(runtime.runtime_id, { ...receipt, status: 'cleaned' }, { rtDir, customRuntimes });
  return { ok: true };
}

// Unique per Studio start: a PID or timestamp can repeat after a quick restart, this cannot.
const STUDIO_INSTANCE = crypto.randomUUID();

// ---------- Runtime Registry Persistence & Operations ----------

export function runtimesFile(rtDir) {
  return path.join(runtimeRoot(rtDir), 'studio', 'runtimes.json');
}

function runtimeRoot(rtDir) { return rtDir || process.env.STUDIO_RUNTIME_DIR || path.join(process.cwd(), 'runtime'); }

export function loadRuntimes(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Invalid runtime registry; preserve it for recovery');
  return data;
}

// Every Codex turn adds a codex_session record, so cleaned ones are trimmed to the newest few on each write.
// Only cleaned codex_session records: a cleaned backend record is the "latest replacement" fence (recoverBackendWaitStep).
// ponytail: fixed cap of 50 cleaned Codex records, oldest dropped first.
const CLEANED_CODEX_KEEP = 50;
const cleanedCodex = (r) => r.purpose === 'codex_session' && r.status === 'cleaned';
export function saveRuntimes(filePath, runtimes) {
  let extra = runtimes.filter(cleanedCodex).length - CLEANED_CODEX_KEEP;
  if (extra > 0) runtimes = runtimes.filter((r) => !(cleanedCodex(r) && extra-- > 0));
  writeJson(filePath, runtimes); // the same flushed atomic write as settings and history
}

export function registerRuntime({
  job_id,
  card_id = null,
  workspace = '',
  purpose = 'dev_backend',
  root_pid,
  child_pids = [],
  executable = '',
  command = '',
  args = [],
  cwd = '',
  env = {},
  smoke_path = '',
  port = null,
  data_dir = null,
  temp_dir = null,
  status = 'running',
  created_by = 'studio',
  restart_safe = false,
  shell_job = null,
  process_identity = null,
  studio_pid = process.pid,
  rtDir = null,
  customRuntimes = null
}) {
  const file = runtimesFile(rtDir);
  const runtimes = customRuntimes || loadRuntimes(file);
  const runtime_id = `rt_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();

  const entry = {
    runtime_id,
    job_id: String(job_id || ''),
    card_id: card_id ? String(card_id) : null,
    workspace: workspace ? path.resolve(workspace) : '',
    purpose: String(purpose || 'dev_backend'),
    root_pid: root_pid || 0,
    child_pids: Array.isArray(child_pids) ? [...child_pids] : [],
    executable: executable || '',
    command: command || '',
    args: Array.isArray(args) ? args.map(String) : [],
    cwd: cwd ? path.resolve(cwd) : '',
    // Never persist credentials or arbitrary process environment values.
    env: Object.fromEntries(Object.entries(env || {}).filter(([key]) => ['DATA_DIR', 'PORT', 'STUDIO_ISOLATED', 'STUDIO_RUN_ID'].includes(key))),
    smoke_path: typeof smoke_path === 'string' && smoke_path.startsWith('/') ? smoke_path : '',
    port: port || null,
    data_dir: data_dir ? path.resolve(data_dir) : null,
    temp_dir: temp_dir ? path.resolve(temp_dir) : null,
    started_at: now,
    heartbeat_at: now,
    status,
    created_by: String(created_by || 'unknown'),
    restart_safe: restart_safe === true,
    ...(shell_job != null ? { shell_job } : {}),
    studio_pid,
    studio_instance: STUDIO_INSTANCE,
    process_identity: process_identity?.creationDate && process_identity?.executable
      ? { creationDate: process_identity.creationDate, executable: process_identity.executable } : null
  };

  runtimes.push(entry);
  if (!customRuntimes) {
    saveRuntimes(file, runtimes);
  }
  return entry;
}

export function updateRuntime(runtimeId, updates, { rtDir = null, customRuntimes = null } = {}) {
  const file = runtimesFile(rtDir);
  const runtimes = customRuntimes || loadRuntimes(file);
  const entry = runtimes.find((r) => r.runtime_id === runtimeId);
  if (!entry) return null;
  Object.assign(entry, updates, { heartbeat_at: new Date().toISOString() });
  if (!customRuntimes) {
    saveRuntimes(file, runtimes);
  }
  return entry;
}

export function listRuntimes({ rtDir = null, customRuntimes = null, filter = null } = {}) {
  const file = runtimesFile(rtDir);
  const runtimes = customRuntimes || loadRuntimes(file);
  if (!filter) return runtimes;
  return runtimes.filter(filter);
}

export async function cleanupJobRuntimes(jobId, { rtDir = null, customRuntimes = null, cardIds = null } = {}) {
  const runtimes = listRuntimes({ rtDir, customRuntimes });
  let cleaned = 0;
  const blocked = [];
  for (const runtime of runtimes) {
    if (runtime.job_id !== jobId || !['running', 'exited', 'stale'].includes(runtime.status)
        || cardIds && !cardIds.includes(runtime.card_id)) continue;
    const result = await cleanupRuntime(runtime, { rtDir, customRuntimes });
    if (result.ok) cleaned++;
    else blocked.push({ runtime_id: runtime.runtime_id, pid: runtime.root_pid, reason: result.reason });
  }
  return { cleaned, blocked };
}

export async function cleanupStaleRuntimes({ rtDir = null, customRuntimes = null, snapshot = processSnapshot } = {}) {
  const runtimes = listRuntimes({ rtDir, customRuntimes });
  let cleanedCount = 0, staleCount = 0;
  for (const runtime of runtimes) {
    // A Codex record left 'stopping' by an earlier Studio: its saved process identities are the only proof of what to stop.
    // Only this Studio start's own in-flight stop is skipped; a record without this start's instance id is an earlier Studio's. It stays 'stopping' (retryable) until clean.
    if (runtime.status === 'stopping' && Array.isArray(runtime.process_tree) && runtime.studio_instance !== STUDIO_INSTANCE) {
      try {
        await killIdentities(runtime.process_tree, snapshot);
        const rows = await snapshot();
        if (runtime.process_tree.some((old) => rows.some((p) => sameIdentity(p, old)))) throw new Error('Codex tool processes have not stopped');
        updateRuntime(runtime.runtime_id, { status: 'cleaned' }, { rtDir, customRuntimes }); cleanedCount++;
      } catch (e) {
        updateRuntime(runtime.runtime_id, { blocked_reason: e.message }, { rtDir, customRuntimes }); staleCount++;
      }
      continue;
    }
    if (!['running', 'exited', 'stale'].includes(runtime.status)) continue;
    // Another live Studio owns its running processes. Never steal its runtime.
    if (isPidAlive(runtime.root_pid) && runtime.studio_pid && isPidAlive(runtime.studio_pid)) continue;
    const result = await cleanupRuntime(runtime, { rtDir, customRuntimes });
    if (result.ok) cleanedCount++;
    else {
      updateRuntime(runtime.runtime_id, { status: 'stale', blocked_reason: result.reason }, { rtDir, customRuntimes });
      staleCount++;
    }
  }
  return { cleanedCount, staleCount, total: runtimes.length };
}

export async function checkPortOwnership(port, { desiredJobId, desiredDataDir, rtDir = null, customRuntimes = null } = {}) {
  let occupantPid;
  try { occupantPid = await getPortOccupant(port); }
  catch (error) { return { status: 'blocked', available: false, owner: 'unknown', port, reason: `Blocked: ${error.message}` }; }
  if (!occupantPid) {
    return { status: 'free', available: true, port };
  }

  const runtimes = customRuntimes || loadRuntimes(runtimesFile(rtDir));
  // Managed runtimes are registered before their listener children exist. The saved child list
  // is only a hint, not the admission gate: check the current tree for a runtime assigned this port.
  const candidates = runtimes.filter((r) => r.status === 'running' && r.created_by === 'studio'
    && (r.port === port || r.root_pid === occupantPid || r.child_pids?.includes(occupantPid)));
  let matched = null;
  for (const candidate of candidates) {
    const verified = await verifyRuntimeProcess(candidate);
    if (!verified.ok || !verified.alive) continue;
    const descendants = candidate.root_pid === occupantPid ? []
      : await getChildPids(candidate.root_pid, processSnapshot, candidate.process_identity).catch(() => []);
    if (candidate.root_pid === occupantPid || descendants.includes(occupantPid)) { matched = candidate; break; }
  }

  if (matched) {
    const alive = isPidAlive(occupantPid);
    if (!alive) {
      return {
        status: 'stale',
        available: false,
        owner: 'studio',
        runtime: matched,
        pid: occupantPid,
        port,
        reason: `Port ${port} is occupied by dead/stale Studio process (PID ${occupantPid})`
      };
    }

    if (desiredJobId && matched.job_id === desiredJobId
        && (!desiredDataDir || path.resolve(desiredDataDir) === matched.data_dir)) {
      return {
        status: 'owned_by_current_job',
        available: true,
        owner: 'studio',
        runtime: matched,
        pid: occupantPid,
        port
      };
    }

    const dataDirConflict = desiredDataDir && matched.data_dir && path.resolve(desiredDataDir) === path.resolve(matched.data_dir);
    return {
      status: 'blocked',
      available: false,
      owner: 'studio',
      runtime: matched,
      pid: occupantPid,
      port,
      data_dir: matched.data_dir,
      reason: `Blocked: port ${port} is already owned by Studio runtime ${matched.runtime_id} (job ${matched.job_id}, PID ${occupantPid}${dataDirConflict ? ', data_dir conflict' : ''})`
    };
  }

  // OWNER UNKNOWN: NEVER KILL!
  const procInfo = await getProcessInfo(occupantPid);
  const cmd = procInfo.command || procInfo.executable || `PID ${occupantPid}`;

  const blockedReason = `Blocked: unknown process PID ${occupantPid} (${cmd}) occupies port ${port}; DATA_DIR owner unknown`;

  return {
    status: 'blocked',
    available: false,
    owner: 'unknown',
    pid: occupantPid,
    command: procInfo.command || procInfo.executable,
    executable: procInfo.executable,
    port,
    data_dir: null,
    reason: blockedReason
  };
}
