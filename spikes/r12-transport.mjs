// R12 / W3: prompt transport fidelity per agent and size.
// Verifies what the CLI actually received: Claude transcript, Codex rollout, agy argv (CIM CommandLine).
// usage: node r12-transport.mjs <serverTag> <agent:claude|codex|agy> <size:small|9k|40k>
import { client, log, sleep, ROOT, sha256 } from './lib.mjs';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [tag, agent, size] = process.argv.slice(2);
const L = (o) => log('r12.log', o);
const { base, pid: aionPid } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const c = client(base, { evid: 'r12.api.log' });
const ws = join(ROOT, 'p0-sandbox', 'w3', agent); mkdirSync(ws, { recursive: true });
const mark = `P0MARK-${agent}-${size}-${Date.now().toString(36)}`;
const special = '中文測試 「全形引號」 "double" \'single\' `back` $dollar %PATH% ^caret &amp |pipe <lt> >gt\ttab  two-spaces \\backslash\\ end';
let payload = `${mark}\n${special}\nline3 with trailing spaces   \n`;
const target = { small: 0, '9k': 9000, '40k': 40000 }[size];
for (let i = 0; payload.length < target; i++) payload += `${i} ${special}\n`;
payload += `END-${mark}`;
const prompt = `Do not use any tools. Reply with only the word OK.\n<<<PAYLOAD\n${payload}\nPAYLOAD>>>`;
const asst = { claude: 'bare:2d23ff1c', codex: 'bare:8e1acf31', agy: 'bare:a9f3c21e' }[agent];
const perm = { claude: 'plan', codex: 'read-only', agy: 'plan' }[agent];
const model = { claude: 'haiku', codex: 'gpt-6-luna', agy: undefined }[agent];
const conv = (await c.post('/api/conversations', { name: `r12 ${agent} ${size}`, assistant: { id: asst, conversation_overrides: { permission: perm, ...(model ? { model } : {}) } }, extra: { workspace: ws } })).json?.data?.id;
const t0 = Date.now();
const send = await c.post(`/api/conversations/${conv}/messages`, { content: prompt });
// sample agy argv while the turn runs
let argvHit = null;
for (let i = 0; i < 300 && Date.now() - t0 < 240000; i++) {
  if (agent === 'agy' && !argvHit) {
    try {
      const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter "Name='agy.exe'" | ? { $_.CommandLine -match '${mark}' } | % { $_.CommandLine }`], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
      if (out.trim()) argvHit = out.replace(/\r?\n$/, '');
    } catch {}
  }
  const rt = (await c.get(`/api/conversations/${conv}`)).json?.data?.runtime;
  if (rt && !rt.is_processing && i > 2) break;
  await sleep(1000);
}
const msgs = (await c.get(`/api/conversations/${conv}/messages`)).json?.data;
const items = msgs?.items ?? msgs ?? [];
const reply = items.filter((m) => m.position === 'left' && (m.type === 'text' || m.type === 'tips')).map((m) => (typeof m.content === 'string' ? m.content : m.content?.content ?? '')).join(' | ').slice(0, 300);
const userRow = items.find((m) => m.position === 'right');
const storedUser = typeof userRow?.content === 'string' ? userRow.content : userRow?.content?.content ?? '';

let received = null, source = null;
const findText = (s) => { const i = s.indexOf(mark); const j = s.indexOf(`END-${mark}`); return i >= 0 && j >= 0 ? s.slice(i, j + `END-${mark}`.length) : null; };
if (agent === 'claude') {
  const dir = join(homedir(), '.claude', 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs).slice(0, 5)) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.includes(mark)) continue;
      try { const j = JSON.parse(line); const content = j.message?.content; const s = typeof content === 'string' ? content : (content ?? []).map((x) => x.text ?? '').join('');
        const t = findText(s); if (t) { received = t; source = `claude transcript ${f}`; break; } } catch {}
    }
    if (received) break;
  }
}
if (agent === 'codex') {
  const day = new Date(); const dir = join(homedir(), '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  if (existsSync(dir)) for (const f of readdirSync(dir).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs).slice(0, 10)) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.includes(mark)) continue;
      try { const j = JSON.parse(line); const s = JSON.stringify(j.payload ?? j); const obj = j.payload;
        const txt = obj?.type === 'user_message' ? obj.message : (obj?.content ?? []).map?.((x) => x.text ?? '').join('') ?? '';
        const t = findText(txt || ''); if (t) { received = t; source = `codex rollout ${f}`; break; } } catch {}
    }
    if (received) break;
  }
}

// CommandLineToArgvW decoding (MSVC rules) so agy's raw CommandLine can be compared byte-for-byte.
function argvW(cmd) {
  const out = []; let i = 0; const n = cmd.length;
  while (i < n) {
    const BS = String.fromCharCode(92), TAB = String.fromCharCode(9);
    while (i < n && (cmd[i] === ' ' || cmd[i] === TAB)) i++;
    if (i >= n) break;
    let arg = '', inQ = false;
    while (i < n) {
      const ch = cmd[i];
      if (ch === BS) { let k = 0; while (cmd[i] === BS) { k++; i++; }
        if (cmd[i] === '"') { arg += BS.repeat(k >> 1); if (k % 2) { arg += '"'; i++; } }
        else arg += BS.repeat(k);
        continue; }
      if (ch === '"') { if (inQ && cmd[i + 1] === '"') { arg += '"'; i += 2; continue; } inQ = !inQ; i++; continue; }
      if (!inQ && (ch === ' ' || ch === TAB)) break;
      arg += ch; i++;
    }
    out.push(arg);
  }
  return out;
}

if (agent === 'agy' && argvHit) {
  // CommandLine is the raw Windows command line; CommandLineToArgvW-style quoting means the prompt appears escaped.
  const arg = argvW(argvHit).find((a) => a.includes(mark)) ?? '';
  received = findText(arg); source = 'agy argv decoded via CommandLineToArgvW rules';
}
const exact = received === payload;
if (received != null && !exact) { const { writeFileSync } = await import('node:fs'); writeFileSync(join(ROOT, 'reports', 'evidence', `r12-${agent}-${size}.sent.txt`), payload); writeFileSync(join(ROOT, 'reports', 'evidence', `r12-${agent}-${size}.received.txt`), received); }
L({ agent, size, mark, sentChars: payload.length, sentSha: sha256(payload).slice(0, 16), sendStatus: send.status,
  aionStoredExact: findText(storedUser) === payload, received: received != null, source, receivedChars: received?.length ?? null,
  receivedSha: received ? sha256(received).slice(0, 16) : null, exact, ms: Date.now() - t0, reply });
