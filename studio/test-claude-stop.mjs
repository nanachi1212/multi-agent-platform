import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sendClaudeMessage, stopClaudeConversation } from './claude-runtime.mjs';

// Keep the database ID, the native CLI's UUID and each process creation time distinct.
const cid = 'd62a12a8', uuid = '6593aa6c-dc82-4260-99d5-f31b276d034f';
const controller = { pid: 1, parent: 0, executable: 'C:/fixture/aioncore.exe', creationDate: '2026-01-01T10:00:00Z' };
function cli(pid, mode) {
  return { pid, parent: 1, executable: 'C:/fixture/claude.exe', command: 'claude.exe --' + mode + ' ' + uuid,
    creationDate: '2026-01-01T10:00:' + String(pid).padStart(2, '0') + 'Z' };
}
const child = { pid: 3, parent: 2, executable: 'C:/fixture/worker.exe', creationDate: '2026-01-01T10:00:03Z' };
const idle = { state: 'idle', is_processing: false, has_task: true };

function fixture(t) {
  const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-claude-stop-test-'));
  t.after(() => fs.rmSync(rtDir, { recursive: true, force: true }));
  const f = { rows: [controller, cli(2, 'session-id'), child], runtime: { ...idle, is_processing: true, turn_id: 'turn1' },
    calls: [], messages: [{ id: 'past' }], keepChild: false, restarts: 0 };
  async function api(method, endpoint) {
    const route = endpoint.slice(('/api/conversations/' + cid).length);
    f.calls.push(method + ' ' + route);
    if (method === 'GET' && !route) return { runtime: f.runtime };
    if (method === 'GET' && route === '/messages?limit=1') return { items: f.messages };
    if (method === 'POST' && route === '/cancel') { f.runtime = idle; return {}; }
    if (method === 'POST' && route === '/runtime/restart') {
      f.restarts++;
      f.rows = [controller, cli(10 + f.restarts, 'resume'), ...(f.keepChild ? [child] : [])];
      return { runtime: f.runtime = idle };
    }
    throw new Error('unexpected request: ' + method + ' ' + endpoint);
  }
  f.stop = options => stopClaudeConversation({ cid, api, rtDir, owner: () => controller,
    snapshot: async () => f.rows, anchor: async () => uuid, ...options });
  f.send = action => sendClaudeMessage(rtDir, cid, controller, action);
  return f;
}

async function blocked(f) {
  let sent = false;
  await assert.rejects(f.send(async () => { sent = true; }), e => e.stopUnconfirmed === true);
  assert.equal(sent, false, 'stop fence rejected the message before provider I/O');
}

test('a newly created conversation can pause before its first send', async t => {
  const f = fixture(t);
  f.runtime = { ...idle, has_task: false };
  f.messages = [];
  assert.equal(await f.stop({ anchor: assert.fail, snapshot: assert.fail }), true);
  assert.deepEqual(f.calls, ['GET ', 'GET /messages?limit=1']);
  assert.equal(await f.send(async () => 'first turn'), 'first turn');
});

test('stop waits for a message that has already been submitted', async t => {
  const f = fixture(t);
  let acknowledge;
  const send = f.send(() => new Promise(resolve => { acknowledge = resolve; }));
  const stop = f.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [], 'stop cannot observe idle before the send settles');
  acknowledge('turn1');
  assert.equal(await send, 'turn1');
  assert.equal(await stop, true);
  assert.equal(f.restarts, 1);
});

test('an unconfirmed send retains the stop fence even when the conversation reports idle', async t => {
  const f = fixture(t);
  await assert.rejects(f.send(async () => { throw Object.assign(new Error('request timed out'), { stopUnconfirmed: true }); }));
  f.runtime = idle;
  assert.equal(await f.stop(), false);
  assert.equal(f.restarts, 0);
  await blocked(f);
});

test('an unreadable controller identity cannot turn a timed-out first send into an empty conversation', async t => {
  const f = fixture(t);
  f.runtime = { ...idle, has_task: false };
  f.messages = [];
  await assert.rejects(f.send(async () => { throw Object.assign(new Error('request timed out'), { stopUnconfirmed: true }); }));
  assert.equal(await f.stop({ owner: () => ({ pid: controller.pid }) }), false);
  await blocked(f);
});

test('unconfirmed AionCore identity prevents restarting or sending more work', async t => {
  const f = fixture(t);
  assert.equal(await f.stop({ owner: () => ({ ...controller, creationDate: undefined }) }), false);
  assert.equal(f.restarts, 0);
  await blocked(f);
});

test('retry waits for the last observed child without restarting the replacement again', async t => {
  const f = fixture(t);
  f.keepChild = true;
  assert.equal(await f.stop(), false);
  assert.equal(f.restarts, 1);
  await blocked(f);
  f.rows = f.rows.filter(p => p.pid !== child.pid);
  assert.equal(await f.stop(), true);
  assert.equal(f.restarts, 1);
});

test('disabled Claude can reuse a confirmed stop; the next admitted send invalidates it', async t => {
  const f = fixture(t);
  assert.equal(await f.stop(), true);
  const calls = f.calls.length;
  assert.equal(await f.stop({ allowRestart: false, snapshot: assert.fail, anchor: assert.fail }), true);
  assert.deepEqual(f.calls.slice(calls), ['GET '], 'disabled validation reads local runtime state without starting the CLI');
  assert.equal(await f.send(async () => 'next'), 'next');
  assert.equal(await f.stop(), true);
  assert.equal(f.restarts, 2, 'the next stop checked the new turn');
});

test('a cached stop receipt cannot acknowledge a subsequently active turn', async t => {
  const f = fixture(t);
  assert.equal(await f.stop(), true);
  f.runtime = { ...idle, state: 'running', is_processing: true, turn_id: 'turn2' };
  assert.equal(await f.stop({ allowRestart: false }), false);
  assert.equal(f.restarts, 1, 'disabled seat was not relaunched');
  await blocked(f);
});
