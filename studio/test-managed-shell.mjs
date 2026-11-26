// Positive local fixture: an owned shell, its timer, and an IPv4 listener.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import harness from './lifecycle-harness.cjs';
import * as registry from './runtime-registry.mjs';
import { isPackagedPowerShell, launchPackagedPowerShell, managedExecutableExists, shellJobReceipt } from './managed-shell.mjs';

const requireStore = process.env.STUDIO_REQUIRE_STORE_TEST === '1';
if (process.platform !== 'win32') {
  if (requireStore) throw new Error('STUDIO_REQUIRE_STORE_TEST requires a Windows host');
  console.log('Windows Job fixture requires Windows'); process.exit(0);
}
const classic = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const example = '引號 "two words" and trailing \\';
const file = fileURLToPath(import.meta.url);
async function startOwner(base, exe, mode) {
  const rtDir = path.join(base, 'registry'), dataDir = path.join(base, 'data');
  const port = Number(fs.readFileSync(path.join(base, 'port'), 'utf8'));
  let env;
  const E = harness.makeEnv(() => '', {
    ...registry, RT: rtDir, wsOf: () => env,
    // Readiness is verified from a second process with the persisted pid and actual listener.
    checkBackendReadiness: async () => ({ status: 'starting' }),
    isPackagedPowerShell: mode === 'baseline' ? () => true : isPackagedPowerShell,
    registerRuntime(options) {
      const runtime = registry.registerRuntime(options);
      fs.writeFileSync(path.join(dataDir, 'fixture.json'), JSON.stringify({ job: 'Local\\StudioManagedShell-' + runtime.shell_job, node: process.execPath }));
      return runtime;
    },
  });
  const t = { id: 'backend', agent: 'codex', title: 'fixture', writes: true, status: 'WORKING', after: [] };
  env = { project: base, tasks: [t], workers: [], activity: [], leader: 'codex',
    run: { id: 'local-test', convs: {}, phase: 'planning', active: true } };
  E.env.S.workspaces.push(env);
  E.api.loadLeases();
  await E.api.acquireWrite(env, t, await E.api.workspaceOf(base));
  const script = fs.readFileSync(new URL('./fixtures/managed-shell-lifecycle.ps1', import.meta.url), 'utf8');
  const argument = mode === 'baseline' ? "'" + example + "'" : '$args[0]';
  const wrapped = "try { & {\n" + script + "\n} " + argument + " } catch { [IO.File]::WriteAllText((Join-Path $env:DATA_DIR 'fixture-error.txt'), $_.ToString()); exit 2 }";
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', ...(mode === 'baseline'
    ? ['-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')]
    : ['-CommandWithArgs', wrapped, example])];
  await E.api.startManagedRuntime({ ws: base, cardId: t.id, executable: exe, cwd: base, dataDir, port, args });
  // The managed backend must remain usable when this Studio process closes normally.
}

async function waitFor(check, description, limit = 20000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    const result = check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + description);
}

async function exercise(exe, mode) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-shell-job-'));
  const rtDir = path.join(base, 'registry'), dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  fs.writeFileSync(path.join(base, 'port'), String(port));
  let drained = false;
  try {
    const owner = spawn(process.execPath, [file, 'owner', base, exe, mode], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    const [code] = await once(owner, 'close');
    assert.equal(code, 0, mode + ' start via Studio');
    const [runtime] = registry.listRuntimes({ rtDir });
    assert.ok(runtime.shell_job && runtime.process_identity.creationDate);
    assert.deepEqual(runtime.args, []);
    assert.ok(!JSON.stringify(runtime).includes(example));
    const out = path.join(dataDir, 'observed.json');
    const actual = await waitFor(() => {
      const error = path.join(dataDir, 'fixture-error.txt');
      if (fs.existsSync(error)) throw new Error(fs.readFileSync(error, 'utf8'));
      return fs.existsSync(out) && JSON.parse(fs.readFileSync(out));
    }, mode + ' shell ready');
    assert.equal(actual.member, true, 'target independently belongs to exact Job');
    assert.equal(actual.pid, runtime.root_pid);
    assert.equal(actual.image.toLowerCase(), runtime.process_identity.executable.toLowerCase());
    assert.equal(actual.argument, example);
    assert.equal(actual.cwd.toLowerCase(), base.toLowerCase());
    assert.equal(registry.isPidAlive(actual.child), true);
    const ownership = await registry.checkPortOwnership(port, { rtDir, desiredJobId: runtime.job_id, desiredDataDir: dataDir });
    assert.equal(ownership.status, 'owned_by_current_job', ownership.reason);
    assert.equal(ownership.pid, actual.pid);
    if (mode !== 'stop-alias') {
      fs.writeFileSync(path.join(dataDir, 'finish'), '');
      const receipt = await waitFor(() => shellJobReceipt(rtDir, runtime), mode + ' Job drain');
      assert.equal(receipt.exit_code, 42);
    }
    const cleaned = await registry.cleanupRuntime(runtime, { rtDir });
    assert.equal(cleaned.ok, true, cleaned.reason);
    const [last] = registry.listRuntimes({ rtDir });
    assert.equal(last.status, 'cleaned');
    assert.equal(last.exit_code, mode === 'stop-alias' ? 1 : 42);
    assert.equal(registry.isPidAlive(actual.child), false);
    assert.equal(registry.isPidAlive(actual.pid), false);
    assert.deepEqual(fs.readdirSync(path.join(rtDir, 'studio', 'shell-jobs')), [runtime.shell_job + '.drained']);
    drained = true;
    console.log(mode + ' PASS: real PID, exact Job, argv, cwd, port ownership, Studio reconnect, Job drained, exit ' + last.exit_code);
  } finally {
    if (drained) fs.rmSync(base, { recursive: true, force: true });
    else { fs.writeFileSync(path.join(dataDir, 'finish'), ''); console.error('Preserved diagnostic data:', base); }
  }
}

if (process.argv[2] === 'owner') {
  await startOwner(...process.argv.slice(3));
  process.exit(0);
}

// Aborted registry admission never starts the suspended shell. No binary is retained.
const aborted = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-admission-'));
try {
  await assert.rejects(launchPackagedPowerShell(classic, ['-NoProfile', '-Command', 'exit 0'],
    { rtDir: aborted, cwd: aborted, env: { SystemRoot: process.env.SystemRoot } }, () => { throw new Error('fixture registration unavailable'); }), /registration unavailable/);
  assert.deepEqual(fs.readdirSync(path.join(aborted, 'studio', 'shell-jobs')), []);
} finally { fs.rmSync(aborted, { recursive: true, force: true }); }
console.log('Aborted registry admission removed its temporary helper: PASS');

const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-drain-evidence-'));
const smokeRoot = path.join(os.tmpdir(), 'MultiAgentStudio', randomUUID());
const smoke = path.join(smokeRoot, 'fixture');
try {
  fs.mkdirSync(path.join(missing, 'studio', 'shell-jobs'), { recursive: true });
  fs.mkdirSync(smoke, { recursive: true });
  const pending = registry.registerRuntime({ rtDir: missing, shell_job: randomUUID(), job_id: 'absent-receipt', temp_dir: smoke, status: 'running' });
  const result = await registry.cleanupJobRuntimes(pending.job_id, { rtDir: missing });
  assert.equal(result.cleaned, 0);
  assert.match(result.blocked[0].reason, /未收到 Windows Job/);
  assert.ok(fs.existsSync(smoke));
  assert.equal(registry.listRuntimes({ rtDir: missing })[0].status, 'running');
} finally {
  fs.rmSync(smokeRoot, { force: true, recursive: true });
  fs.rmSync(missing, { force: true, recursive: true });
}
console.log('Missing Job receipt blocks cleanup and retains the isolated data directory: PASS');
assert.equal(isPackagedPowerShell(classic), false);
assert.equal(isPackagedPowerShell(process.execPath), false);
await exercise(classic, 'baseline');
let install = '';
try {
  install = execFileSync(classic, ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction Stop | Select-Object -First 1).InstallLocation"],
  { windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { console.log('Microsoft Store package inventory was unavailable to this runner'); }
const direct = install && path.join(install, 'pwsh.exe');
const alias = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe');
for (const [mode, exe] of [['natural-store', direct], ['stop-alias', alias]]) {
  if (exe && managedExecutableExists(exe)) {
    assert.equal(isPackagedPowerShell(exe), true);
    await exercise(exe, mode);
  } else {
    const detail = mode + ' NOT TESTED: Microsoft Store PowerShell installation or alias unavailable';
    if (mode === 'natural-store' && requireStore) throw new Error(detail);
    console.log(detail);
  }
}
