// R6: WS disconnect/reconnect mid-stream; gap recovery via REST; duplicate/out-of-order analysis.
import { client, log, sleep, ROOT, writeJson } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.argv[2] ?? 'p0b-local';
const L = (o) => log('r6.log', o);
const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const c = client(base, { evid: 'r6.api.log' });
const events = [];
let conv = null, phase = 'ws1';
function connect(label) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.name === 'ping') { ws.send(JSON.stringify({ name: 'pong', data: {} })); return; }
    if (conv && j.data?.conversation_id === conv) events.push({ t: Date.now(), conn: label, name: j.name, type: j.data?.type, msg_id: j.data?.msg_id, content: j.data?.data?.content });
  });
  return new Promise((r) => ws.addEventListener('open', () => r(ws)));
}
let ws = await connect('ws1');
conv = (await c.post('/api/conversations', { name: 'r6', assistant: { id: 'bare:2d23ff1c', conversation_overrides: { permission: 'plan', model: 'haiku' } }, extra: { workspace: join(ROOT, 'p0-sandbox', 'repo 測試 A') } })).json?.data?.id;
await c.post(`/api/conversations/${conv}/messages`, { content: 'Do not use any tools. Output the integers from 1 to 400, one per line, and nothing else.' });
// disconnect after the first streamed content chunks
for (let i = 0; i < 600 && events.filter((e) => e.type === 'content' || e.type === 'text').length < 5; i++) await sleep(100);
const cutAt = Date.now(); ws.close(); L({ step: 'disconnected', afterEvents: events.length });
await sleep(5000);
ws = await connect('ws2'); const reAt = Date.now(); L({ step: 'reconnected', gapMs: reAt - cutAt });
for (let i = 0; i < 240; i++) { const rt = (await c.get(`/api/conversations/${conv}`)).json?.data?.runtime; if (rt && !rt.is_processing && i > 3) break; await sleep(1000); }
await sleep(1500); ws.close();
const msgs = (await c.get(`/api/conversations/${conv}/messages`)).json?.data;
const items = msgs?.items ?? msgs ?? [];
const finalText = items.filter((m) => m.position === 'left' && m.type === 'text').map((m) => (typeof m.content === 'string' ? m.content : m.content?.content ?? '')).join('');
const nums = finalText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const wsText = events.filter((e) => e.content).map((e) => e.content).join('');
const names = events.map((e) => e.name);
const dupKeys = new Map(); for (const e of events) { const k = JSON.stringify([e.name, e.type, e.msg_id, e.content]); dupKeys.set(k, (dupKeys.get(k) ?? 0) + 1); }
const exactDuplicates = [...dupKeys.values()].filter((n) => n > 1).length;
const completedIdx = names.lastIndexOf('turn.completed'), lastStreamIdx = names.lastIndexOf('message.stream');
L({ step: 'result', conv, wsEventsWs1: events.filter((e) => e.conn === 'ws1').length, wsEventsWs2: events.filter((e) => e.conn === 'ws2').length,
  eventsDuringGap: 0, restFinalLines: nums.length, restComplete: nums.length === 400 && nums[0] === '1' && nums.at(-1) === '400',
  wsTextLen: wsText.length, restTextLen: finalText.length, wsMissingChars: finalText.length - wsText.length,
  replayAfterReconnect: events.some((e) => e.conn === 'ws2' && e.t < reAt), exactDuplicateEventKeys: exactDuplicates,
  turnCompletedSeenOnWs2: names.includes('turn.completed'), streamAfterCompleted: lastStreamIdx > completedIdx && completedIdx >= 0 });
writeJson('r6.events.json', events);
