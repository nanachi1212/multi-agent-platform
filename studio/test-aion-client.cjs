const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Aion client');

(async () => {
  const { createAionClient } = await import('./aion-client.mjs');
  const response = (data, status = 200, cookies = []) => ({ ok: status < 400, status,
    headers: { getSetCookie: () => cookies }, json: async () => data });
  let gone = '', endpoint = 'http://fixture', reply, calls = [];
  const client = createAionClient({ baseUrl: () => endpoint, unavailable: () => gone,
    fetchImpl: async (...args) => { calls.push(args); return reply; } });
  reply = response({ token: 'token' }, 200, ['other=x; HttpOnly', 'aionui-csrf-token=csrf; Path=/']);
  await client.login('test-password');
  assert.equal(calls[0][0], 'http://fixture/login');
  assert.deepEqual(JSON.parse(calls[0][1].body), { username: 'admin', password: 'test-password' });
  reply = response({ success: true, data: { id: 'conversation' } });
  endpoint = 'http://ready';
  assert.deepEqual(await client.api('POST', '/api/conversations', { type: 'acp' }), { id: 'conversation' });
  assert.equal(calls[1][0], 'http://ready/api/conversations');
  assert.deepEqual(calls[1][1].headers, { 'content-type': 'application/json', authorization: 'Bearer token',
    cookie: 'aionui-csrf-token=csrf', 'x-csrf-token': 'csrf' });
  const headers = client.authHeaders(); headers.authorization = 'overwritten';
  assert.equal(client.authHeaders().authorization, 'Bearer token', 'callers cannot mutate client auth');
  for (const [status, body] of [[404, { error: 'missing' }], [200, { success: false, message: 'refused' }]]) {
    reply = response(body, status); await assert.rejects(client.api('GET', '/bad'), /AionCore GET \/bad/);
  }
  for (const [status, body, cookies] of [[401, {}, []], [200, { token: 't' }, []], [200, {}, ['aionui-csrf-token=c']]]) {
    const bad = createAionClient({ baseUrl: () => 'http://fixture', fetchImpl: async () => response(body, status, cookies) });
    await assert.rejects(bad.login('x'), /登入失敗/); assert.deepEqual(bad.authHeaders(), {});
  }
  const priorCalls = calls.length; gone = 'backend exited';
  await assert.rejects(client.api('POST', '/cancel', {}), /backend exited/);
  assert.equal(calls.length, priorCalls, 'no requests after the owner reports backend exit');
  const networkError = new Error('connection lost');
  const disconnected = createAionClient({ baseUrl: () => '', fetchImpl: async () => { throw networkError; } });
  await assert.rejects(disconnected.api('POST', '/cancel'), e => e === networkError);
  // Cover both fetch and body-read timeouts: either must retain the stop-unconfirmed fence.
  for (const phase of ['headers', 'body']) {
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const slow = createAionClient({ baseUrl: () => '', timeoutMs: 20, fetchImpl: async (_url, { signal }) => {
        const untilAbort = () => new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return phase === 'headers' ? untilAbort() : { ...response({}), json: untilAbort };
      } });
      await assert.rejects(slow.api('POST', '/cancel', {}), e => e.stopUnconfirmed === true && /逾時/.test(e.message));
    } finally { clearInterval(keepAlive); }
  }
  finished();
  console.log('Aion client: auth/CSRF, response envelope, backend exit and both timeout phases: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
