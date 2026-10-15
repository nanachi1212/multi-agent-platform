// R8 approval semantics on the spike's own conversations (Conductor as the client).
// usage: node r8-approvals.mjs <serverTag> <mode: dup|restart|crash-pre|crash-post> [convId]
//  dup       : after the operator's decision file appears, send allow+reject concurrently with a parallel GET list,
//              then a third duplicate confirm. Record statuses and the actual outcome (file changed or not).
//  restart   : leave the approval pending, call runtime/restart, then inspect list/runtime and retry the old call_id.
//  crash-pre : leave the approval pending and write state for crash-post (operator then kills aioncore).
//  crash-post: after aioncore restart on the same data dir: inspect list/runtime/messages, retry old call_id,
//              then send a follow-up to test session resume.
import { client, log, sleep, ROOT, writeJson } from './lib.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [tag, mode, convArg] = process.argv.slice(2);
const run = `r8-${mode}`;
const L = (o) => log(`${run}.log`, o);
const { base } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const c = client(base, { evid: `${run}.api.log` });
const REPO = join(ROOT, 'p0-sandbox', 'repo 測試 A');
const PEND = join(ROOT, 'runtime', 'approvals', 'pending'), DEC = join(ROOT, 'runtime', 'approvals', 'decide');
mkdirSync(PEND, { recursive: true }); mkdirSync(DEC, { recursive: true });
const stateFile = join(ROOT, 'runtime', 'r8-crash.state.json');
const diffOf = (wt) => execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

async function newPending(name) {
  const wt = join(ROOT, 'p0-sandbox', 'wt', `${run}`);
  if (!existsSync(wt)) execFileSync('git', ['-C', REPO, 'worktree', 'add', '-q', '-b', `p0/${run}`, wt, 'HEAD']);
  const conv = (await c.post('/api/conversations', { name, assistant: { id: 'bare:2d23ff1c', conversation_overrides: { permission: 'default', model: 'haiku' } }, extra: { workspace: wt } })).json?.data?.id;
  const send = await c.post(`/api/conversations/${conv}/messages`, { content: readFileSync(join(ROOT, 'fixtures', 'prompt-oneturn.txt'), 'utf8') });
  const turnId = send.json?.data?.turn_id;
  for (let i = 0; i < 240; i++) {
    const r = await c.get(`/api/conversations/${conv}/confirmations`);
    const cf = (r.json?.data ?? [])[0];
    if (cf) {
      const key = `${run}__${conv}__${cf.call_id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      writeFileSync(join(PEND, key + '.json'), JSON.stringify({ base, convId: conv, ...cf }, null, 2));
      L({ step: 'pending', conv, turnId, key, title: cf.title });
      return { conv, turnId, wt, cf, key };
    }
    await sleep(500);
  }
  throw new Error('no pending approval');
}

if (mode === 'dup') {
  const p = await newPending('r8 dup');
  const df = join(DEC, p.key + '.json');
  while (!existsSync(df)) await sleep(500);
  L({ step: 'operator_decision', decision: JSON.parse(readFileSync(df, 'utf8')) });
  const url = `/api/conversations/${p.conv}/confirmations/${encodeURIComponent(p.cf.call_id)}/confirm`;
  const [a, b, l] = await Promise.all([
    c.post(url, { msg_id: p.cf.id, data: 'allow' }),
    c.post(url, { msg_id: p.cf.id, data: 'reject' }),
    c.get(`/api/conversations/${p.conv}/confirmations`),
  ]);
  L({ step: 'concurrent', allow: [a.status, a.text.slice(0, 160)], reject: [b.status, b.text.slice(0, 160)], parallelListLen: (l.json?.data ?? []).length });
  const d = await c.post(url, { msg_id: p.cf.id, data: 'allow' });
  L({ step: 'duplicate_after', status: d.status, body: d.text.slice(0, 200) });
  await sleep(1000);
  const after = await c.get(`/api/conversations/${p.conv}/confirmations`);
  L({ step: 'list_after', len: (after.json?.data ?? []).length });
  for (let i = 0; i < 120; i++) { const rt = (await c.get(`/api/conversations/${p.conv}`)).json?.data?.runtime; if (rt && !rt.is_processing) break; await sleep(1000); }
  L({ step: 'outcome', git_status: diffOf(p.wt) });
}

if (mode === 'restart') {
  const p = await newPending('r8 restart');
  const r = await c.post(`/api/conversations/${p.conv}/runtime/restart`, {});
  L({ step: 'restart', status: r.status });
  await sleep(3000);
  const list = await c.get(`/api/conversations/${p.conv}/confirmations`);
  const rt = (await c.get(`/api/conversations/${p.conv}`)).json?.data?.runtime;
  L({ step: 'after_restart', listLen: (list.json?.data ?? []).length, runtime: rt });
  const old = await c.post(`/api/conversations/${p.conv}/confirmations/${encodeURIComponent(p.cf.call_id)}/confirm`, { msg_id: p.cf.id, data: 'reject' });
  L({ step: 'confirm_old_call_after_restart', status: old.status, body: old.text.slice(0, 200), git_status: diffOf(p.wt) });
}

if (mode === 'crash-pre') {
  const p = await newPending('r8 crash');
  writeJson('r8-crash.pre.json', p);
  writeFileSync(stateFile, JSON.stringify(p));
  L({ step: 'ready_for_kill', conv: p.conv });
}

if (mode === 'crash-post') {
  const p = JSON.parse(readFileSync(stateFile, 'utf8'));
  const list = await c.get(`/api/conversations/${p.conv}/confirmations`);
  const conv = (await c.get(`/api/conversations/${p.conv}`)).json?.data;
  L({ step: 'post_crash_state', listLen: (list.json?.data ?? []).length, status: conv?.status, runtime: conv?.runtime, git_status: diffOf(p.wt) });
  const old = await c.post(`/api/conversations/${p.conv}/confirmations/${encodeURIComponent(p.cf.call_id)}/confirm`, { msg_id: p.cf.id, data: 'reject' });
  L({ step: 'confirm_old_call_after_crash', status: old.status, body: old.text.slice(0, 200) });
  const msgs = (await c.get(`/api/conversations/${p.conv}/messages`)).json?.data;
  const items = msgs?.items ?? msgs ?? [];
  L({ step: 'messages_after_crash', count: items.length, last: items.slice(-3).map((m) => ({ type: m.type, status: m.status })) });
  // Session resume: ask a question only answerable from the previous turn's context. No tools needed.
  const s = await c.post(`/api/conversations/${p.conv}/messages`, { content: 'Do not use any tools. In one line, which file path did my previous message ask you to edit? Reply with only the path.' });
  L({ step: 'followup_send', status: s.status });
  for (let i = 0; i < 180; i++) {
    const cf = (await c.get(`/api/conversations/${p.conv}/confirmations`)).json?.data ?? [];
    if (cf.length) { L({ step: 'unexpected_pending_on_followup', title: cf[0].title }); break; }
    const rt = (await c.get(`/api/conversations/${p.conv}`)).json?.data?.runtime;
    if (i > 5 && rt && !rt.is_processing) break;
    await sleep(1000);
  }
  const m2 = (await c.get(`/api/conversations/${p.conv}/messages`)).json?.data;
  const t = (m2?.items ?? m2 ?? []).filter((m) => m.position === 'left' && m.type === 'text').at(-1);
  L({ step: 'followup_answer', text: (typeof t?.content === 'string' ? t.content : t?.content?.content ?? '').slice(0, 300) });
}
