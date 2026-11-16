// Real browser action helper; network and timers are controlled, no server/provider.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('async function post('), html.indexOf('const name = (id)'));
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  let request, calls = 0, project = 'A'; const timers = [], error = {};
  const fetch = (url, { body, signal }) => { calls++; return new Promise((resolve, reject) => {
    request = { resolve, reject, url, body, signal };
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }); };
  const run = new Function('ws', '$', 'fetch', 'refresh', 'AbortController', 'setTimeout', 'clearTimeout',
    code + '\nreturn projectStateAction;')(() => project, () => error, fetch, () => {}, AbortController,
    fn => { timers.push(fn); return fn; }, () => {});
  const button = () => ({ textContent: '▶ 接著處理', disabled: false, hasAttribute: x => x === 'data-continue-state' });
  const b = button(), sameProjectRedraw = button();
  const first = run(b); await run(sameProjectRedraw);
  assert.equal(calls, 1, 'rerendered button cannot bypass pending request deduplication');
  assert.equal(b.disabled, true); assert.equal(b.textContent, '核對狀態中…');
  request.resolve({ ok: false, status: 409, json: async () => ({ error: 'Codex 工具程序尚未確認停止；保留租約' }) }); await first;
  assert.equal(b.disabled, false); assert.equal(b.textContent, '▶ 接著處理');
  assert.match(error.textContent, /保留租約/);
  const retry = run(b); request.reject(new Error('network failure')); await retry;
  assert.equal(b.disabled, false); assert.match(error.textContent, /network failure/);
  const timeout = run(b); timers.at(-1)(); await timeout;
  assert.equal(b.disabled, false); assert.match(error.textContent, /未強制解除寫入權/);
  const bodyWait = run(b), signal = request.signal;
  request.resolve({ ok: true, json: () => new Promise((resolve, reject) =>
    signal.addEventListener('abort', () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })))) });
  await tick(); timers.at(-1)(); await bodyWait;
  assert.equal(b.disabled, false); assert.match(error.textContent, /等待回覆逾時/);
  const success = run(b); request.resolve({ ok: true, json: async () => ({}) }); await success;
  assert.equal(b.disabled, false); assert.equal(b.textContent, '▶ 接著處理');
  const switching = run(b); project = 'B'; error.textContent = 'B message';
  request.resolve({ ok: false, status: 409, json: async () => ({ error: 'late A failure' }) }); await switching;
  assert.equal(error.textContent, 'B message', 'late failure cannot replace another workspace error');
  assert.match(html, /return projectStateAction\(b\)/);
  await tick(); console.log('Project state action failures, timeout, deduplication and recovery PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
