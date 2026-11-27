// Exercise the pinned AionCore HTTP API with a local ACP process and no model or user profile.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AION_RELEASE, createAionClient } from './aion-client.mjs';
import { ensureVerifiedExecutable } from './local-maintenance.mjs';
import { getProcessInfo, isPidAlive, killProcessTree } from './runtime-registry.mjs';

assert.equal(process.platform, 'win32');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-session-recovery-'));
const data = path.join(temp, 'aion'), home = path.join(temp, 'profile'), work = path.join(temp, 'work');
const state = path.join(temp, 'agent'), audit = path.join(state, 'audit.jsonl');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|comspec|pathext)$/i.test(key)));
Object.assign(env, { PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter),
  TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local') });
const events = () => fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let child, identity, base = '', startup = '', spawnError;
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'isolated AionCore exited');
    const result = await check();
    if (result) return result;
    await sleep(100);
  } while (Date.now() < deadline);
  throw Error('Timed out: ' + label);
}
try {
  for (const dir of [data, work, state, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  const runtime = path.resolve(import.meta.dirname, '../runtime');
  const executable = path.join(temp, 'aioncore.exe');
  const cache = ['aioncore', 'contract-aioncore'].map(dir => path.join(runtime, dir, 'aioncore.exe')).find(fs.existsSync);
  if (cache) fs.copyFileSync(cache, executable);
  await ensureVerifiedExecutable({ target: executable, ...AION_RELEASE, cachedArchive: path.join(runtime, 'download', AION_RELEASE.archive) });
  const password = randomUUID();
  await new Promise((resolve, reject) => {
    const init = execFile(executable, ['--data-dir', data, 'user', 'set-password', '--password-stdin'], { env, windowsHide: true, timeout: 30000 },
      error => error ? reject(Error('Test password setup failed')) : resolve());
    init.stdin.end(password + '\n');
  });
  child = spawn(executable, ['--port', '0', '--data-dir', data, '--work-dir', work, '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('error', error => { spawnError = error; });
  const scan = chunk => {
    startup = (startup + chunk).slice(-16000);
    const port = startup.match(/listening on [\d.]+:(\d+)/i)?.[1];
    if (port && startup.includes('AIONCORE_READY')) base = 'http://127.0.0.1:' + port;
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  identity = await getProcessInfo(child.pid);
  await until(() => base, 'AionCore ready', 60000);
  const { api, login } = createAionClient({ baseUrl: () => base });
  await login(password);
  const agent = await api('POST', '/api/agents/custom', { name: 'Local recovery fixture', command: 'node.exe',
    args: [path.join(import.meta.dirname, 'fixtures/session-recovery-acp.cjs'), state] });
  const session = async name => {
    const conversation = await api('POST', '/api/conversations', { name, type: 'acp', extra: { agent_id: agent.id, workspace: work } });
    const route = '/api/conversations/' + encodeURIComponent(conversation.id);
    const count = events().length;
    await api('POST', route + '/runtime/ensure', {});
    const started = await until(() => events().slice(count).find(e => e.method === 'session/new'), 'ACP session created');
    return { route, started, value: randomUUID() };
  };
  const messages = async s => (await api('GET', s.route + '/messages')).items;
  const prompt = (s, content) => api('POST', s.route + '/messages', { content });
  async function expectReply(s, content, expected) {
    const ids = new Set((await messages(s)).map(m => m.id));
    await prompt(s, content);
    await until(async () => (await messages(s)).some(m => !ids.has(m.id) && m.position === 'left' && m.content?.content === expected), 'fresh expected reply');
    await until(async () => (await api('GET', s.route)).runtime.state === 'idle', 'reply finished');
  }
  async function hold(s) {
    const count = events().length;
    const turn = await prompt(s, 'hold this turn');
    await until(() => events().slice(count).some(e => e.method === 'hold' && e.sessionId === s.started.sessionId), 'fixture turn is active');
    return turn.turn_id;
  }
  const target = await session('Target'), other = await session('Control');
  assert.notEqual(target.started.sessionId, other.started.sessionId);
  for (const s of [target, other]) await expectReply(s, 'remember ' + s.value, 'Saved');
  const original = await messages(target);
  assert.ok(original.length >= 2 && original.every(m => typeof m.id === 'string' && m.id.length), 'capture original history IDs');
  const otherTurn = await hold(other);
  const turn = await hold(target);
  await api('POST', target.route + '/cancel', { turn_id: turn });
  await until(() => events().some(e => e.method === 'session/cancel' && e.pid === target.started.pid), 'ACP cancellation delivered');
  await until(async () => (await api('GET', target.route)).runtime.state === 'idle', 'target cancellation');
  await expectReply(target, 'recall the saved value', target.value);
  await hold(target);
  await api('POST', target.route + '/runtime/restart', {});
  await until(() => !isPidAlive(target.started.pid), 'old target agent exits');
  await expectReply(target, 'recall the saved value', target.value);
  const loaded = events().filter(e => e.method === 'session/load' && e.sessionId === target.started.sessionId);
  assert.equal(loaded.length, 1, 'original ACP session loaded once');
  assert.notEqual(loaded[0].pid, target.started.pid);
  assert.ok(!events().some(e => e.pid === loaded[0].pid && e.method === 'session/new'), 'no replacement session created');
  const restored = await messages(target);
  for (const message of original) {
    assert.deepEqual(restored.find(m => m.id === message.id)?.content, message.content, 'original message ID and content retained');
  }
  assert.equal(isPidAlive(other.started.pid), true);
  assert.equal((await api('GET', other.route)).runtime.is_processing, true, 'other conversation still working');
  await api('POST', other.route + '/cancel', { turn_id: otherTurn });
  await until(async () => (await api('GET', other.route)).runtime.state === 'idle', 'control cancellation');
  await expectReply(other, 'recall the saved value', other.value);
  assert.ok(!events().some(e => e.method === 'session/load' && e.sessionId === other.started.sessionId));
} catch (error) {
  console.error('Recovery contract failed:', error.message);
  throw error;
} finally {
  if (child?.pid) assert.ok((await killProcessTree(child.pid, undefined, identity)).ok, 'isolated AionCore cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log('Pinned AionCore: active cancel, active restart, original backend session and message history recovered; independent control still working: PASS');
