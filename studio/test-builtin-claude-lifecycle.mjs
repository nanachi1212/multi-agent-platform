// Windows integration: the pinned native Claude adapter, with a local stand-in for the CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AION_RELEASE, createAionClient } from './aion-client.mjs';
import { ensureVerifiedExecutable } from './local-maintenance.mjs';
import { getProcessInfo, killProcessTree } from './runtime-registry.mjs';
import { processSnapshot, processTree } from './codex-runtime.mjs';
import { sendClaudeMessage, stopClaudeConversation } from './claude-runtime.mjs';

assert.equal(process.platform, 'win32');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-native-claude-測試-'));
const dir = name => path.join(temp, name);
const project = dir('project');
const other = dir('other');
const bin = dir('bin');
const home = dir('home');
const runtime = dir('runtime');
const data = path.join(runtime, 'studio', 'data');
const fake = path.join(bin, 'claude.exe');
const sys = process.env.SystemRoot;
const env = { SystemRoot: sys, WINDIR: sys, COMSPEC: path.join(sys, 'System32', 'cmd.exe'), PATHEXT: '.EXE;.CMD;.BAT',
  PATH: [bin, path.join(sys, 'System32')].join(path.delimiter), USERPROFILE: home, HOME: home,
  APPDATA: dir('roaming'), LOCALAPPDATA: dir('local'), TEMP: dir('tmp'), TMP: dir('tmp'), CLAUDE_CONFIG_DIR: dir('profile') };
const root = path.resolve(import.meta.dirname, '..');
const pin = path.join(bin, 'aioncore.exe');
let child, owner, output = '';
async function until(check, label) {
  const end = Date.now() + 25000;
  do {
    if (child?.exitCode != null) throw Error('AionCore exited with ' + child.exitCode);
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < end);
  throw Error('Timed out: ' + label);
}
try {
  for (const d of [bin, project, other, data, home, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(d, { recursive: true });
  const compiler = path.join(sys, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/r:System.Web.Extensions.dll', '/out:' + fake, path.join(import.meta.dirname, 'fixtures/FixtureClaude.cs')], { windowsHide: true });
  const cached = ['aioncore', 'contract-aioncore'].map(n => path.join(root, 'runtime', n, 'aioncore.exe')).find(f => fs.existsSync(f));
  if (cached) fs.copyFileSync(cached, pin);
  await ensureVerifiedExecutable({ target: pin, ...AION_RELEASE, cachedArchive: path.join(root, 'runtime/download', AION_RELEASE.archive) });
  const password = randomBytes(24).toString('hex');
  execFileSync(pin, ['--data-dir', data, 'user', 'set-password', '--password-stdin'], { cwd: temp, env, input: password + '\n', windowsHide: true, timeout: 30000 });
  child = spawn(pin, ['--port', '0', '--data-dir', data, '--work-dir', project, '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)],
    { env, cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-12000); });
  owner = await getProcessInfo(child.pid);
  assert.ok(owner?.executable && owner.creationDate);
  const port = await until(() => output.includes('AIONCORE_READY') && output.match(/listening on [\d.]+:(\d+)/i)?.[1], 'loopback fixture startup');
  const { login, api } = createAionClient({ baseUrl: () => 'http://127.0.0.1:' + port });
  await login(password);
  const { id: cid } = await api('POST', '/api/conversations', { type: 'acp', extra: { backend: 'claude', workspace: project, session_mode: 'dontAsk' } });
  const route = '/api/conversations/' + encodeURIComponent(cid);
  await api('POST', route + '/runtime/ensure', {});
  const audit = await until(() => fs.readdirSync(project).find(f => f.endsWith('.audit')), 'built-in adapter reached our private claude.exe');
  const events = () => fs.readFileSync(path.join(project, audit), 'utf8').trim().split('\n').map(JSON.parse);
  const idle = async () => { const { runtime: r } = await api('GET', route); return r.state === 'idle' && !r.is_processing; };
  const secret = randomUUID().replaceAll('-', '');
  const send = content => sendClaudeMessage(runtime, cid, owner, () => api('POST', route + '/messages', { content }));
  const responses = async () => (await api('GET', route + '/messages')).items.filter(x => x.position === 'left').map(x => x.content?.content);
  await send('W1_REMEMBER_' + secret);
  await until(async () => (await responses()).includes('stored') && await idle(), 'first persisted turn');
  const { id: siblingId } = await api('POST', '/api/conversations', { type: 'acp', extra: { backend: 'claude', workspace: other, session_mode: 'dontAsk' } });
  const siblingRoute = '/api/conversations/' + encodeURIComponent(siblingId);
  await api('POST', siblingRoute + '/runtime/ensure', {});
  const siblingAudit = await until(() => fs.readdirSync(other).find(f => f.endsWith('.audit')), 'second native CLI');
  const sibling = JSON.parse(fs.readFileSync(path.join(other, siblingAudit), 'utf8').trim());
  const siblingMarker = randomUUID().replaceAll('-', '');
  await api('POST', siblingRoute + '/messages', { content: 'W1_REMEMBER_' + siblingMarker });
  await until(async () => (await api('GET', siblingRoute + '/messages')).items.some(x => x.content?.content === 'stored'), 'second session response');
  let recalled = 0;
  for (const mode of ['studio-stop', 'runtime-restart']) {
    const previous = events();
    const started = performance.now();
    await send(mode === 'studio-stop' ? 'W1_HOLD' : 'W1_HOLD_TIMER');
    const held = await until(() => events().slice(previous.length).find(e => e.action === 'working'), 'foreground fixture child');
    assert.equal((await api('GET', route)).runtime.is_processing, true);
    const seen = await processSnapshot();
    const tree = processTree(seen, { ...owner, pid: child.pid });
    const processIds = [held.pid, held.worker];
    const originals = processIds.map(pid => tree.find(p => p.pid === pid));
    const neighbor = tree.find(p => p.pid === sibling.pid);
    assert.ok(neighbor?.creationDate && neighbor.executable.toLowerCase() === fake.toLowerCase());
    assert.ok(originals.every(p => p?.creationDate && p.executable.toLowerCase() === fake.toLowerCase()));
    if (mode === 'studio-stop') {
      assert.equal(await stopClaudeConversation({ cid, api, rtDir: runtime, owner: () => ({ ...owner, pid: child.pid }) }), true);
    } else {
      await api('POST', route + '/runtime/restart', {});
    }
    await until(async () => {
      const now = await processSnapshot();
      return originals.every(p => !now.some(n => n.pid === p.pid && (!n.creationDate || p.creationDate === n.creationDate)));
    }, mode + ' stops original native CLI and child');
    assert.ok(performance.now() - started < 85000, 'the 90-second timer must be gone before its natural exit');
    assert.ok(events().slice(previous.length).some(e => e.action === 'resume' && e.pid !== held.pid), 'new CLI uses --resume with the original on-disk ID');
    await send('W1_RECALL');
    recalled++;
    await until(async () => (await responses()).filter(x => x === 'recall-' + secret).length === recalled && await idle(), 'restored CLI reads its prior conversation');
    assert.ok((await responses()).includes('stored'), 'AionCore retains the initial conversation message');
    assert.ok((await processSnapshot()).some(p => p.pid === neighbor.pid && p.creationDate === neighbor.creationDate), 'neighboring conversation process stays alive');
    console.log(mode + ': original CLI and ordinary child exited; original persisted session and history recovered: PASS');
  }
  await api('POST', siblingRoute + '/messages', { content: 'W1_RECALL' });
  await until(async () => (await api('GET', siblingRoute + '/messages')).items.some(x => x.content?.content === 'recall-' + siblingMarker), 'second session retains its own history');
} finally {
  if (child?.pid && owner) assert.equal((await killProcessTree(child.pid, undefined, owner)).ok, true);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
