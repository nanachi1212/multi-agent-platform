// Real pinned AionCore HTTP + ACP contract. No real provider or user runtime is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { AION_RELEASE, createAionClient } from './aion-client.mjs';
import { acpBackendCommand, withAcpLauncherPath } from './acp-command.mjs';
import { ensureVerifiedExecutable } from './local-maintenance.mjs';
import { applyTurnModel } from './live-models.mjs';
import { getProcessInfo, killProcessTree, isPidAlive } from './runtime-registry.mjs';
import { processSnapshot, processTree } from './codex-runtime.mjs';

assert.equal(process.platform, 'win32', 'This gate tests the pinned Windows release; unsupported platforms must not report PASS.');
const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'runtime', 'contract-aioncore', 'aioncore.exe');
await ensureVerifiedExecutable({ target: executable, ...AION_RELEASE,
  cachedArchive: path.join(root, 'runtime', 'download', AION_RELEASE.archive) });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-aion-contract-'));
const data = path.join(temp, 'data'), work = path.join(temp, 'work 中文 space'), home = path.join(temp, 'home');
for (const dir of [data, work, home]) fs.mkdirSync(dir);
// Do not inherit provider keys, Codex home, global rules or the user's app data.
const env = withAcpLauncherPath(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext)$/i.test(key))));
Object.assign(env, { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CODEX_HOME: path.join(home, '.codex'), ACP_BATCH_VALUE: 'MUST_NOT_EXPAND' });
let child, identity, base, output = '';
const fixturePids = new Set();
try {
  const password = crypto.randomBytes(24).toString('hex');
  await new Promise((resolve, reject) => {
    const p = execFile(executable, ['--data-dir', data, 'user', 'set-password', '--password-stdin'],
      { env, windowsHide: true, timeout: 30000 }, error => error ? reject(new Error('Fixture password setup failed')) : resolve());
    p.stdin.end(password + '\n');
  });
  child = spawn(executable, ['--port', '0', '--data-dir', data, '--work-dir', work,
    '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AionCore fixture startup timed out')), 60000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error('AionCore fixture exited: ' + code)));
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8000);
      const port = output.match(/listening on [\d.]+:(\d+)/i)?.[1];
      if (port && output.includes('AIONCORE_READY')) { base = 'http://127.0.0.1:' + port; clearTimeout(timer); resolve(); }
    });
  });
  [identity] = await Promise.all([getProcessInfo(child.pid), ready]);
  assert.ok(identity.creationDate && identity.executable, 'capture backend identity before cleanup');
  const client = createAionClient({ baseUrl: () => base });
  await client.login(password);
  const { api } = client;
  const audit = path.join(temp, 'acp audit.jsonl');
  const agentExe = path.join(temp, 'Agent 中文 Tools', 'contract agent.exe');
  fs.mkdirSync(path.dirname(agentExe));
  fs.copyFileSync(process.execPath, agentExe);
  const literalArgs = ['', 'a b', 'say "hi"', 'C:\\Agent Data\\', '& | > %PATH% $HOME'];
  const agentArgs = [path.join(import.meta.dirname, 'fixtures', 'contract-acp.cjs'), audit, ...literalArgs];
  await assert.rejects(api('POST', '/api/agents/custom', { name: 'Raw path regression', command: agentExe, args: agentArgs }), /cli_not_found/,
    'pinned upstream truncates the unadapted executable path');
  const agent = await api('POST', '/api/agents/custom', { name: 'Studio contract fixture', ...acpBackendCommand(agentExe, agentArgs) });
  assert.equal(typeof agent.id, 'string');
  const conversation = await api('POST', '/api/conversations', { type: 'acp', name: 'Contract test', extra: { agent_id: agent.id, workspace: work } });
  assert.equal(typeof conversation.id, 'string');
  const route = `/api/conversations/${encodeURIComponent(conversation.id)}`;
  const request = (headers) => fetch(base + route + '/runtime/ensure', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}', signal: AbortSignal.timeout(10000) });
  const auth = client.authHeaders();
  assert.equal((await request({ cookie: auth.cookie, 'x-csrf-token': auth['x-csrf-token'] })).status, 401, 'real backend rejects missing authentication');
  assert.equal((await request({ authorization: auth.authorization })).status, 403, 'real backend rejects missing CSRF');
  const first = await api('POST', route + '/runtime/ensure', {});
  assert.equal(first.runtime.has_task, true);
  assert.equal(first.config_options.find(x => x.category === 'model').current_value, 'contract-small');
  assert.equal(first.config_options.find(x => x.category === 'thought_level').current_value, 'low');
  const readAudit = () => fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => {
    const event = JSON.parse(line); fixturePids.add(event.pid); fixturePids.add(event.parentPid); return event;
  });
  const sessionsBefore = readAudit().filter(x => x.method === 'session/new').length;
  assert.equal(sessionsBefore, 2, 'one registration probe plus one live conversation');
  const starts = readAudit().filter(x => x.method === 'initialize');
  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.equal(start.executable.toLowerCase(), agentExe.toLowerCase(), 'probe and live runtime launch the exact executable with spaces');
    assert.deepEqual(start.args, literalArgs, 'argv survives without shell expansion, including empty arguments and quotes');
  }
  assert.equal(isPidAlive(starts[0].pid), false, 'registration probe leaves no target process');
  assert.equal(isPidAlive(starts[0].parentPid), false, 'registration probe leaves no launcher process');
  assert.equal(isPidAlive(starts[1].pid), true, 'live executable is running');
  await assert.rejects(api('GET', route + '/config-options'), /404/, 'removed route must not be mocked as successful');
  const catalog = {};
  await applyTurnModel(api, conversation.id, { model: 'contract-large', effort: 'high' }, catalog);
  assert.deepEqual(catalog.models.map(x => x.value), ['contract-small', 'contract-large']);
  const second = await api('POST', route + '/runtime/ensure', {});
  assert.equal(second.recovered, false, 'model switching reuses the same live runtime');
  assert.equal(second.config_options.find(x => x.category === 'model').current_value, 'contract-large');
  assert.equal(second.config_options.find(x => x.category === 'thought_level').current_value, 'high');
  await assert.rejects(applyTurnModel(api, conversation.id, { model: 'not-in-catalog' }, catalog), /不支援/);
  const events = readAudit();
  assert.equal(events.filter(x => x.method === 'session/new').length, sessionsBefore, 'configuration does not restart the session');
  assert.deepEqual(events.filter(x => x.method === 'session/set_config_option').map(x => x.configId), ['model', 'reasoning_effort']);
  assert.ok(events.every(x => ['initialize', 'session/new', 'session/set_config_option'].includes(x.method)), 'no model prompt, tools or authentication requests');
  console.log(`AionCore ${AION_RELEASE.version} contract: executable path/name with spaces, literal argv, real auth/CSRF, custom ACP, runtime snapshot, removed GET, confirmed model/effort and session reuse: PASS`);

  for (const extension of ['cmd', 'bat']) {
    const batch = path.join(path.dirname(agentExe), 'contract agent.' + extension);
    // ASCII source; %~dp0 resolves the Unicode/spaced directory without code-page assumptions.
    const direct = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n"%~dp0contract agent.exe" %*\r\nexit /b %errorlevel%\r\n';
    const compound = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nset "dp0=%~dp0"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%contract agent.exe" %*\r\n';
    fs.writeFileSync(batch, extension === 'cmd' ? compound : direct);
    const batchAudit = path.join(temp, extension + ' audit.jsonl');
    const expectedArgs = ['', 'a b', 'C:\\Agent Data\\', 'tail\\\\', '& echo BAD>injected.txt | < ^ ( )', '中文',
      'say "hi"', '%ACP_BATCH_VALUE%', '!ACP_BATCH_VALUE!', '100%', '{"name":"100% !literal!"}',
      'x"&echo BAD>injected.txt&rem "', '"|echo BAD>injected2.txt&rem "', 'a' + '\\'.repeat(3) + '"b'];
    const batchArgs = [path.join(import.meta.dirname, 'fixtures', 'contract-acp.cjs'), batchAudit, ...expectedArgs];
    const custom = await api('POST', '/api/agents/custom', { name: 'Studio ' + extension + ' fixture', ...acpBackendCommand(batch, batchArgs) });
    const probeRows = await processSnapshot();
    assert.ok(!probeRows.some(row => row.command?.toLowerCase().includes(batch.toLowerCase())), 'registration probe cleans launcher and cmd.exe: ' + extension);
    const live = await api('POST', '/api/conversations', { type: 'acp', name: extension + ' contract', extra: { agent_id: custom.id, workspace: work } });
    const runtime = await api('POST', `/api/conversations/${encodeURIComponent(live.id)}/runtime/ensure`, {});
    assert.equal(runtime.runtime.has_task, true);
    const batchEvents = fs.readFileSync(batchAudit, 'utf8').trim().split('\n').map(JSON.parse);
    const starts = batchEvents.filter(event => event.method === 'initialize');
    assert.equal(starts.length, 2, 'batch registration probe plus live launch');
    for (const start of starts) {
      fixturePids.add(start.pid); fixturePids.add(start.parentPid);
      assert.equal(start.executable.toLowerCase(), agentExe.toLowerCase());
      assert.deepEqual(start.args, expectedArgs, 'batch forwards exact argv to the ACP agent');
    }
    assert.equal(isPidAlive(starts[0].pid), false, 'probe target is stopped');
    assert.equal(isPidAlive(starts[0].parentPid), false, 'probe cmd.exe is stopped');
    const rows = await processSnapshot();
    const ownedPids = new Set(processTree(rows, rows.find(row => row.pid === child.pid)).map(row => row.pid));
    const owned = rows.filter(row => ownedPids.has(row.pid));
    const target = owned.find(row => row.pid === starts[1].pid);
    const shell = owned.find(row => row.pid === target?.parent);
    const launcher = owned.find(row => row.pid === shell?.parent);
    assert.ok(target && /cmd\.exe$/i.test(shell?.executable) && launcher?.command?.includes('acp-launcher.cjs'), 'launcher, cmd.exe and agent stay in the owned backend tree');
    for (const row of [target, shell, launcher]) fixturePids.add(row.pid);
    assert.ok(batchEvents.every(event => ['initialize', 'session/new'].includes(event.method)), 'batch test invokes no models');
    assert.equal(fs.existsSync(path.join(work, 'injected.txt')), false);
    assert.equal(fs.existsSync(path.join(work, 'injected2.txt')), false);
    console.log(`AionCore ${extension} contract: real registration, live ACP launch, literal quotes/%/!, no injection and probe tree cleanup: PASS`);
  }
} catch (error) {
  // No credentials or protocol bodies are printed. Backend startup output is diagnostic only.
  console.error('Contract failure:', error.message);
  if (!base) console.error(output);
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    const cleaned = await killProcessTree(child.pid, undefined, identity);
    assert.equal(cleaned.ok, true, 'fixture process tree must be fully stopped');
    for (const pid of fixturePids) assert.equal(isPidAlive(pid), false, 'fixture launcher/target must be stopped: ' + pid);
    console.log('AionCore contract fixture process cleanup: PASS');
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
