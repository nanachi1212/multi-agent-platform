// R4 conversation CRUD + archive presence; R10 command_id reconciliation via list/messages.
import { client, log, ROOT } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.argv[2] ?? 'explore-local';
const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const auth = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.auth.json`), 'utf8')).headers; } catch { return {}; } })();
const c = client(base, { evid: `r4-${tag}.api.log`, headers: auth });
const L = (o) => log(`r4-${tag}.log`, o);
const ws = join(ROOT, 'p0-sandbox', 'repo 測試 A');
const cmd = 'cmd_r4_' + Date.now().toString(36);

const cr = await c.post('/api/conversations', { name: 'p0 r4 crud', assistant: { id: 'bare:2d23ff1c', conversation_overrides: { permission: 'default' } }, extra: { workspace: ws, conductor_command_id: cmd } });
const id = cr.json?.data?.id; L({ op: 'create', status: cr.status, id });
const g = await c.get(`/api/conversations/${id}`); L({ op: 'get', status: g.status, name: g.json?.data?.name, cmd: g.json?.data?.extra?.conductor_command_id });
const list = await c.get('/api/conversations?page=1&pageSize=100');
const items = list.json?.data?.items ?? [];
const found = items.find((x) => x.extra?.conductor_command_id === cmd);
L({ op: 'list', status: list.status, total: list.json?.data?.total, listHasExtra: items.length ? 'extra' in items[0] : null, reconcile_by_extra_found: !!found, found_id: found?.id });
const up = await c.patch(`/api/conversations/${id}`, { name: 'p0 r4 renamed', extra: { p0_patch: 'x' } });
const g2 = await c.get(`/api/conversations/${id}`);
L({ op: 'update', status: up.status, name: g2.json?.data?.name, extra_merge_kept_cmd: g2.json?.data?.extra?.conductor_command_id === cmd, patched: g2.json?.data?.extra?.p0_patch });
// archive: no route in source route table; probe the plausible paths and record 404/405.
for (const [m, p] of [['POST', `/api/conversations/${id}/archive`], ['PATCH', `/api/conversations/${id}`]]) {
  const r = m === 'POST' ? await c.post(p, {}) : await c.patch(p, { archived: true });
  L({ op: 'archive_probe', method: m, path: p, status: r.status, body: r.text.slice(0, 200) });
}
const g3 = await c.get(`/api/conversations/${id}`); L({ op: 'archive_field_after_patch', archived: g3.json?.data?.archived ?? null, keys: Object.keys(g3.json?.data ?? {}) });
const d = await c.del(`/api/conversations/${id}`); L({ op: 'delete', status: d.status });
const g4 = await c.get(`/api/conversations/${id}`); L({ op: 'get_after_delete', status: g4.status });
const d2 = await c.del(`/api/conversations/${id}`); L({ op: 'delete_again', status: d2.status, body: d2.text.slice(0, 200) });

// R10: message-level reconciliation on an existing conversation from claude-1
const summ = JSON.parse(readFileSync(join(ROOT, 'reports', 'evidence', 'claude-1.summary.json'), 'utf8'));
const msgs = await c.get(`/api/conversations/${summ.convId}/messages`);
const its = msgs.json?.data?.items ?? msgs.json?.data ?? [];
const hit = its.find((m) => m.position === 'right' && JSON.stringify(m.content).includes(`conductor-command-id: ${summ.commandId}`));
L({ op: 'r10_message_reconcile', convId: summ.convId, commandId: summ.commandId, found: !!hit, msg_id: hit?.msg_id, verbatim: hit ? (typeof hit.content === 'string' ? hit.content : hit.content.content).startsWith(`conductor-command-id: ${summ.commandId}\n`) : false });
const search = await c.get(`/api/messages/search?keyword=${encodeURIComponent(summ.commandId)}`);
L({ op: 'r10_search', status: search.status, body: search.text.slice(0, 400) });
