import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// ---------- System Process & Port Helpers (Windows-first) ----------

function execPowerShell(cmd) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
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

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export async function getProcessInfo(pid) {
  if (!isPidAlive(pid)) return { pid, exists: false, command: '', executable: '' };
  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue | Select-Object -Property ProcessId, Name, CommandLine, CreationDate | ConvertTo-Json -Compress`;
      const out = await execPowerShell(psCmd);
      if (out && out.trim()) {
        const data = JSON.parse(out.trim());
        return {
          pid,
          exists: true,
          name: data.Name || '',
          executable: data.Name || '',
          command: data.CommandLine || data.Name || '',
          creationDate: data.CreationDate || ''
        };
      }
    } catch (e) {}
  }
  return { pid, exists: isPidAlive(pid), command: '', executable: '' };
}

export async function getChildPids(parentPid) {
  if (!parentPid || !isPidAlive(parentPid)) return [];
  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId`;
      const out = await execPowerShell(psCmd);
      if (out && out.trim()) {
        const lines = out.trim().split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter(Boolean);
        const allDescendants = [...lines];
        for (const childPid of lines) {
          const subChildren = await getChildPids(childPid);
          allDescendants.push(...subChildren);
        }
        return [...new Set(allDescendants)];
      }
    } catch (e) {}
  }
  return [];
}

/**
 * Terminate a process tree.
 * CRITICAL RULE: Kills strictly by PID tree (taskkill /F /T /PID <pid>).
 * NEVER kills by process name (no Stop-Process -Name python).
 */
export async function killProcessTree(rootPid) {
  if (!rootPid || !isPidAlive(rootPid)) return { ok: true, killed: false };
  const children = await getChildPids(rootPid).catch(() => []);

  if (process.platform === 'win32') {
    try {
      await execCmd('taskkill', ['/F', '/T', '/PID', String(rootPid)]);
    } catch (e) {
      // taskkill may return code 128 if process already exited
    }
  }

  if (isPidAlive(rootPid)) {
    try { process.kill(rootPid, 'SIGKILL'); } catch (e) {}
  }

  for (const childPid of children) {
    if (isPidAlive(childPid)) {
      if (process.platform === 'win32') {
        try { await execCmd('taskkill', ['/F', '/PID', String(childPid)]); } catch (e) {}
      }
      if (isPidAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL'); } catch (e) {}
      }
    }
  }

  return { ok: true, killed: true, rootPid, children };
}

export async function getPortOccupant(port) {
  if (!port || typeof port !== 'number') return null;
  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Property LocalPort, OwningProcess | ConvertTo-Json -Compress`;
      const out = await execPowerShell(psCmd);
      if (out && out.trim()) {
        const data = JSON.parse(out.trim());
        const pid = Array.isArray(data) ? data[0].OwningProcess : data.OwningProcess;
        if (pid && typeof pid === 'number') return pid;
      }
    } catch (e) {}

    try {
      const stdout = await execCmd('netstat', ['-ano', '-p', 'tcp']);
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'TCP' && parts[3] === 'LISTENING') {
          const addr = parts[1];
          const p = parseInt(addr.split(':').pop(), 10);
          if (p === port) {
            const pid = parseInt(parts[4], 10);
            if (pid) return pid;
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

// ---------- Safety checks ----------

function isSafeTempDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const resolved = path.resolve(dirPath);
  const tempRoot = path.resolve(os.tmpdir());
  // Ensure the directory is inside the system temp directory and contains expected studio markers
  if (!resolved.toLowerCase().startsWith(tempRoot.toLowerCase())) return false;
  return /MultiAgentStudio|studio-rt-|smoke-|temp-/i.test(resolved);
}

// ---------- Runtime Registry Persistence & Operations ----------

export function runtimesFile(rtDir) {
  const base = rtDir || process.env.STUDIO_RUNTIME_DIR || path.join(process.cwd(), 'runtime');
  return path.join(base, 'studio', 'runtimes.json');
}

export function loadRuntimes(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

export function saveRuntimes(filePath, runtimes) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(runtimes, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save runtimes.json:', e.message);
  }
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
  port = null,
  data_dir = null,
  temp_dir = null,
  status = 'running',
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
    port: port || null,
    data_dir: data_dir ? path.resolve(data_dir) : null,
    temp_dir: temp_dir ? path.resolve(temp_dir) : null,
    started_at: now,
    heartbeat_at: now,
    status
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

export async function cleanupJobRuntimes(jobId, { rtDir = null, customRuntimes = null } = {}) {
  if (!jobId) return { cleaned: 0 };
  const file = runtimesFile(rtDir);
  const runtimes = customRuntimes || loadRuntimes(file);
  let cleaned = 0;

  for (const r of runtimes) {
    if (r.job_id === jobId && r.status === 'running') {
      if (r.root_pid) {
        await killProcessTree(r.root_pid);
      }
      if (r.temp_dir && isSafeTempDir(r.temp_dir)) {
        try { fs.rmSync(r.temp_dir, { recursive: true, force: true }); } catch (e) {}
      }
      r.status = 'cleaned';
      r.heartbeat_at = new Date().toISOString();
      cleaned++;
    }
  }

  if (!customRuntimes) {
    saveRuntimes(file, runtimes);
  }
  return { cleaned };
}

export async function cleanupStaleRuntimes({ rtDir = null, customRuntimes = null } = {}) {
  const file = runtimesFile(rtDir);
  const runtimes = customRuntimes || loadRuntimes(file);
  let cleanedCount = 0;
  let staleCount = 0;

  for (const r of runtimes) {
    if (r.status !== 'running') continue;

    const alive = isPidAlive(r.root_pid);
    if (!alive) {
      if (r.temp_dir && isSafeTempDir(r.temp_dir)) {
        try { fs.rmSync(r.temp_dir, { recursive: true, force: true }); } catch (e) {}
      }
      r.status = 'cleaned';
      r.heartbeat_at = new Date().toISOString();
      cleanedCount++;
    } else {
      const info = await getProcessInfo(r.root_pid);
      const matchesExecutable = r.executable && info.executable &&
        info.executable.toLowerCase().includes(path.basename(r.executable).toLowerCase());
      const matchesCommand = r.command && info.command &&
        (info.command.includes(r.command) || r.command.includes(info.command));

      if (!matchesExecutable && !matchesCommand) {
        // PID reused by unrelated program! DO NOT kill that process!
        if (r.temp_dir && isSafeTempDir(r.temp_dir)) {
          try { fs.rmSync(r.temp_dir, { recursive: true, force: true }); } catch (e) {}
        }
        r.status = 'stale';
        r.heartbeat_at = new Date().toISOString();
        staleCount++;
      } else {
        // Confirmed leftover process from crashed Studio: safely clean up PID tree
        await killProcessTree(r.root_pid);
        if (r.temp_dir && isSafeTempDir(r.temp_dir)) {
          try { fs.rmSync(r.temp_dir, { recursive: true, force: true }); } catch (e) {}
        }
        r.status = 'cleaned';
        r.heartbeat_at = new Date().toISOString();
        cleanedCount++;
      }
    }
  }

  if (!customRuntimes) {
    saveRuntimes(file, runtimes);
  }
  return { cleanedCount, staleCount, total: runtimes.length };
}

export async function checkPortOwnership(port, { desiredJobId, desiredDataDir, rtDir = null, customRuntimes = null } = {}) {
  const occupantPid = await getPortOccupant(port);
  if (!occupantPid) {
    return { status: 'free', available: true, port };
  }

  const runtimes = customRuntimes || loadRuntimes(runtimesFile(rtDir));
  const matched = runtimes.find((r) => r.root_pid === occupantPid || (r.child_pids && r.child_pids.includes(occupantPid)));

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

    if (desiredJobId && matched.job_id === desiredJobId) {
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

  let blockedReason;
  if (port === 3018) {
    blockedReason = `Blocked: unknown process PID ${occupantPid} (${cmd}) owns production data lock on port ${port}`;
  } else {
    blockedReason = `Blocked: unknown process PID ${occupantPid} (${cmd}) occupies port ${port}`;
  }

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
