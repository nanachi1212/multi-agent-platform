// R11: 10 tool-free turns per agent; final assistant message must be exactly one JSON object (V1 §5.2).
// usage: node r11-json.mjs <serverTag> <agent> [N]
import { client, log, sleep, ROOT } from './lib.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [tag, agent, N = '10'] = process.argv.slice(2);
const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const c = client(base, { evid: 'r11-json.api.log' });
const asst = { claude: 'bare:2d23ff1c', codex: 'bare:8e1acf31', agy: 'bare:a9f3c21e' }[agent];
const perm = { claude: 'plan', codex: 'read-only', agy: 'plan' }[agent];
const model = { claude: 'haiku', codex: 'gpt-6-luna' }[agent];
const ws = join(ROOT, 'p0-sandbox', 'w11', agent); mkdirSync(ws, { recursive: true });
const results = [];
for (let k = 1; k <= Number(N); k++) {
  const conv = (await c.post('/api/conversations', { name: `r11 ${agent} ${k}`, assistant: { id: asst, conversation_overrides: { permission: perm, ...(model ? { model } : {}) } }, extra: { workspace: ws } })).json?.data?.id;
  await c.post(`/api/conversations/${conv}/messages`, { content: `Do not use any tools. Your entire reply must be exactly one JSON object and nothing else (no Markdown fence, no prose before or after):\n{"type":"Result","n":${k},"ok":true}` });
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) { const rt = (await c.get(`/api/conversations/${conv}`)).json?.data?.runtime; if (rt && !rt.is_processing && i > 2) break; await sleep(1000); }
  const m = (await c.get(`/api/conversations/${conv}/messages`)).json?.data;
  const texts = (m?.items ?? m ?? []).filter((x) => x.position === 'left' && x.type === 'text').map((x) => (typeof x.content === 'string' ? x.content : x.content?.content ?? ''));
  const final = (texts.at(-1) ?? '').trim();
  let verdict = 'FAIL', reason = '';
  if (!final) reason = 'no final text';
  else if (final.startsWith('```')) reason = 'fenced';
  else { try { const j = JSON.parse(final); if (j && typeof j === 'object' && !Array.isArray(j) && j.n === k && j.type === 'Result') verdict = 'PASS'; else reason = 'wrong shape'; } catch { reason = 'not a single JSON value'; } }
  results.push({ k, verdict, reason, textRows: texts.length, ms: Date.now() - t0, final: final.slice(0, 120) });
  log('r11-json.log', { agent, ...results.at(-1) });
}
log('r11-json.log', { agent, summary: `${results.filter((r) => r.verdict === 'PASS').length}/${results.length}` });
