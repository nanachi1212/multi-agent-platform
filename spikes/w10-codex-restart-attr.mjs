// W10 attribution: does a Codex conversation + runtime/restart rewrite ~/.codex/config.toml?
// Compares key names + per-line hashes only (no values printed).
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { client, ROOT, sleep } from './lib.mjs';

const CFG = join(homedir(), '.codex', 'config.toml');
const keys = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => (l.startsWith('[') ? l : `${l.split('=')[0].trim()} = <h:${createHash('sha256').update(l).digest('hex').slice(0, 8)}>`));
const before = keys(readFileSync(CFG, 'utf8')); const m0 = statSync(CFG).mtimeMs;
const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', 'p0c-local.endpoint'), 'utf8'));
const c = client(base, { evid: 'w10-attr.api.log' });
const id = (await c.post('/api/conversations', { name: 'w10 restart attr', assistant: { id: 'bare:8e1acf31', conversation_overrides: { permission: 'read-only', model: 'gpt-6-luna' } }, extra: { workspace: join(ROOT, 'p0-sandbox', 'w11', 'codex') } })).json.data.id;
await c.post(`/api/conversations/${id}/messages`, { content: 'Do not use tools. Reply with only OK.' });
for (let i = 0; i < 90; i++) { const rt = (await c.get(`/api/conversations/${id}`)).json?.data?.runtime; if (i > 3 && rt && !rt.is_processing) break; await sleep(1000); }
const m1 = statSync(CFG).mtimeMs;
const r = await c.post(`/api/conversations/${id}/runtime/restart`, {});
await sleep(10000);
const m2 = statSync(CFG).mtimeMs; const after = keys(readFileSync(CFG, 'utf8'));
const sa = new Set(before), sb = new Set(after);
const res = { test: 'codex conversation turn + runtime/restart', restartStatus: r.status, changedDuringTurn: m1 !== m0, changedDuringRestart: m2 !== m1,
  identical: before.join('\n') === after.join('\n'), removed: before.filter((x) => !sb.has(x)), added: after.filter((x) => !sa.has(x)) };
console.log(JSON.stringify(res));
appendFileSync(join(ROOT, 'reports', 'evidence', 'w10-attribution.log'), JSON.stringify(res) + '\n');
