// P0 spike helpers. One-off probe code, not product code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(ROOT, 'runtime', 'aioncore', 'aioncore.exe');
export const EXPECTED_SHA256 = '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892';
export const EXPECTED_VERSION = 'aioncore 0.2.2';
export const EVID = join(ROOT, 'reports', 'evidence');
mkdirSync(EVID, { recursive: true });

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(file, obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  appendFileSync(join(EVID, file), line + '\n');
  console.log(line.length > 2000 ? line.slice(0, 2000) + '…' : line);
}

// Mask secrets in anything we persist.
export function mask(s) {
  return String(s)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1****')
    .replace(/("?(token|password|secret|jwt|access_token|refresh_token|cookie)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1****');
}

// Fail closed if the binary is not the pinned one.
export function verifyBinary() {
  const h = sha256(readFileSync(BIN));
  if (h !== EXPECTED_SHA256) throw new Error(`binary sha256 mismatch: ${h}`);
  return h;
}

/**
 * Start a spike-owned aioncore. Resolves after AIONCORE_LISTENING + AIONCORE_READY.
 * opts: { dataDir, workDir, mode: 'local'|'webui', resources: 'bundled'|'download', extraArgs, env, logFile, timeoutMs }
 */
export function startAioncore(opts) {
  verifyBinary();
  const args = ['--port', '0', '--data-dir', opts.dataDir, '--work-dir', opts.workDir,
    '--parent-pid', String(process.pid), '--managed-resources-mode', opts.resources ?? 'bundled'];
  if (opts.mode === 'local') args.push('--local'); else args.push('--identity-mode', opts.mode ?? 'webui');
  if (opts.logLevel) args.push('--log-level', opts.logLevel);
  args.push(...(opts.extraArgs ?? []));
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(opts.workDir, { recursive: true });
  // P0_AION_IN_JOB=1: launch aioncore inside a KILL_ON_JOB_CLOSE Job via job-runner.ps1 (W1 workaround probe).
  // proc is then the wrapper; killing it closes the job and the OS kills every job member.
  if (process.env.P0_AION_IN_JOB === '1') {
    const argvB64 = Buffer.from(JSON.stringify([opts.bin ?? BIN, ...args])).toString('base64');
    args.splice(0, args.length, '-NoProfile', '-NonInteractive', '-File', join(ROOT, 'spikes', 'job-runner.ps1'), '-ArgvB64', argvB64);
    opts = { ...opts, bin: 'pwsh' };
  }
  const proc = spawn(opts.bin ?? BIN, args, {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  opts.onSpawn?.(proc);
  const logFile = opts.logFile ?? 'aioncore-stdout.log';
  log(logFile, { at: new Date().toISOString(), event: 'spawn', pid: proc.pid, argv: [opts.bin ?? BIN, ...args] });
  return new Promise((resolve, reject) => {
    let listening = null, buf = '';
    const t = setTimeout(() => { proc.kill(); reject(new Error('startup timeout; listening=' + JSON.stringify(listening))); }, opts.timeoutMs ?? 180000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        appendFileSync(join(EVID, logFile), 'STDOUT ' + mask(line) + '\n');
        // Only the documented machine-readable lines are parsed.
        if (!listening && line.startsWith('AIONCORE_LISTENING ')) {
          listening = JSON.parse(line.slice('AIONCORE_LISTENING '.length));
          if (typeof listening.port !== 'number' || listening.host !== '127.0.0.1') {
            proc.kill(); clearTimeout(t); reject(new Error('unexpected LISTENING payload ' + line)); return;
          }
        } else if (line === 'AIONCORE_READY') {
          if (!listening) { proc.kill(); clearTimeout(t); reject(new Error('READY before LISTENING')); return; }
          clearTimeout(t);
          resolve({ proc, port: listening.port, base: `http://127.0.0.1:${listening.port}` });
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => appendFileSync(join(EVID, logFile), 'STDERR ' + mask(d)));
    proc.on('exit', (code, sig) => {
      appendFileSync(join(EVID, logFile), `EXIT code=${code} sig=${sig}\n`);
      clearTimeout(t); reject(new Error(`exited before ready code=${code}`));
    });
  });
}

/** Minimal REST client. Records request/response to evidence (masked). */
export function client(base, { headers = {}, evid = 'api.log' } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  async function req(method, path, body) {
    const started = Date.now();
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    appendFileSync(join(EVID, evid), JSON.stringify({ at: new Date().toISOString(), method, path,
      body: body === undefined ? undefined : JSON.parse(mask(JSON.stringify(body))),
      status: res.status, ms: Date.now() - started, resp: mask(text.slice(0, 4000)) }) + '\n');
    return { status: res.status, json, text, headers: res.headers };
  }
  return { req, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b ?? {}), patch: (p, b) => req('PATCH', p, b), del: (p) => req('DELETE', p), headers: h };
}

export function writeJson(name, obj) { writeFileSync(join(EVID, name), JSON.stringify(obj, null, 2)); }

/** Snapshot of process tree (pid, ppid, name, cmdline-head) via PowerShell CIM. */
export async function processTable() {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.CreationDate }));
}

export function descendants(table, rootPid) {
  const out = []; const q = [rootPid]; const seen = new Set([rootPid]);
  while (q.length) {
    const p = q.shift();
    for (const c of table) if (c.ppid === p && !seen.has(c.pid)) { seen.add(c.pid); out.push(c); q.push(c.pid); }
  }
  return out;
}

export function alive(table, pids) {
  const s = new Set(table.map((p) => p.pid));
  return pids.filter((p) => s.has(p));
}
