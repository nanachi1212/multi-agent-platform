// Real Studio -> pinned AionCore -> loopback OpenAI stream. No paid model, global profile or user runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { AION_RELEASE } from './aion-client.mjs';
import { ensureVerifiedExecutable } from './local-maintenance.mjs';
import { getProcessInfo, killProcessTree } from './runtime-registry.mjs';

assert.equal(process.platform, 'win32', 'The integration uses the pinned Windows executable.');
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-budget-contract-'));
const project = path.join(temp, 'project'), runtime = path.join(temp, 'runtime'), home = path.join(temp, 'profile');
const settings = path.join(runtime, 'studio', 'settings.json');
const first = 'Budget card one', second = 'Budget card two';
const workerCalls = [];
let workerId, unexpected, child, identity, studioUrl, startupError;
const provider = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, messages, stream } = JSON.parse(body);
    assert.equal(stream, true);
    const user = messages.findLast(message => message.role === 'user').content;
    const prompt = Array.isArray(user) ? user.map(item => item.text).join('\n') : user;
    let reply, input = 0, output = 0;
    if (prompt.includes('Reply with exactly: OK')) {
      reply = 'OK'; // registration probes are separate conversations
    } else if (model === 'fixture-planner' && prompt.includes('Workers you can assign:')) {
      reply = JSON.stringify({ message: 'Run both budget cards.', subtasks: [first, second].map((title, i) => ({
        title, agent: workerId, instructions: 'Report completion for ' + title, after: i ? [0] : [], writes: false, role: 'build'
      })) });
    } else if (model === 'fixture-worker') {
      const title = [first, second].find(name => prompt.includes('Task: ' + name));
      assert.ok(title, 'worker received a project card');
      workerCalls.push(title);
      input = 79; output = 31;
      reply = 'Local work complete.\nSTATUS: DONE';
    } else {
      throw new Error('Unexpected prompt for ' + model);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (choices, usage) => res.write('data: ' + JSON.stringify({
      id: 'budget-fixture', object: 'chat.completion.chunk', created: 1, model, choices, usage
    }) + '\n\n');
    frame([{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }]);
    frame([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    frame([], { prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
    res.end('data: [DONE]\n\n');
  } catch (error) {
    unexpected = error;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid fixture request' } }));
  }
});

async function until(check, label) {
  const end = Date.now() + 60000;
  do {
    if (unexpected || startupError) throw unexpected || startupError;
    if (child?.exitCode != null) throw new Error('Studio exited with code ' + child.exitCode);
    const result = await check();
    if (result) return result;
    await sleep(150);
  } while (Date.now() < end);
  throw new Error('Timed out waiting for ' + label);
}

try {
  // Stage the production entry point and put its executable and writable data entirely under the fixture.
  fs.cpSync(import.meta.dirname, path.join(temp, 'studio'), { recursive: true });
  const binary = path.join(runtime, 'aioncore', 'aioncore.exe');
  for (const dir of [project, path.dirname(settings), path.dirname(binary), home, path.join(home, 'roaming'), path.join(home, 'local'), path.join(temp, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cached = ['contract-aioncore', 'aioncore'].map(dir => path.join(root, 'runtime', dir, 'aioncore.exe')).find(file => fs.existsSync(file));
  if (cached) fs.copyFileSync(cached, binary);
  await ensureVerifiedExecutable({ target: binary, ...AION_RELEASE, cachedArchive: path.join(root, 'runtime', 'download', AION_RELEASE.archive) });
  fs.writeFileSync(settings, JSON.stringify({ notify: false, workspaces: [{ project, workers: [] }] }));
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const portProbe = http.createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const studioPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|comspec|pathext)$/i.test(key)));
  // Only OS tools are on PATH. Startup checks cannot discover the user's installed agents.
  env.PATH = ['System32', 'System32/Wbem', 'System32/WindowsPowerShell/v1.0'].map(dir => path.join(process.env.SystemRoot, dir)).join(path.delimiter);
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    TEMP: path.join(temp, 'tmp'), TMP: path.join(temp, 'tmp'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    STUDIO_RUNTIME: runtime, STUDIO_PORT: String(studioPort), STUDIO_NO_OPEN: '1' });
  child = spawn(process.execPath, [path.join(temp, 'studio', 'server.mjs')], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { startupError = error; });
  child.stderr.resume();
  let output = '';
  child.stdout.on('data', data => {
    output = (output + data).slice(-4000);
    const match = /http:\/\/127\.0\.0\.1:\d+\/#t=[a-f\d]{64}/.exec(output);
    if (match) studioUrl = new URL(match[0]);
  });
  identity = await getProcessInfo(child.pid);
  await until(() => studioUrl, 'isolated Studio URL');
  async function api(route, body) {
    const response = await fetch(studioUrl.origin + '/api/' + route, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-studio-token': studioUrl.hash.slice(3) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, 'Studio ' + route + ' returned ' + response.status);
    return response.json();
  }
  const register = model => api('external/save', { name: model, platform: 'openai', model, baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1' });
  const { id: leaderId } = await register('fixture-planner');
  ({ id: workerId } = await register('fixture-worker'));
  await until(async () => {
    const { agents } = await api('state');
    return [leaderId, workerId].every(id => agents.find(agent => agent.id === id)?.status === 'available');
  }, 'both external members to pass their registration probes');
  await api('leader', { ws: project, agent: leaderId });
  await api('daily-api-budget', { ws: project, cap: 100 });
  await api('start', { ws: project, request: 'Exercise the two local budget cards.' });
  const workspace = await until(async () => {
    const [w] = (await api('state')).workspaces;
    return w.tasks.length === 2 && ['DONE', 'NEEDS_USER', 'FAILED'].includes(w.tasks[1].status) && w;
  }, 'the two cards to settle');
  assert.deepEqual(workerCalls, [first], 'the provider must receive exactly one worker card');
  assert.deepEqual(workspace.tasks.map(task => task.status), ['DONE', 'NEEDS_USER']);
  assert.match(workspace.tasks[1].ask.question, /今日 API 預算已用完/);
  assert.deepEqual(workspace.tasks[0].usage, { in: 79, out: 31, cache: 0, turns: 1 });
  assert.equal(workspace.apiDailyTokens, 110);
  assert.equal(JSON.parse(fs.readFileSync(settings)).workspaces[0].apiDailyUsage.tokens, 110);
} finally {
  await new Promise(resolve => provider.close(resolve));
  if (child?.pid) assert.ok((await killProcessTree(child.pid, undefined, identity)).ok, 'isolated Studio process cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log('External API budget contract: 79 + 31 = 110/100, one worker dispatch, next card NEEDS_USER, persisted usage: PASS');
