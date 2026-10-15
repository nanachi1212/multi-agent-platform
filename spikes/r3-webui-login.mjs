// R3 webui: (1) `setup <tag>` sets a random admin password in the data dir (before server start);
// (2) `login <tag>` logs in to the running webui server, obtains JWT + CSRF cookie, writes runtime/<tag>.auth.json.
// The password/token are disposable local values; they are never printed.
import { BIN, ROOT, log, mask } from './lib.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, tag] = process.argv.slice(2);
const dataDir = join(ROOT, 'runtime', 'data', tag);
const secretFile = join(ROOT, 'runtime', `${tag}.secret.json`);
const L = (o) => log(`r3-${tag}.log`, o);

if (cmd === 'setup') {
  mkdirSync(dataDir, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  const r = spawnSync(BIN, ['--data-dir', dataDir, 'user', 'set-password', '--password-stdin'], { input: password + '\n', encoding: 'utf8', windowsHide: true });
  writeFileSync(secretFile, JSON.stringify({ username: 'admin', password }));
  L({ step: 'set-password', status: r.status, stdout: mask(r.stdout).slice(0, 300), stderr: mask(r.stderr).slice(0, 300) });
} else if (cmd === 'login') {
  const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
  const { username, password } = JSON.parse(readFileSync(secretFile, 'utf8'));
  // Unauthenticated probes first.
  for (const p of ['/api/conversations', '/api/assistants']) {
    const r = await fetch(base + p); L({ step: 'unauth_get', path: p, status: r.status });
  }
  const un = await fetch(base + '/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  L({ step: 'unauth_post', status: un.status });
  const cors = await fetch(base + '/api/conversations', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  L({ step: 'cors_preflight_evil_origin', status: cors.status, acao: cors.headers.get('access-control-allow-origin') });
  const lr = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const lt = await lr.text(); let lj; try { lj = JSON.parse(lt); } catch {}
  const setCookie = lr.headers.getSetCookie?.() ?? [];
  L({ step: 'login', status: lr.status, keys: lj ? Object.keys(lj.data ?? lj) : null, cookies: setCookie.map((c) => c.split('=')[0]) });
  const token = lj?.data?.token ?? lj?.data?.access_token ?? lj?.token ?? lj?.access_token;
  // CSRF cookie comes from any response once a client lacks one.
  const h = await fetch(base + '/api/conversations', { headers: { authorization: `Bearer ${token}` } });
  const all = [...setCookie, ...(h.headers.getSetCookie?.() ?? [])];
  const csrf = all.map((c) => c.split(';')[0]).find((c) => c.startsWith('aionui-csrf-token='))?.split('=')[1];
  L({ step: 'authed_get', status: h.status, tokenPresent: !!token, csrfPresent: !!csrf });
  const headers = { authorization: `Bearer ${token}`, cookie: `aionui-csrf-token=${csrf}`, 'x-csrf-token': csrf };
  writeFileSync(join(ROOT, 'runtime', `${tag}.auth.json`), JSON.stringify({ headers }));
  const nocsrf = await fetch(base + '/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'csrf probe', extra: {} }) });
  L({ step: 'authed_post_without_csrf', status: nocsrf.status, body: (await nocsrf.text()).slice(0, 200) });
}
