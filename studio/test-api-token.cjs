// Security F2/F3: /api needs Studio's pass; a worker's card pass opens only its own card's runtime start. No server is started.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const src = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
const code = src.slice(src.indexOf('const cardToken ='), src.indexOf('\n', src.indexOf('|| (route === \'POST /api/runtime/start\'')));
const API_TOKEN = 'a'.repeat(64);
const { apiAllowed, cardToken } = new Function('crypto', 'API_TOKEN', code + '\nreturn { apiAllowed, cardToken };')(crypto, API_TOKEN);

assert.equal(apiAllowed('GET /api/state', API_TOKEN, {}), true, 'the page pass opens everything');
for (const route of ['GET /api/state', 'POST /api/routine/save', 'POST /api/answer', 'POST /api/resume', 'POST /api/runtime/start', 'POST /api/workspace/release-claim'])
  for (const pass of [undefined, '', 'b'.repeat(64), API_TOKEN.slice(1)]) assert.equal(apiAllowed(route, pass, { cardId: 'c1' }), false, route + ' without the pass');
assert.equal(apiAllowed('GET /api/state', 'é'.repeat(64)), false, 'a non-ASCII pass is refused, not an error');
assert.ok(!/api-token/.test(src) && /const API_TOKEN = crypto\.randomBytes\(32\)/.test(src), 'the pass is never written to the shared runtime folder');
assert.equal(apiAllowed('POST /api/workspace/claim', undefined, {}), true, 'an outside claim (stop writing) stays open');
const card = cardToken('c1');
assert.notEqual(card, API_TOKEN);
assert.equal(apiAllowed('POST /api/runtime/start', card, { cardId: 'c1' }), true, 'a worker starts its own runtime');
assert.equal(apiAllowed('POST /api/runtime/start', card, { cardId: 'c2' }), false, 'not another card\'s');
for (const route of ['POST /api/routine/save', 'POST /api/answer', 'POST /api/resume', 'GET /api/state']) assert.equal(apiAllowed(route, card, { cardId: 'c1' }), false, 'a card pass never opens ' + route);
assert.ok(/http:\/\/127\.0\.0\.1:\$\{PORT\}\/#t=\$\{API_TOKEN\}/.test(src), 'Studio opens the page with the pass in the fragment');
assert.ok(src.includes('x-studio-token: ${cardToken(t.id)}'), 'workers are told their card pass');

// AionCore runs with its login on: no --local, a fresh password each start, and every call / the WebSocket carry the session
const aionStart = src.slice(src.indexOf('async function startAion'), src.indexOf('async function api('));
assert.ok(!aionStart.includes("'--local'"), 'AionCore is not started in --local (no login) mode');
assert.ok(/'user', 'set-password', '--password-stdin'/.test(aionStart) && /aionAuth = await aionLogin\(pass\)/.test(aionStart), 'Studio sets a new password and logs in');
assert.ok(/headers: \{ 'content-type': 'application\/json', \.\.\.aionAuth \}/.test(src), 'every AionCore call carries the login and CSRF headers');
assert.ok(src.includes("'/ws', { headers: { authorization: aionAuth.authorization } })"), 'the catalog WebSocket logs in too');

// the page keeps the pass from #t= and sends it with /api calls only
const html = process.env.API_TOKEN_HTML ?? fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// CI checks out CRLF; look for the block by its own text, not by a line break
const start = html.indexOf('const m = location.hash.match(/^#t=');
const block = '{' + html.slice(start, html.indexOf('const $ = (id)'));
assert.ok(start > 0, 'found the page pass block');
assert.ok(block.includes('x-studio-token'), 'found the page pass block');
const store = new Map(), calls = [];
const win = { fetch: (u, o) => { calls.push([u, o]); return Promise.resolve(); } };
let replaced = null;
new Function('location', 'localStorage', 'history', 'window', block)(
  { hash: '#t=' + API_TOKEN, pathname: '/' }, { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null },
  { replaceState: (a, b, u) => { replaced = u; } }, win);
assert.equal(store.get('studioToken'), API_TOKEN); assert.equal(replaced, '/', 'the pass is removed from the address bar');
win.fetch('/api/state'); win.fetch('/other', { headers: { a: '1' } }); win.fetch('/api/x', { method: 'POST', headers: { 'content-type': 'application/json' } });
assert.equal(calls[0][1].headers['x-studio-token'], API_TOKEN);
assert.deepEqual(calls[1][1], { headers: { a: '1' } }, 'no pass for non-API URLs');
assert.deepEqual(calls[2][1].headers, { 'content-type': 'application/json', 'x-studio-token': API_TOKEN });
const later = { fetch: (u, o) => { calls.push([u, o]); } };
new Function('location', 'localStorage', 'history', 'window', block)({ hash: '#p=x', pathname: '/' }, { getItem: (k) => store.get(k) ?? null }, { replaceState() { throw new Error('no'); } }, later);
later.fetch('/api/state'); assert.equal(calls.at(-1)[1].headers['x-studio-token'], API_TOKEN, 'a later visit uses the kept pass');
console.log('API pass: page pass, outside claim, card-scoped runtime start, browser keeps and sends the pass: PASS');
