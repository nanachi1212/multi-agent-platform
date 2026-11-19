import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The release used by Studio and the real-backend contract gate must be identical.
export const AION_RELEASE = Object.freeze({
  version: '0.2.2',
  archive: 'aioncore-v0.2.2-x86_64-pc-windows-msvc.zip',
  url: 'https://github.com/iOfficeAI/AionCore/releases/download/v0.2.2/aioncore-v0.2.2-x86_64-pc-windows-msvc.zip',
  archiveHash: 'd1ed8d1da869230c18701747d07e8f068db5b8c9442e65261304aeb4c27eacf6',
  executableHash: '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892',
});

// The pinned aionrs backend persists cumulative usage here before it reports idle.
// Its conversation /usage endpoint is for ACP and has no aionrs usage frames.
export async function readAionrsUsage(dataDir, cid) {
  if (typeof cid !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(cid)) throw new Error('外部模型對話 ID 無效');
  const file = path.join(dataDir, 'aionrs-sessions', 'sessions', cid, 'state.json');
  let data;
  try { data = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('無法讀取外部模型的對話用量'); }
  let state;
  try { state = JSON.parse(data); } catch { /* Parser errors may contain message text. */ }
  const u = state?.total_usage;
  if (state?.id !== cid || !u || ![u.input_tokens, u.output_tokens, u.cache_read_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('外部模型的對話用量格式異常');
  }
  return { total: { in: u.input_tokens, out: u.output_tokens, cache: u.cache_read_tokens } };
}

// Runtime ownership, retries, cancellation and lifecycle decisions remain with the caller.
// Importing this module starts nothing.
export function createAionClient({ baseUrl, unavailable = () => '', timeoutMs = 30e3, fetchImpl = globalThis.fetch }) {
  let auth = {};
  async function login(password) {
    const r = await fetchImpl(baseUrl() + '/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    const csrf = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('aionui-csrf-token='))?.slice('aionui-csrf-token='.length);
    if (!r.ok || !j.token || !csrf) throw new Error('AionCore 登入失敗：' + r.status);
    auth = { authorization: 'Bearer ' + j.token, cookie: 'aionui-csrf-token=' + csrf, 'x-csrf-token': csrf };
  }
  async function api(method, p, body) {
    const gone = unavailable();
    if (gone) throw new Error(gone);
    const signal = AbortSignal.timeout(timeoutMs);
    // A timed-out request may still run in AionCore. Never let its caller release a write lease as if Stop succeeded.
    const timedOut = () => Object.assign(new Error(`AionCore ${method} ${p} 逾時：${timeoutMs / 1000} 秒沒有回應`), { stopUnconfirmed: true });
    const r = await fetchImpl(baseUrl() + p, { method, headers: { 'content-type': 'application/json', ...auth }, body: body && JSON.stringify(body), signal })
      .catch((e) => { throw signal.aborted ? timedOut() : e; });
    const j = await r.json().catch(() => { if (signal.aborted) throw timedOut(); return {}; });
    if (!r.ok || j.success === false) throw new Error(`AionCore ${method} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j.data;
  }
  return { login, api, authHeaders: () => ({ ...auth }) };
}
