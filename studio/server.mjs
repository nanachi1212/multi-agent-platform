// Multi-Agent Studio MVP: local web UI + AionCore as the agent runtime.
// Run: node studio/server.mjs   (or start-studio.cmd)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RT = path.join(ROOT, 'runtime');
const AION = path.join(RT, 'aioncore', 'aioncore.exe');
const AION_URL = 'https://github.com/iOfficeAI/AionCore/releases/download/v0.2.2/aioncore-v0.2.2-x86_64-pc-windows-msvc.zip';
const AION_ZIP_SHA256 = 'd1ed8d1da869230c18701747d07e8f068db5b8c9442e65261304aeb4c27eacf6';
let PORT = Number(process.env.STUDIO_PORT || 4848); // moves up when the port is taken (see server.listen)
// Studio's Codex gets its own home so its sessions never show up in the user's own Codex history.
const CODEX_HOME = path.join(RT, 'studio', 'codex-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Agents are just a catalog; any of them can be Leader or Worker.
// Leader sessions use non-writing modes, Worker sessions may edit the project.
const AGENTS = {
  claude: { name: 'Claude Code', create: (ws, lead) => ({ type: 'acp', extra: { backend: 'claude', workspace: ws, session_mode: lead ? 'dontAsk' : 'bypassPermissions' } }) },
  codex: { name: 'Codex', create: (ws, lead) => ({ type: 'acp', extra: { backend: 'codex', workspace: ws, session_mode: lead ? 'read-only' : 'auto' } }) },
  antigravity: { name: 'Antigravity', create: (ws, lead) => ({ type: 'antigravity', extra: { backend: 'antigravity', workspace: ws, session_mode: lead ? 'plan' : 'yolo' } }) },
};

// What a project does when a job is done: stop (default) | suggest next steps | auto-continue (user opts in).
const AFTER_DONE = ['stop', 'suggest', 'auto'];
const AUTO_MAX = 5; // auto-started jobs in a row before Studio stops and waits for the user
// S.leader is the default Leader for newly opened projects.
const S = { leader: 'codex', recent: [], historyRev: 0, agentCfg: {}, agents: {}, workspaces: [],
  limits: {}, notify: true, notices: [], noticeSeq: 0 };
// One workspace per project folder: its own Leader, board, team chat and run, so projects work side by side.
// name = optional display name (tabs, cards, notifications); the folder name is used when empty.
// agentCfg = this project's model / effort per agent; workers = agents allowed to work here.
// New projects start from S.agentCfg (the last choices).
const newWs = (project, leader = S.leader, name = '', agentCfg = S.agentCfg, workers = Object.keys(AGENTS)) => ({
  project, leader, name, run: null, tasks: [], activity: [], pstate: null, afterDone: 'stop', autoRounds: 0, strategy: 'save',
  agentCfg: Object.fromEntries(Object.keys(AGENTS).map((id) => [id, { model: '', effort: '', ...agentCfg?.[id] }])),
  workers: workers.filter((id) => AGENTS[id]),
});
const label = (w) => w.name || path.basename(w.project);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function wsOf(p) {
  const w = p && S.workspaces.find((x) => same(x.project, String(p)));
  if (!w) throw new Error('沒有開啟這個專案：' + p);
  return w;
}
for (const [id, a] of Object.entries(AGENTS)) {
  // models / efforts are the catalogs the agent itself reports (filled from AionCore events).
  S.agents[id] = { id, name: a.name, status: 'checking', note: '', working: 0, models: [], efforts: [] };
  S.agentCfg[id] = { model: '', effort: '' }; // '' = agent default
}

// ---------- Settings & history (plain JSON files under runtime/studio) ----------
const SETTINGS = path.join(RT, 'studio', 'settings.json');
const HISTORY = path.join(RT, 'studio', 'history');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  if (AGENTS[saved.leader]) S.leader = saved.leader;
  for (const id in S.agentCfg) Object.assign(S.agentCfg[id], saved.agentCfg?.[id]);
  // Older settings had one `project` and global models; it becomes the first open workspace with those models.
  S.workspaces = (saved.workspaces || (saved.project ? [{ project: saved.project }] : []))
    .filter((x) => isDir(x.project))
    .map((x) => Object.assign(newWs(x.project, AGENTS[x.leader] ? x.leader : S.leader, String(x.name || ''), x.agentCfg || S.agentCfg, x.workers || Object.keys(AGENTS)), { pstate: x.pstate || null, afterDone: AFTER_DONE.includes(x.afterDone) ? x.afterDone : 'stop', strategy: STRATEGY_IDS.includes(x.strategy) ? x.strategy : 'save' }));
  S.recent = (saved.recent || []).filter(isDir);
  if (saved.notify === false) S.notify = false;
} catch { /* first start: defaults */ }

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const workspaces = S.workspaces.map((w) => ({ project: w.project, leader: w.leader, name: w.name, agentCfg: w.agentCfg, workers: w.workers, pstate: w.pstate, afterDone: w.afterDone, strategy: w.strategy }));
  fs.writeFileSync(SETTINGS, JSON.stringify({ leader: S.leader, workspaces, recent: S.recent, agentCfg: S.agentCfg, notify: S.notify }, null, 2));
}

function saveRun(w, status) {
  const run = w.run;
  if (!run) return;
  fs.mkdirSync(HISTORY, { recursive: true });
  // phase + convs let a paused run continue in the same agent conversations after a Studio restart.
  const rec = { id: run.id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), status, phase: run.phase, project: run.project, leader: run.leader, request: run.request, goal: run.goal, refs: run.refs, context: run.context, continues: run.continues, rounds: run.rounds, ask: run.ask, notes: run.notes, suggestions: run.suggestions, convs: run.convs, tasks: w.tasks, activity: w.activity };
  fs.writeFileSync(path.join(HISTORY, run.id + '.json'), JSON.stringify(rec, null, 2));
  S.historyRev++;
}

// ponytail: re-reads the newest 200 history files whenever one changes; index them if history grows large.
let histCache = { rev: -1, items: [] };
function historyItems() {
  if (histCache.rev === S.historyRev) return histCache.items;
  const items = !isDir(HISTORY) ? [] : fs.readdirSync(HISTORY).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 200).flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8'))]; } catch { return []; }
  });
  histCache = { rev: S.historyRev, items };
  return items;
}

function listHistory() {
  return historyItems().slice(0, 50).map((r) => ({ id: r.id, startedAt: r.startedAt, status: r.status === 'running' && resumable(r) ? 'interrupted' : r.status, project: r.project, leader: r.leader, request: String(r.request).slice(0, 120), done: r.tasks.filter((t) => t.status === 'DONE').length, total: r.tasks.length }));
}

// Cards finished today, and the latest finished card per agent (current board + history).
function teamStats() {
  const today = new Date().toDateString();
  let todayDone = 0;
  const lastDone = {};
  const count = (t, fallbackAt) => {
    if (t.status !== 'DONE') return;
    const at = t.doneAt || fallbackAt;
    if (new Date(at).toDateString() === today) todayDone++;
    if (!lastDone[t.agent] || at > lastDone[t.agent].at) lastDone[t.agent] = { title: t.title, at };
  };
  const live = new Set(S.workspaces.map((w) => w.run?.id));
  for (const r of historyItems()) if (!live.has(r.id)) r.tasks.forEach((t) => count(t, r.finishedAt));
  for (const w of S.workspaces) w.tasks.forEach((t) => count(t, new Date().toISOString()));
  return { todayDone, lastDone };
}

function readHistory(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return JSON.parse(fs.readFileSync(path.join(HISTORY, id + '.json'), 'utf8'));
}

// Every event of a working run is also saved (status "running"), so closing the Studio mid-job loses nothing:
// after a restart the job shows as interrupted and can be continued like a paused one.
// detail = technical text (raw replies, parser errors); the page shows it only behind 查看技術細節.
function log(w, who, role, text, detail) {
  w?.activity.push({ time: new Date().toLocaleTimeString('zh-TW', { hour12: false }), who, role, text: String(text), ...(detail ? { detail: String(detail).slice(0, 4000) } : {}) });
  if (w?.run?.active) saveRun(w, 'running');
}

// ---------- AionCore ----------
let BASE;

async function ensureAion() {
  if (fs.existsSync(AION)) return;
  console.log('第一次啟動：下載 AionCore v0.2.2 ...');
  const buf = Buffer.from(await (await fetch(AION_URL)).arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== AION_ZIP_SHA256) throw new Error('AionCore 下載檔 SHA-256 不符，已中止');
  const zip = path.join(RT, 'download', 'aioncore.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.mkdirSync(path.dirname(AION), { recursive: true });
  fs.writeFileSync(zip, buf);
  await new Promise((res, rej) => execFile('tar', ['-xf', zip, '-C', path.dirname(AION)], (e) => (e ? rej(e) : res())));
}

async function startAion() {
  await ensureAion();
  const data = path.join(RT, 'studio', 'data');
  const work = path.join(RT, 'studio', 'work');
  for (const d of [data, work]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const logFile = fs.createWriteStream(path.join(RT, 'studio', 'aioncore.out.txt'));
  const p = spawn(AION, ['--local', '--port', '0', '--data-dir', data, '--work-dir', work, '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME } });
  process.on('exit', () => p.kill());
  await new Promise((res, rej) => {
    let buf = '';
    p.on('exit', (c) => rej(new Error('AionCore 結束，exit code ' + c)));
    p.stdout.on('data', (d) => {
      logFile.write(d);
      if (BASE) return;
      buf += d;
      const m = buf.match(/listening on [\d.]+:(\d+)/i);
      if (m && /AIONCORE_READY/.test(buf)) { BASE = 'http://127.0.0.1:' + m[1]; res(); }
    });
  });
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`AionCore ${method} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.data;
}

const convAgent = new Map(); // conversationId -> agent id (to route catalog events)

// cfg = the project's { model, effort } for this agent; none = agent defaults.
async function createConv(agent, ws, lead, cfg) {
  const body = AGENTS[agent].create(ws, lead);
  if (cfg?.model) body.extra.current_model_id = cfg.model;
  if (cfg?.effort) body.extra.thought_level = cfg.effort;
  // Right after READY, create can briefly 400 (assistant catalog race seen in P0).
  for (let i = 0; ; i++) {
    try {
      const id = (await api('POST', '/api/conversations', body)).id;
      convAgent.set(id, agent);
      return id;
    } catch (e) { if (i >= 4) throw e; await sleep(1000); }
  }
}

// AionCore pushes each agent's model / effort catalog as `acp_config_option` events on its WebSocket.
function watchCatalogs() {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data).data; } catch { return; }
    const agent = convAgent.get(d?.conversation_id);
    if (!agent || d.type !== 'acp_config_option') return;
    const a = S.agents[agent];
    for (const o of d.data?.config_options || []) {
      const opts = (o.options || []).map((x) => ({ value: x.value, name: x.name || x.value, description: x.description || '' }));
      if (o.category === 'model' && opts.length) a.models = opts;
      if (o.category === 'thought_level' && opts.length) a.efforts = opts.map((x) => x.value);
    }
  };
  ws.onclose = () => setTimeout(watchCatalogs, 2000);
}

// Per project, two tiers: normal (most cards and every Leader turn) and hard (cards the Leader marks "hard").
// The last choice is also the default for the next opened project.
function setAgentCfg(w, agent, model, effort, hardModel = '', hardEffort = '') {
  const a = S.agents[agent];
  if (!a) throw new Error('未知的 Agent');
  for (const m of [model, hardModel]) if (m && !a.models.some((x) => x.value === m)) throw new Error(`${a.name} 沒有這個模型：${m}`);
  for (const e of [effort, hardEffort]) if (e && !a.efforts.includes(e)) throw new Error(`${a.name} 不支援這個思考強度：${e}`);
  w.agentCfg[agent] = { model: model || '', effort: effort || '', hardModel: hardModel || '', hardEffort: hardEffort || '' };
  S.agentCfg[agent] = { ...w.agentCfg[agent] };
  saveSettings();
}

// Model strategy per project. The Leader marks hard cards; normal cards (and every Leader turn) use the
// normal tier, hard cards the hard tier, and a normal card that fails is retried once on the hard tier.
// Patterns match the catalogs the agents report (first match = newest). 'custom' = the seat-card settings.
const STRATEGIES = {
  save: { claude: [['^sonnet$', 'medium'], ['^opus$', 'high']], codex: [['luna', 'medium'], ['sol', 'high']] },
  balanced: { claude: [['^sonnet$', 'high'], ['^opus$', 'xhigh']], codex: [['luna', 'high'], ['sol', 'xhigh']] },
  quality: { claude: [['^opus$', 'high'], ['^fable$', 'high']], codex: [['sol', 'high'], ['sol', 'max']] },
};
const STRATEGY_IDS = [...Object.keys(STRATEGIES), 'custom'];

// The { model, effort } an agent uses in a project for one tier ('' = the agent's default).
function tierCfg(w, agent, hard) {
  const st = STRATEGIES[w.strategy]?.[agent], a = S.agents[agent];
  if (st) {
    const [re, eff] = st[hard ? 1 : 0];
    return { model: a?.models.find((m) => new RegExp(re).test(m.value))?.value || '', effort: a?.efforts.includes(eff) ? eff : '' };
  }
  const c = w.agentCfg[agent] || {};
  return hard ? { model: c.hardModel || c.model || '', effort: c.hardEffort || c.effort || '' } : { model: c.model || '', effort: c.effort || '' };
}
const tiersOf = (w) => Object.fromEntries(Object.keys(AGENTS).map((id) => [id, { normal: tierCfg(w, id, false), hard: tierCfg(w, id, true) }]));

function setStrategy(w, strategy) {
  if (!STRATEGY_IDS.includes(strategy)) throw new Error('未知的模型策略');
  w.strategy = strategy;
  saveSettings();
}

// Which agents may take this project's cards (the Leader is never a Worker).
function setWorker(w, agent, on) {
  if (!AGENTS[agent]) throw new Error('未知的 Agent');
  w.workers = on ? [...new Set([...w.workers, agent])] : w.workers.filter((x) => x !== agent);
  saveSettings();
}

const active = new Map(); // conversationId -> turnId (for Stop)

async function answerConfirmations(w, convId, allow) {
  // Modes are chosen so this should not happen; if it does, never leave a turn hanging.
  for (const c of (await api('GET', `/api/conversations/${convId}/confirmations`)) || []) {
    const opts = c.options || [];
    const re = allow ? /allow|approve|accept|yes|proceed/i : /reject|deny|cancel|abort|no/i;
    const pick = opts.find((o) => re.test(String(o.value))) || opts[allow ? 0 : opts.length - 1];
    await api('POST', `/api/conversations/${convId}/confirmations/${encodeURIComponent(c.callId ?? c.id)}/confirm`,
      { msg_id: c.msgId ?? c.id, data: pick ? pick.value : allow ? 'allow' : 'reject' }).catch((e) => log(w, 'studio', 'system', '自動回應確認失敗：' + e.message));
  }
}

// Send one message and wait until the agent's turn is over. Returns the agent's reply text.
async function turn(agent, convId, text, { w, lead = false, check = false, timeout = 20 * 60e3 } = {}) {
  const run = w?.run;
  const sent = await api('POST', `/api/conversations/${convId}/messages`, { content: text });
  active.set(convId, sent.turn_id);
  if (!check) S.agents[agent].working++;
  try {
    for (const t0 = Date.now(); ;) {
      await sleep(1500);
      const rt = (await api('GET', `/api/conversations/${convId}`)).runtime || {};
      if (rt.pending_confirmations) await answerConfirmations(w, convId, !lead);
      if (rt.state === 'idle' && !rt.is_processing) break;
      if (Date.now() - t0 > timeout) throw new Error('逾時');
    }
  } finally {
    active.delete(convId);
    if (!check) S.agents[agent].working--;
    if (agent === 'codex') refreshCodexLimits();
  }
  if (!check && (run?.stopped || run?.paused)) throw new Halt(run.stopped ? '已停止' : '已暫停');
  const items = (await api('GET', `/api/conversations/${convId}/messages`)).items || [];
  const after = items.slice(items.findIndex((m) => m.id === sent.msg_id) + 1);
  // A failed tool call mid-turn is normal (agents retry); only a failed text reply means the turn failed.
  const texts = after.filter((m) => m.type === 'text' && m.position === 'left');
  const last = texts.at(-1);
  const err = last?.status === 'error' ? last : !last && after.find((m) => m.status === 'error');
  if (err) throw new Error(String(err.content?.content ?? JSON.stringify(err.content)).slice(0, 1000));
  return String(last?.content?.content ?? '').trim();
}

// ---------- Team ----------
async function checkAgent(id) {
  const a = S.agents[id];
  a.status = 'checking';
  a.note = '';
  try {
    const ws = path.join(RT, 'studio', 'check');
    fs.mkdirSync(ws, { recursive: true });
    // The check uses agent defaults so a bad saved model can't make the agent look unavailable.
    const reply = await turn(id, await createConv(id, ws, true), 'Reply with exactly: OK', { lead: true, check: true, timeout: 120e3 });
    if (!/OK/i.test(reply)) throw new Error('沒有正常回覆：' + (reply || '(空白)'));
    a.status = 'available';
  } catch (e) {
    a.status = 'unavailable';
    a.note = e.message.slice(0, 200);
  }
}
const checkAll = () => Promise.all(Object.keys(AGENTS).map(checkAgent));
const available = (id) => S.agents[id]?.status === 'available';

// One conversation per agent and role; hard cards get their own conversation on the hard model.
// The Leader always uses the normal tier (it should be cheap: it only plans and checks).
const workKey = (t) => t.agent + ':work' + (t.hard ? ':hard' : '');
async function conv(w, agent, lead, hard = false) {
  const key = agent + (lead ? ':lead' : ':work') + (hard ? ':hard' : '');
  return (w.run.convs[key] ??= await createConv(agent, w.run.project, lead, tierCfg(w, agent, hard)));
}
// This run's conversations that have a turn in progress (other projects keep working).
const busyConvs = (run) => Object.values(run.convs).filter((c) => active.has(c));

// Thrown when a turn ends because the user paused or stopped the run.
class Halt extends Error {}

const workersFor = (w, lead) => w.workers.filter((id) => id !== lead && available(id));
const cancelTurn = (cid) => api('POST', `/api/conversations/${cid}/cancel`, { turn_id: active.get(cid) }).catch(() => {});

function handoffNote(run) {
  return run.handoffFrom ? `\nYou are taking over as LEADER from ${AGENTS[run.handoffFrom].name}. Continue the same job; do not ask the user to repeat the request.\n` : '';
}

const SUBTASK_RULES = `- Each subtask goes to exactly one worker id from the list above.
- Workers run in parallel, one task at a time each. Spread independent parts across different workers.
- Use "after" (0-based indexes of EARLIER subtasks in this list) when a subtask needs their results first, e.g. a review after the implementation, a fix after the review, a merge after the fix. Independent subtasks have no "after".
- When the request needs it, include review, verification and delivery (PR / merge) steps as their own subtasks.
- Never let two subtasks edit the same file at the same time. A trivial request may stay a single subtask.
- "instructions" must be complete and self-contained; the worker only sees that text, the results of its "after" subtasks, and the project folder.
- Claude Code has the smallest quota: give it a subtask only when codex and antigravity cannot do it.
- Set "hard": true only when a subtask needs deep reasoning (a tricky bug, a design across many files, a security-sensitive change). Most subtasks are not hard; hard ones run on a stronger, more expensive model.`;

// The project's work memory inside a Leader prompt.
function memoryNote(run) {
  if (!run.context) return '';
  return `\n${run.continues
    ? 'This is a CONTINUATION of the earlier job below. Start from the "Next action" and the verified project state: do not redo DONE work, do not re-research the whole repository, do not open a duplicate PR, and do not ask the user for PR / branch / commit facts listed here.'
    : 'Earlier Studio work in this project folder (background; reuse it, do not redo it):'}
"""
${run.context}
"""
`;
}

const FIX_JSON = 'Your last reply was not the JSON object Studio needs. Reply again with ONLY that JSON object: no markdown fences, no other text.';

const SUBTASK_SHAPE = `{"title":"<short title>","agent":"<worker id>","instructions":"<full instructions>","after":[<indexes>],"hard":false}`;

function planPrompt(run, workers) {
  return `You are the LEADER (foreman) of a small AI team in "Multi-Agent Studio".
Project folder: ${run.project}
Workers you can assign: ${workers.map((w) => `${w} (${AGENTS[w].name})`).join(', ')}
${handoffNote(run)}
User request:
"""
${run.request}
"""
${memoryNote(run)}
Rules:
- Do NOT do the work yourself. Do NOT create or modify any files. Only plan and delegate.
- Do not read files, search the repository or run commands yourself (your quota is precious): plan from the request and the work context. When facts are missing, make a short investigation subtask for a worker.
- Split the request into 1 to 6 small subtasks.
- Never ask the user for facts that are in the work context, the project folder, or git / GitHub: make looking them up a subtask instead.
${SUBTASK_RULES}

Reply with ONLY one JSON object, no markdown fences, in exactly this shape:
{"message":"<one short sentence to the user, in the user's language; for a continuation say where the project stands (PR / CI state) and where you pick up>","subtasks":[${SUBTASK_SHAPE}]}`;
}

const parseJson = (reply) => JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));

function parseSubtasks(list, workers) {
  return (list || []).filter((x) => x && (x.instructions || x.title)).slice(0, 6).map((x, i) => {
    const a = String(x.agent || '').toLowerCase();
    const after = (Array.isArray(x.after) ? x.after : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i);
    return { hard: x.hard === true, title: String(x.title || x.instructions).slice(0, 120), instructions: String(x.instructions || x.title), agent: workers.find((w) => a.includes(w)) || workers[0], after };
  });
}

function parsePlan(reply, workers) {
  const p = parseJson(reply);
  return { message: String(p.message || ''), subtasks: parseSubtasks(p.subtasks, workers) };
}

// Adds planned subtasks as cards; "after" indexes become card ids.
function addCards(w, subtasks, lead) {
  const ids = subtasks.map(() => crypto.randomUUID().slice(0, 8));
  subtasks.forEach((st, i) => {
    w.tasks.push({ id: ids[i], hard: st.hard, title: st.title, instructions: st.instructions, agent: st.agent, after: st.after.map((n) => ids[n]), status: 'WAITING', result: '' });
    log(w, lead, 'leader', `派工給 ${AGENTS[st.agent].name}：${st.title}${st.after.length ? `（等「${st.after.map((n) => subtasks[n].title).join('」「')}」完成後開始）` : ''}`);
  });
}

// ---------- Card lifecycle ----------
// A worker's turn ending is not the card being done. Every reply ends with one STATUS line:
//   DONE | WAITING_EXTERNAL (CI, build...) | WAITING_AGENT (another worker) | NEEDS_USER (a real decision).
// Waiting cards are parked; Studio wakes them (same conversation) when the result arrives.
const STATUS_RULES = `At the very end of your reply add exactly one status line:
STATUS: DONE   (the goal of this task is fully reached; nothing more to do for it)
STATUS: WAITING_EXTERNAL: <what you wait for; include the PR URL if there is one>   (GitHub CI, a build, a deploy...)
STATUS: WAITING_AGENT: <agent id>: <what you need from them>   (ids: ${Object.keys(AGENTS).join(', ')})
STATUS: NEEDS_USER: <question to the user, in the user's language>   (only for a real decision: choose between options, a destructive action, a login)
With NEEDS_USER and choices, add one more line: OPTIONS: <choice 1> | <choice 2>
Never say DONE while you still wait for something. Do not wait or poll inside your turn: report the status and end the turn; Studio wakes you with the result.`;

function parseStatus(reply) {
  const m = [...reply.matchAll(/^\s*[*_`]*STATUS[*_`]*\s*[:：]\s*[*_`]*\s*(DONE|WAITING_EXTERNAL|WAITING_AGENT|NEEDS_USER)\b[*_`]*\s*[:：]?\s*(.*)$/gim)].at(-1);
  if (!m) return null;
  const options = (reply.match(/^\s*[*_`]*OPTIONS[*_`]*\s*[:：]\s*[*_`]*\s*(.+)$/im)?.[1] || '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 4);
  const text = reply.replace(m[0], '').replace(/^\s*[*_`]*OPTIONS[*_`]*\s*[:：].*$/im, '').trim();
  return { kind: m[1].toUpperCase(), detail: m[2].trim(), options, text };
}

const PARKED = ['WAITING_EXTERNAL', 'WAITING_AGENT', 'NEEDS_USER'];
const OPEN = ['WAITING', 'WORKING', 'PAUSED', 'INTERRUPTED', ...PARKED];
const findPr = (s) => s.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0] || s.match(/\bPR\s*#(\d+)/i)?.[1] || '';

// A parked card goes back to the queue with a note; the worker continues in the same conversation.
function wake(w, t, note) {
  if (!PARKED.includes(t.status)) return;
  Object.assign(t, { status: 'WAITING', wakeNote: note, wait: null, ask: null });
  log(w, 'studio', 'system', `「${t.title}」等待的結果到了，交回 ${AGENTS[t.agent].name} 繼續。`);
  pump(w);
}

// When a card ends (done or failed), cards waiting on that agent get its result.
function wakeWaiters(w, done) {
  for (const t of w.tasks) {
    if (t !== done && t.status === 'WAITING_AGENT' && t.wait?.agent === done.agent) {
      wake(w, t, `${AGENTS[done.agent].name} finished "${done.title}" (${done.status}). Their result:\n${done.result}`);
    }
  }
}

function finish(w, status) {
  const run = w.run;
  run.active = false;
  run.paused = false;
  run.phase = 'finished';
  run.result = status;
  run.ask = null;
  saveRun(w, status);
  if (status === 'done' || status === 'failed') {
    const done = w.tasks.filter((t) => t.status === 'DONE').length;
    // e.g. "股票面板：Codex 已完成 3/3 工作" / "FamilyPDF：Claude Code 需要你處理"
    const failed = w.tasks.find((t) => t.status === 'FAILED');
    const workers = [...new Set(w.tasks.map((t) => t.agent))];
    const title = status === 'done'
      ? `${label(w)}：${workers.length === 1 ? AGENTS[workers[0]].name : '團隊'} 已完成 ${done}/${w.tasks.length} 工作`
      : `${label(w)}：${AGENTS[failed?.agent ?? run.leader].name} 需要你處理`;
    const body = status === 'done' ? String(run.request).slice(0, 100)
      : failed ? `「${failed.title}」失敗：${failed.result}`.slice(0, 160) : '工頭沒有完成派工，打開專案查看';
    notify(title, body, status, w.project);
  }
  refreshState(w); // save the project state at job end
  if (status === 'done' && w.afterDone === 'auto') setTimeout(() => autoNext(w, run), 5000);
}

// 自動持續開發: only when the user switched it on for this project, only after a done job, at most AUTO_MAX in a row.
function autoNext(w, run) {
  const next = run.suggestions?.[0];
  if (w.afterDone !== 'auto' || w.run !== run || !next) return;
  if (w.autoRounds >= AUTO_MAX) {
    log(w, 'studio', 'system', `已自動連續做了 ${AUTO_MAX} 件，先停下來等你。`);
    return notify(`${label(w)}：自動持續開發先停下`, `已連續自動做了 ${AUTO_MAX} 件，等你看過再繼續`, 'ask', w.project);
  }
  w.autoRounds++;
  notify(`${label(w)}：自動開始下一步`, next.title, 'done', w.project);
  start(w, next.request, true).then(() => log(w, 'studio', 'system', `自動持續開發（第 ${w.autoRounds}/${AUTO_MAX} 件）：工頭選了「${next.title}」`))
    .catch((e) => log(w, 'studio', 'system', '自動開始下一步失敗：' + e.message));
}

function setAfterDone(w, mode) {
  if (!AFTER_DONE.includes(mode)) throw new Error('未知的完成後模式');
  w.afterDone = mode;
  w.autoRounds = 0;
  saveSettings();
}

// ---------- Plan limits (5-hour / weekly) ----------
const WINDOW_MIN = { five_hour: 300, seven_day: 10080 };

// Codex reports its limits inside its own session logs (Studio's separate home), so reading them costs nothing.
function refreshCodexLimits() {
  try {
    const dir = path.join(CODEX_HOME, 'sessions');
    if (!isDir(dir)) return;
    const newest = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
      .map((f) => path.join(dir, String(f))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!newest) return;
    const line = fs.readFileSync(newest, 'utf8').split('\n').reverse().find((l) => l.includes('"rate_limits":{'));
    if (!line) return;
    const ev = JSON.parse(line);
    const rl = ev.payload.rate_limits;
    const windows = [rl.primary, rl.secondary].filter(Boolean).map((w) => ({ used: w.used_percent / 100, resetsAt: w.resets_at, windowMin: w.window_minutes }));
    if (windows.length) S.limits.codex = { windows, updatedAt: ev.timestamp };
  } catch { /* keep the last known numbers */ }
}

// Claude reports its limits on every request; one tiny Haiku request that is not saved as a session.
let claudeProbe = null;
function refreshClaudeLimits() {
  if (claudeProbe || !available('claude')) return claudeProbe;
  const cwd = path.join(RT, 'studio', 'check');
  fs.mkdirSync(cwd, { recursive: true });
  const args = ['-p', 'Reply with exactly: OK', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--model', 'haiku'];
  claudeProbe = new Promise((res) => execFile('claude', args, { cwd, windowsHide: true, timeout: 90000, maxBuffer: 4 << 20 }, (e, out) => {
    for (const l of String(out || '').split('\n')) {
      if (!l.includes('"rate_limit_event"')) continue;
      try {
        const uw = JSON.parse(l).rate_limit_info?.unifiedWindows || {};
        const windows = Object.entries(uw).filter(([k]) => WINDOW_MIN[k]).map(([k, w]) => ({ used: w.utilization, resetsAt: w.resetsAt, windowMin: WINDOW_MIN[k] }));
        if (windows.length) S.limits.claude = { windows, updatedAt: new Date().toISOString() };
      } catch { /* ignore malformed line */ }
    }
    claudeProbe = null;
    res();
  }));
  return claudeProbe;
}

// ---------- Notifications ----------
// Every finished / failed job sends a Windows toast (you can't watch every tab); open pages only play a sound.
function notify(title, body, kind, project) {
  if (!S.notify) return;
  S.notices = [...S.notices, { id: ++S.noticeSeq, title, body, kind }].slice(-20);
  windowsToast(title, body, `http://127.0.0.1:${PORT}/#p=${encodeURIComponent(project)}`);
}

// Clicking the toast opens that project's tab in the browser.
function windowsToast(title, body, url) {
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text/><text/><text placement="attribution">Multi-Agent Studio</text></binding></visual></toast>')
$x.DocumentElement.SetAttribute('launch', $env:STUDIO_URL)
$t = $x.GetElementsByTagName('text'); [void]$t[0].AppendChild($x.CreateTextNode($env:STUDIO_TITLE)); [void]$t[1].AppendChild($x.CreateTextNode($env:STUDIO_BODY))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  // Text goes through env vars, never into the script itself.
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, env: { ...process.env, STUDIO_TITLE: title, STUDIO_BODY: body, STUDIO_URL: url } },
    (e, out, err) => { if (e) console.error('Windows 通知失敗：' + String(err || e.message).trim().slice(0, 300)); });
}

function renameWorkspace(w, name) {
  w.name = String(name || '').trim().slice(0, 40);
  saveSettings();
}

// ---------- Work memory ----------
// Each project keeps a short, structured summary of its latest job (from the board, not the full chat).
// A new job gets it as background; a continuation and a new Leader get it as the starting point.
const clip = (x, n) => { x = String(x ?? ''); return x.length > n ? x.slice(0, n) + '…' : x; };
const REF_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|\bPR\s*#\d+|\bcommit\s+[0-9a-f]{7,40}\b|\bbranch\s+[`'"]?[\w./-]+/gi;

// The latest job of this project: the live one, or the newest saved record.
function latestJob(w) {
  if (w.run) return { run: w.run, tasks: w.tasks, activity: w.activity };
  const r = historyItems().find((x) => same(x.project, w.project));
  return r && { run: { ...r, result: r.status }, tasks: r.tasks, activity: r.activity };
}

function knownRefs(job) {
  const found = [...String(job.run.request || '').matchAll(REF_RE)].map((m) => m[0]).concat(job.tasks.flatMap((t) => [...String(t.result).matchAll(REF_RE)].map((m) => m[0]).concat(t.wait?.pr ? [/^\d+$/.test(t.wait.pr) ? 'PR #' + t.wait.pr : String(t.wait.pr)] : [])));
  return [...new Set([...(job.run.refs || []), ...found])].slice(-12);
}

function workContext(job) {
  if (!job?.run) return '';
  const { run, tasks } = job;
  const state = run.active ? 'in progress' : run.paused ? 'paused' : run.result || 'ended';
  const report = run.phase === 'finished' ? [...(job.activity || [])].reverse().find((m) => m.role === 'leader')?.text : '';
  const card = (t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent]?.name || t.agent}): ${clip(t.result, 400)}`
    + (t.wait ? ` | waiting for: ${t.wait.what}${t.wait.pr ? ` (PR ${t.wait.pr}${t.wait.ci ? ', ' + t.wait.ci : ''})` : ''}${t.wait.agent ? ` (from ${AGENTS[t.wait.agent]?.name})` : ''}` : '')
    + (t.ask ? ` | question to the user: ${t.ask.question}` : '');
  return [
    `Overall goal: ${clip(run.goal || run.request, 1500)}`,
    run.goal && run.goal !== run.request ? `Latest request: ${clip(run.request, 600)}` : '',
    `State: ${state}. Leader was ${AGENTS[run.leader]?.name || run.leader}.`,
    tasks.length ? 'Cards:\n' + tasks.map(card).join('\n') : 'Cards: none yet.',
    `Known deliveries (PR / branch / commit): ${knownRefs(job).join(', ') || 'none recorded'}`,
    run.ask ? `Open question to the user: ${run.ask.question}` : '',
    report ? `Leader's last report: ${clip(report, 800)}` : '',
  ].filter(Boolean).join('\n');
}

const CONTINUE_RE = /^\s*(繼續|继续|接著|接着|接續|continue|resume|把剩下|剩下的)/i;

async function start(w, request, cont = false) {
  // "繼續…" / the 接著上次的工作 button continue the latest job instead of starting from zero.
  cont = cont || CONTINUE_RE.test(request);
  if (cont && w.run?.paused) return resume(w); // the paused job itself picks up where it stopped
  if (w.run?.active) throw new Error('這個專案的團隊正在工作中，請先等待、暫停或按 Stop');
  if (!isDir(w.project)) throw new Error('專案資料夾不存在：' + w.project);
  if (!request.trim()) throw new Error('請輸入需求');
  const lead = w.leader;
  if (!available(lead)) throw new Error(`Leader ${AGENTS[lead].name} 目前不可用`);
  if (!workersFor(w, lead).length) throw new Error('這個專案至少需要一位可用的 Worker');

  const prev = latestJob(w);
  const continues = cont && (!!prev || ['open', 'wait', 'need'].includes(w.pstate?.level));
  const context = projectContext(w);
  // A paused run stays in history (status "paused") and can be continued from there later.
  w.tasks = [];
  w.activity = [];
  const now = new Date();
  const id = now.toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomUUID().slice(0, 4);
  w.run = { id, startedAt: now.toISOString(), project: w.project, leader: lead, request, convs: {}, phase: 'planning', leaderGen: 0, rounds: 0, ask: null, continues, context, goal: continues ? prev.run.goal || prev.run.request : request, refs: continues ? knownRefs(prev) : [], active: true, paused: false, stopped: false, summarizing: false };
  log(w, 'user', 'user', request);
  if (continues) log(w, 'studio', 'system', '接續上次的工作：工頭會拿到目前的進度摘要，不用重講。', context);
  log(w, 'studio', 'system', `Leader：${AGENTS[lead].name}；Workers：${workersFor(w, lead).map((x) => AGENTS[x].name).join('、')}`);
  planPhase(w);
}

async function planPhase(w) {
  const run = w.run;
  run.phase = 'planning';
  const gen = run.leaderGen, lead = run.leader;
  try {
    const workers = workersFor(w, lead);
    if (!workers.length) throw new Error('至少需要一位可用的 Worker');
    const cid = await conv(w, lead, true);
    const tryPlan = (x) => { try { const p = parsePlan(x, workers); return p.subtasks.length ? p : null; } catch { return null; } };
    let reply = await turn(lead, cid, planPrompt(run, workers), { w, lead: true });
    if (run.leaderGen !== gen) return; // a new Leader took over and plans again
    let plan = tryPlan(reply);
    if (!plan) {
      log(w, 'studio', 'system', '工頭的工作清單格式不對，正在請它重新整理…', reply);
      reply = await turn(lead, cid, FIX_JSON, { w, lead: true });
      if (run.leaderGen !== gen) return;
      plan = tryPlan(reply);
    }
    if (!plan) throw Object.assign(new Error('工頭這次沒有成功建立工作清單。Studio 保留了目前進度，按「↻ 接著上次的工作」可以再試一次。'), { detail: reply });
    log(w, lead, 'leader', plan.message || `已拆成 ${plan.subtasks.length} 項工作`);
    addCards(w, plan.subtasks, lead);
    run.phase = 'working';
    pump(w);
    processNotes(w);
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return; // pause: resume() plans again; stop: stop() already saved
    log(w, 'studio', 'system', e.detail ? e.message : '工頭這次沒有完成派工。Studio 保留了目前進度，可以再試一次。', e.detail || e.message);
    finish(w, 'failed');
  }
}

// Start every WAITING card whose earlier cards are DONE and whose agent is free in this project.
// When every card has ended, the Leader checks the whole request (and may add cards).
// ponytail: an agent can work for two projects at once (separate conversations); add a global per-agent slot if plan limits suffer.
function pump(w) {
  const run = w.run;
  if (!run?.active || run.paused || run.phase !== 'working') return;
  const byId = (id) => w.tasks.find((x) => x.id === id);
  for (const t of w.tasks) {
    if (t.status !== 'WAITING') continue;
    const deps = (t.after || []).map(byId).filter(Boolean);
    if (deps.some((d) => d.status === 'FAILED')) { Object.assign(t, { status: 'FAILED', result: '前一張工作卡失敗，這張沒有開始；交給工頭決定下一步。' }); continue; }
    if (deps.some((d) => d.status !== 'DONE')) continue;
    if (!t.hold && !w.tasks.some((x) => x.status === 'WORKING' && x.agent === t.agent)) runTask(w, t);
  }
  // Cards that only wait on each other would wait forever.
  const onAgents = w.tasks.filter((t) => t.status === 'WAITING_AGENT');
  if (onAgents.length && !w.tasks.some((t) => ['WORKING', 'WAITING', 'WAITING_EXTERNAL', 'NEEDS_USER'].includes(t.status))) {
    for (const t of onAgents) wake(w, t, 'Everyone you could wait for is waiting too or has finished, so nothing more will arrive. Continue with what you have, or report NEEDS_USER.');
  }
  if (!run.summarizing && w.tasks.length && w.tasks.every((t) => t.status === 'DONE' || t.status === 'FAILED')) summarize(w);
}

async function runTask(w, t) {
  const run = w.run;
  const note = t.wakeNote;
  t.status = 'WORKING';
  t.wakeNote = '';
  log(w, t.agent, 'worker', (note ? '收到等待的結果，繼續：' : t.resumed ? '繼續工作：' : '開始工作：') + t.title);
  try {
    const deps = (t.after || []).map((id) => w.tasks.find((x) => x.id === id)).filter(Boolean);
    const prompt = note ? `Update from Multi-Agent Studio for your task "${t.title}":
${note}

Continue the task. End your reply with a short summary (1-3 sentences).
${STATUS_RULES}` : `You are a WORKER in "Multi-Agent Studio". Your leader (${AGENTS[run.leader].name}) assigned you this task.
Work only inside the project folder: ${run.project}
${t.resumed ? '\nYou were interrupted while doing this task earlier. First check the current state of the project folder, then finish the task without redoing work that is already done.\n' : ''}
Task: ${t.title}
Instructions:
${t.instructions}
${deps.length ? `\nResults of the earlier cards this task builds on:\n${deps.map((d) => `- ${d.title} (${AGENTS[d.agent].name}): ${d.result}`).join('\n')}\n` : ''}
When you end your turn, reply with a short summary of what you did (1-3 sentences).
${STATUS_RULES}`;
    const cid = await conv(w, t.agent, false, t.hard);
    // A step stopped by 立刻打斷 ends early (maybe with an error): park the card until the Leader has read the note.
    const step = async (text) => { try { return await turn(t.agent, cid, text, { w }); } catch (e) { if (t.interrupted && !(e instanceof Halt)) return ''; throw e; } };
    const park = () => {
      Object.assign(t, { status: 'WAITING', interrupted: false, resumed: true,
        wakeNote: 'The user stopped your previous step midway to give you a new instruction. First check the current state of the files (your last step may be half done), then continue the task.'
          + (t.notes?.length ? '\nNew instruction from the user (via the leader): ' + t.notes.splice(0).join('\n') : '') }); // the note may arrive before the stop
      log(w, t.agent, 'worker', '已停下，等工頭轉達你的新指示：' + t.title);
    };
    const reply = await step(prompt);
    if (t.interrupted) { park(); return pump(w); }
    let st = parseStatus(reply);
    if (!st) { // ask once instead of guessing
      const again = await step(`Your last reply had no STATUS line. Reply with only the status line now.\n${STATUS_RULES}`);
      if (t.interrupted) { park(); return pump(w); }
      st = parseStatus(again);
      if (st) st.text = reply.trim();
    }
    st ||= { kind: 'DONE', detail: '', options: [], text: reply.trim() + '\n（沒有回報狀態，先當作完成，由工頭確認整體結果）' };
    let last = reply;
    while (t.notes?.length) {
      const note = t.notes.splice(0).join('\n');
      log(w, 'studio', 'system', `把你的指示交給 ${AGENTS[t.agent].name}，接著調整「${t.title}」。`);
      last = await step(`New instruction from the user (via the leader) for your task "${t.title}":\n${note}\n\nApply it to this task now. End your reply with a short summary (1-3 sentences).\n${STATUS_RULES}`);
      if (t.interrupted) { park(); return pump(w); }
      st = parseStatus(last) || { kind: 'DONE', detail: '', options: [], text: last.trim() };
    }
    applyStatus(w, t, st, last);
  } catch (e) {
    if (e instanceof Halt && run.paused) { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; t.wakeNote = note; return; }
    if (!(e instanceof Halt) && !t.hard && JSON.stringify(tierCfg(w, t.agent, true)) !== JSON.stringify(tierCfg(w, t.agent, false))) {
      Object.assign(t, { hard: true, escalated: true, status: 'WAITING', resumed: true, detail: e.message });
      log(w, 'studio', 'system', `「${t.title}」用平常的模型沒做成，自動改用強模型重試一次。`, e.message);
      return pump(w);
    }
    t.status = 'FAILED';
    t.result = '這張卡執行時出錯，沒有完成。';
    t.detail = e.message;
    log(w, t.agent, 'worker', '這張卡執行時出錯，沒有完成：' + t.title, e.message);
    wakeWaiters(w, t);
  }
  pump(w);
}

function applyStatus(w, t, st, reply) {
  const who = AGENTS[t.agent].name;
  t.result = st.text || '(沒有文字回覆)';
  log(w, t.agent, 'worker', t.result);
  if (st.kind === 'DONE') {
    t.status = 'DONE';
    t.doneAt = new Date().toISOString();
    return wakeWaiters(w, t);
  }
  if (st.kind === 'WAITING_EXTERNAL') {
    const pr = findPr(st.detail + '\n' + reply);
    t.status = 'WAITING_EXTERNAL';
    t.wait = { what: st.detail || '外部結果', pr, manual: !pr };
    if (pr) {
      log(w, 'studio', 'system', `「${t.title}」在等 PR ${pr} 的 CI：Studio 每分鐘檢查一次，跑完會自動交回 ${who}。`);
      checkExternal(w, t);
    } else {
      log(w, 'studio', 'system', `「${t.title}」在等「${t.wait.what}」：Studio 無法自動確認，結果好了請按「繼續」。`);
      notify(`${label(w)}：需要你按「繼續」`, `${who} 在等「${t.wait.what}」，Studio 無法自動確認`, 'ask', w.project);
    }
    return;
  }
  if (st.kind === 'WAITING_AGENT') {
    const a = Object.keys(AGENTS).find((id) => st.detail.toLowerCase().includes(id) || st.detail.includes(AGENTS[id].name));
    t.status = 'WAITING_AGENT';
    t.wait = { agent: a || '', what: st.detail.replace(/^[\w-]+\s*[:：]\s*/, '') || '另一位成員的結果' };
    if (!a || a === t.agent) return wake(w, t, `Studio could not tell which other team member you wait for (ids: ${Object.keys(AGENTS).join(', ')}). Continue without waiting, or report NEEDS_USER.`);
    if (!w.tasks.some((x) => x !== t && x.agent === a && OPEN.includes(x.status))) {
      return wake(w, t, `${AGENTS[a].name} has no open card in this job, so nothing will arrive from them. Do what you can without it, or report NEEDS_USER.`);
    }
    log(w, 'studio', 'system', `「${t.title}」在等 ${AGENTS[a].name}：它做完會自動交回 ${who}。`);
    return;
  }
  t.status = 'NEEDS_USER';
  t.ask = { question: st.detail || t.result.slice(-300), options: st.options };
  notify(`${label(w)}：${who} 需要你處理`, t.ask.question.slice(0, 160), 'ask', w.project);
}

// ---------- Instructions from the user while a job runs ----------
// The user's note goes to the Leader, who decides: tell a worker (on its card), cancel cards that
// have not started, or add cards. A busy Leader (planning / final check) gets the notes right after.
// interrupt = stop the working cards' current step now; they continue after the Leader has read the note.
function instruct(w, text, interrupt = false) {
  text = String(text || '').trim();
  if (!text) throw new Error('請輸入指示');
  const run = w.run;
  if (!run?.active && !run?.paused) throw new Error('目前沒有進行中的工作；新的工作請用「交給團隊」');
  if (run.active && run.ask && !run.summarizing) return answer(w, '', text); // the Leader is waiting for an answer: this is it
  log(w, 'user', 'user', (interrupt ? '你的指示（立刻打斷）：' : '你的指示：') + text);
  if (interrupt && run.active) {
    const working = w.tasks.filter((t) => t.status === 'WORKING');
    for (const t of working) {
      Object.assign(t, { hold: true, interrupted: true });
      const cid = run.convs[workKey(t)];
      if (cid && active.has(cid)) cancelTurn(cid);
    }
    if (working.length) log(w, 'studio', 'system', `已打斷 ${working.map((t) => AGENTS[t.agent].name).join('、')}：等工頭看完你的指示再接著做。`);
  }
  (run.notes ??= []).push(text);
  if (run.paused) return log(w, 'studio', 'system', '工作暫停中：指示先保留，按「繼續」後交給工頭。');
  processNotes(w);
}

const NOTE_SHAPE = `{"message":"<one sentence to the user, in the user's language>","tell":[{"card":"<card id>","note":"<what that worker must change>"}],"cancel":["<card id>"],"add":[${SUBTASK_SHAPE}]}`;

async function processNotes(w) {
  const run = w.run;
  // Planning and the final check read the notes themselves when they end (see planPhase / summarize).
  if (!run?.active || run.noting || run.phase !== 'working' || run.summarizing || !run.notes?.length) return;
  run.noting = true;
  const notes = run.notes.splice(0);
  const gen = run.leaderGen, lead = run.leader;
  const workers = workersFor(w, lead);
  try {
    const cid = await conv(w, lead, true);
    const prompt = `You are the LEADER. While the team is working, the user sent new instructions:
"""
${notes.join('\n')}
"""
Current cards:
${w.tasks.map((t) => `- id ${t.id} [${t.status}] ${t.title} (${t.agent})`).join('\n')}
Workers you can assign: ${workers.map((x) => `${x} (${AGENTS[x].name})`).join(', ')}

Decide how to apply the instructions. Do not modify files, open files or run commands.
- "tell" reaches that card's worker right away (a working worker gets it as soon as its current step ends; a card that has not started gets it before it starts).
- "cancel" only cards that are WAITING or waiting on something; never DONE or WORKING cards.
- "add" new cards; their "after" may only use indexes inside "add".
Reply with ONLY one JSON object, no markdown fences, in exactly this shape (empty lists are fine):
${NOTE_SHAPE}
Rules for new cards:
${SUBTASK_RULES}`;
    let d = null;
    for (const text of [prompt, FIX_JSON]) {
      const reply = await turn(lead, cid, text, { w, lead: true });
      if (run.leaderGen !== gen) return;
      try { d = parseJson(reply); break; } catch { log(w, 'studio', 'system', '工頭的回覆格式不對，正在請它重新整理…', reply); }
    }
    if (!d) {
      log(w, 'studio', 'system', '工頭這次沒能處理你的指示，已直接轉給正在工作的成員。');
      d = { tell: w.tasks.filter((t) => OPEN.includes(t.status)).map((t) => ({ card: t.id, note: notes.join('\n') })) };
    }
    log(w, lead, 'leader', String(d.message || '收到你的指示，已調整工作。'));
    for (const x of Array.isArray(d.tell) ? d.tell : []) {
      const t = w.tasks.find((y) => y.id === String(x?.card)), note = String(x?.note || '').trim();
      if (!t || !note) continue;
      if (t.status === 'WORKING') (t.notes ??= []).push(note);
      else if (PARKED.includes(t.status)) wake(w, t, 'New instruction from the user (via the leader): ' + note);
      else if (t.status === 'WAITING' && t.wakeNote) t.wakeNote += '\nNew instruction from the user (via the leader): ' + note; // an interrupted card
      else if (['WAITING', 'PAUSED', 'INTERRUPTED'].includes(t.status)) t.instructions += '\n\nInstruction added by the user during the job: ' + note;
      else continue;
      log(w, 'studio', 'system', `已把指示轉給 ${AGENTS[t.agent].name}（「${t.title}」）。`);
    }
    for (const id of Array.isArray(d.cancel) ? d.cancel : []) {
      const t = w.tasks.find((y) => y.id === String(id));
      if (!t || !['WAITING', 'PAUSED', 'INTERRUPTED', ...PARKED].includes(t.status)) continue;
      Object.assign(t, { status: 'FAILED', result: '依你的指示取消', wait: null, ask: null });
      log(w, 'studio', 'system', `已取消「${t.title}」。`);
    }
    const subs = workers.length ? parseSubtasks(d.add, workers) : [];
    if (subs.length) addCards(w, subs, lead);
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return;
    log(w, 'studio', 'system', '工頭這次沒能處理你的指示，請再送一次。', e.message);
  } finally {
    run.noting = false;
    for (const t of w.tasks) t.hold = false; // interrupted cards continue now
  }
  pump(w);
  processNotes(w); // more notes may have arrived meanwhile
}

// ---------- External waits: GitHub PR / CI (the only kind Studio can check by itself) ----------
const checking = new Set(); // card ids with a gh call in flight
const ghJson = (args, cwd) => new Promise((res, rej) => execFile('gh', args, { cwd, windowsHide: true, timeout: 30000 },
  (e, out, err) => { if (e) return rej(new Error(String(err || e.message).trim().slice(0, 200))); try { res(JSON.parse(out)); } catch (x) { rej(x); } }));

// owner/name of the folder's GitHub origin, or '' (read-only git call).
const originRepo = (cwd) => new Promise((res) => execFile('git', ['-c', 'safe.directory=*', 'remote', 'get-url', 'origin'], { cwd, windowsHide: true, timeout: 10000 },
  (e, out) => res(String(out || '').match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/)?.[1] || '')));

async function checkExternal(w, t) {
  if (t.status !== 'WAITING_EXTERNAL' || !t.wait?.pr || t.wait.manual || checking.has(t.id)) return;
  checking.add(t.id);
  try {
    // A bare "#23" belongs to the project's own origin (gh's default repo can point elsewhere).
    const repo = /^\d+$/.test(String(t.wait.pr)) ? await originRepo(w.project) : '';
    const j = await ghJson(['pr', 'view', String(t.wait.pr), ...(repo ? ['--repo', repo] : []), '--json', 'url,state,reviewDecision,statusCheckRollup'], w.project);
    if (t.status !== 'WAITING_EXTERNAL') return;
    const checks = j.statusCheckRollup || [];
    const pending = checks.filter((c) => (c.__typename === 'CheckRun' ? c.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(c.state)));
    t.wait.ci = checks.length ? `${checks.length - pending.length}/${checks.length} 個 CI 檢查完成` : '還沒看到 CI 檢查';
    t.wait.checkedAt = new Date().toISOString();
    if (!checks.length) t.wait.empty = (t.wait.empty || 0) + 1;
    // A new PR can take a minute to register its checks: zero checks three times in a row means there are none.
    if (j.state === 'OPEN' && (pending.length || (!checks.length && t.wait.empty < 3))) return;
    const summary = checks.map((c) => `${c.name || c.context || 'check'}: ${c.conclusion || c.state || c.status}`).join(', ') || 'no CI checks found';
    wake(w, t, `GitHub PR ${j.url}: state ${j.state}, review decision ${j.reviewDecision || 'none'}. CI: ${summary}.`);
  } catch (e) {
    if (t.status !== 'WAITING_EXTERNAL') return;
    Object.assign(t.wait, { manual: true, error: e.message });
    log(w, 'studio', 'system', `查不到 PR ${t.wait.pr} 的狀態（${e.message}）：結果好了請按「繼續」。`);
    notify(`${label(w)}：需要你按「繼續」`, `Studio 查不到 PR ${t.wait.pr} 的 CI 狀態`, 'ask', w.project);
  } finally { checking.delete(t.id); }
}

function watchExternal() {
  for (const w of S.workspaces) if (w.run?.active) for (const t of w.tasks) if (t.status === 'WAITING_EXTERNAL') checkExternal(w, t);
}

// ---------- Project State / Handoff Memory ----------
// Per project: what the last job was for, what is done, and the REAL Git / GitHub state (read with git / gh).
// Refreshed when Studio starts, when a project tab opens, when a job ends, before 接著處理 and before a Leader handoff.
// Git / GitHub wins over what agents wrote earlier.
const sh = (cmd, args, cwd) => new Promise((res) => execFile(cmd, args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 << 20 },
  (e, out, err) => res(e ? { err: String(err || e.message).trim().slice(0, 200) } : { out: String(out) })));
// Folders owned by another Windows account (e.g. the Codex sandbox user) need safe.directory to be readable.
// Only local reads that run no repo-configured programs go through it: fsmonitor is off, and nothing here talks to a remote.
const git = (cwd, ...args) => sh('git', ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', ...args], cwd);
const PR_FIELDS = 'number,title,state,headRefName,mergedAt,url,statusCheckRollup,reviewDecision';
const UNRESOLVED_Q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}';

function ciOf(rollup = []) {
  const name = (c) => c.name || c.context || 'check';
  const failed = rollup.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion || c.state)).map(name);
  const pending = rollup.filter((c) => (c.__typename === 'CheckRun' ? c.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(c.state))).map(name);
  const state = !rollup.length ? 'none' : failed.length ? 'failed' : pending.length ? 'running' : 'passed';
  return { state, total: rollup.length, done: rollup.length - pending.length, failed, pending };
}

// Reads the folder's real state. prNums = PR numbers the last job mentioned.
async function readGitState(project, prNums) {
  const g = { checkedAt: new Date().toISOString(), prs: [] };
  const st = await git(project, 'status', '--porcelain=v1', '-b');
  if (st.err) return { ...g, error: '這個資料夾不是 Git 專案' };
  const lines = st.out.split('\n').filter(Boolean);
  const head = (lines[0] || '').replace(/^## /, '');
  Object.assign(g, { branch: head.split('...')[0].replace(/^No commits yet on /, ''), dirty: lines.length - 1,
    ahead: +(head.match(/ahead (\d+)/)?.[1] || 0), behind: +(head.match(/behind (\d+)/)?.[1] || 0) });
  g.headSha = (await git(project, 'rev-parse', '--short', 'HEAD')).out?.trim() || '';
  const repo = await originRepo(project);
  if (!repo) return { ...g, error: '沒有 GitHub origin，只能看本機 Git' };
  g.repo = repo;
  try { g.mainSha = String(await ghJson(['api', `repos/${repo}/commits/HEAD`, '--jq', '{sha: .sha}'], project).then((x) => x.sha)).slice(0, 7); } catch { g.mainSha = ''; }
  let list;
  try { list = await ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '8', '--json', PR_FIELDS], project); }
  catch (e) { return { ...g, error: '讀不到 GitHub（' + e.message + '）' }; }
  for (const n of prNums.filter((n) => !list.some((p) => p.number === n)).slice(0, 3)) {
    try { list.push(await ghJson(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS], project)); } catch { /* deleted or another repo */ }
  }
  const [o, r] = repo.split('/');
  for (const p of list) {
    const pr = { n: p.number, title: p.title, state: p.state, branch: p.headRefName, mergedAt: p.mergedAt, url: p.url, review: p.reviewDecision || '', ci: ciOf(p.statusCheckRollup), mentioned: prNums.includes(p.number) };
    if (pr.state === 'OPEN' || pr.mentioned) {
      try {
        const q = await ghJson(['api', 'graphql', '-f', 'query=' + UNRESOLVED_Q, '-F', 'o=' + o, '-F', 'r=' + r, '-F', 'n=' + pr.n], project);
        pr.unresolved = (q.data?.repository?.pullRequest?.reviewThreads?.nodes || []).filter((x) => !x.isResolved).length;
      } catch { /* threads unknown */ }
    }
    g.prs.push(pr);
  }
  return g;
}

const CARD_WORD = { WAITING: '還沒開始', WORKING: '做到一半', PAUSED: '已暫停', INTERRUPTED: '被中斷', FAILED: '沒有完成', WAITING_EXTERNAL: '在等外部結果', WAITING_AGENT: '在等其他 AI', NEEDS_USER: '在等你回覆' };
const ciWord = (ci) => ({ none: '沒有 CI', passed: `CI 全綠（${ci.total}/${ci.total}）`, failed: `CI 失敗：${ci.failed.join('、')}`, running: `CI 跑到 ${ci.done}/${ci.total}（還在跑：${ci.pending.join('、')}）` })[ci.state];

// Turns the last job + the real Git / GitHub state into what the page and the next Leader need.
function deriveState(job, g) {
  const run = job?.run, tasks = job?.tasks || [];
  const started = run?.startedAt || '';
  const prs = g?.prs || [];
  const open = prs.filter((p) => p.state === 'OPEN');
  const merged = prs.filter((p) => p.state === 'MERGED' && (p.mentioned || (started && p.mergedAt >= started)));
  const jobDone = run?.result === 'done' || run?.status === 'done';
  const unfinished = run && !jobDone ? tasks.filter((t) => t.status !== 'DONE') : [];
  const done = [...tasks.filter((t) => t.status === 'DONE').map((t) => t.title), ...merged.map((p) => `PR #${p.n} 已 merge：${p.title}`)];
  const current = [
    ...open.map((p) => `PR #${p.n} 開著：${p.title} · ${ciWord(p.ci)}${p.review === 'CHANGES_REQUESTED' ? ' · review 要求修改' : ''}${p.unresolved ? ` · ${p.unresolved} 個 review 意見沒解決` : ''}`),
    ...merged.filter((p) => p.unresolved).map((p) => `PR #${p.n}（已 merge）還有 ${p.unresolved} 個 review 意見沒標成已解決`),
    ...unfinished.map((t) => `「${t.title}」${CARD_WORD[t.status] || t.status}`),
    ...(g?.dirty ? [`本機 ${g.branch} 有 ${g.dirty} 個檔案還沒 commit`] : []),
  ];
  const ask = run?.ask?.question || tasks.find((t) => t.status === 'NEEDS_USER')?.ask?.question;
  const ciFail = open.find((p) => p.ci.state === 'failed');
  const review = open.find((p) => p.unresolved || p.review === 'CHANGES_REQUESTED');
  const ciRun = open.find((p) => p.ci.state === 'running');
  const ready = open.find((p) => p.ci.state === 'passed' || p.ci.state === 'none');
  const CONT = '按「▶ 接著處理」讓團隊接手';
  const s = ask ? { level: 'need', headline: '需要 Nana', next: '你回覆後，工頭接著安排', you: `回答這個問題：${ask}（按「▶ 接著處理」後在上方回覆）` }
    : ciFail ? { level: 'open', headline: `PR #${ciFail.n} CI 失敗`, next: '工頭派人查 CI 失敗原因並修正', you: CONT }
    : review ? { level: 'open', headline: `PR #${review.n} 有 review 意見還沒解決`, next: '工頭派人處理 review 意見', you: CONT }
    : ciRun ? { level: 'wait', headline: `PR #${ciRun.n} 等待 CI`, next: 'CI 全綠 → 工頭完成 merge 與收尾', you: '☕ 不急：CI 還在跑。按「▶ 接著處理」後，團隊會等 CI 跑完再收尾（Studio 每分鐘檢查）' }
    : ready ? { level: 'open', headline: `PR #${ready.n} ${ready.ci.state === 'passed' ? 'CI 全綠，' : ''}還沒 merge`, next: '工頭確認後完成 merge 與收尾', you: CONT }
    : unfinished.length ? { level: 'open', headline: '上一件工作還沒完成', next: `接著做「${unfinished[0].title}」`, you: CONT }
    : g?.dirty ? { level: 'open', headline: '本機有還沒 commit 的修改', next: '工頭確認這些修改要不要交付', you: CONT + '，或自己處理這些修改' }
    : run ? { level: 'done', headline: '上一件工作已完成', next: '沒有剩下的事', you: '可以開始新的工作' }
    : { level: 'idle', headline: '待命', next: '', you: '在下面說你要什麼，按「交給團隊」' };
  const loose = merged.filter((p) => p.unresolved).map((p) => `PR #${p.n}`);
  if (loose.length && s.level !== 'idle') {
    s.next = (s.level === 'done' ? '' : s.next + '；') + `把 ${loose.join('、')} 的 review 意見標成已解決`;
    if (s.level === 'done') Object.assign(s, { level: 'open', headline: `${loose.join('、')} 有 review 意見沒標成已解決`, you: '按「▶ 接著處理」讓團隊收尾' });
  }
  if (s.level === 'done' && run?.suggestions?.length) s.you = '可以開始新的工作，或選一個工頭建議的下一步';
  return { ...s, suggestions: run?.suggestions || [], goal: run ? clip(String(run.goal || run.request).split('\n').find((x) => x.trim()) || '', 160) : '', leader: run?.leader || '',
    done: done.slice(-8), current, git: g || null, updatedAt: new Date().toISOString() };
}

// The handoff text every Leader gets: last job (work memory) + the verified state.
function projectContext(w) {
  const job = latestJob(w), ps = w.pstate;
  const memory = workContext(job);
  if (!ps) return memory;
  const g = ps.git || {};
  const pr = (p) => `- PR #${p.n} ${p.state} "${p.title}" (branch ${p.branch})${p.state === 'OPEN' ? `: ${p.ci.state === 'none' ? 'no CI' : `CI ${p.ci.state} (${p.ci.done}/${p.ci.total} done${p.ci.failed.length ? '; failed: ' + p.ci.failed.join(', ') : ''}${p.ci.pending.length ? '; running: ' + p.ci.pending.join(', ') : ''})`}; review: ${p.review || 'none'}` : p.mergedAt ? ` merged ${p.mergedAt.slice(0, 16)}` : ''}${p.unresolved != null ? `; unresolved review threads: ${p.unresolved}` : ''}`;
  const verified = g.error ? `Git / GitHub could not be read: ${g.error}.` : [
    `Project state checked with git / gh at ${g.checkedAt}. This is the truth; it overrides older notes above.`,
    `- repo ${g.repo || '?'}; main ${g.mainSha || '?'}; local branch ${g.branch || '?'} @ ${g.headSha || '?'} (${g.dirty || 0} uncommitted, ahead ${g.ahead || 0}, behind ${g.behind || 0})`,
    ...(g.prs || []).filter((p) => p.state === 'OPEN' || p.mentioned).map(pr),
  ].join('\n');
  return [memory, verified, `Done: ${ps.done.join('; ') || 'nothing recorded'}`, `Still open: ${ps.current.join('; ') || 'nothing'}`, `Next action: ${ps.next || 'none'}`].filter(Boolean).join('\n');
}

const refreshing = new Map(); // project -> promise (one refresh at a time per project)
function refreshState(w) {
  if (refreshing.has(w.project)) return refreshing.get(w.project);
  const p = (async () => {
    const job = latestJob(w);
    const nums = job ? [...new Set(knownRefs(job).map((x) => +(String(x).match(/(?:pull\/|#)(\d+)/)?.[1] || 0)).filter(Boolean))] : [];
    w.pstate = deriveState(job, await readGitState(w.project, nums));
    saveSettings();
  })().catch((e) => console.error('Project State 讀取失敗：' + e.message)).finally(() => refreshing.delete(w.project));
  refreshing.set(w.project, p);
  return p;
}

// ▶ 接著處理: refresh the state, then continue the paused job or start a continuation that gets the handoff.
async function continueProject(w) {
  if (w.run?.active) throw new Error('團隊正在工作中');
  await refreshState(w);
  if (w.run?.paused) {
    w.run.context = projectContext(w);
    return resume(w);
  }
  return start(w, '接著處理上一件工作', true);
}

// ---------- The Leader checks the whole request ----------
const MAX_ROUNDS = 3; // extra card rounds before the Leader must ask the user

async function summarize(w, userAnswer = '') {
  const run = w.run;
  run.summarizing = true;
  run.phase = 'summarizing';
  run.ask = null;
  const gen = run.leaderGen, lead = run.leader;
  const workers = workersFor(w, lead);
  const results = w.tasks.map((t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent].name}): ${clip(t.result, 500)}`).join('\n');
  try {
    const reply = await turn(lead, await conv(w, lead, true), `You are the LEADER. Every current card has ended.${handoffNote(run)}
Original user request:
"""
${run.request}
"""
Cards so far:
${results}
${memoryNote(run)}${userAnswer ? `\nThe user answered your question:\n"""\n${userAnswer}\n"""\n` : ''}
Decide whether the user's WHOLE request is complete: built, reviewed, verified, and delivered or merged when the request asks for it. Do not modify files, open files or run commands: judge from the card results (add a verification subtask if they are not enough).
Workers you can assign: ${workers.map((x) => `${x} (${AGENTS[x].name})`).join(', ') || '(none available)'}

Reply with ONLY one JSON object, no markdown fences, one of:
${w.afterDone === 'stop' ? '{"done":true,"report":"<final report to the user, 2-4 sentences, in the user\'s language>"}'
    : '{"done":true,"report":"<final report to the user, 2-4 sentences, in the user\'s language>","next":[{"title":"<short title, user\'s language>","why":"<one sentence why it is worth doing>","request":"<the full request to give the team>"}]}'}
{"done":false,"message":"<one sentence to the user>","subtasks":[${SUBTASK_SHAPE}]}
{"needs_user":"<question to the user, in the user's language>","options":["<choice>","<choice>"]}
Use needs_user only for a real decision the team cannot make.${w.afterDone === 'stop' ? '' : `
When done, also give 1 to 3 small, valuable next steps for this project in "next", best first, based on what you just saw (empty list if nothing is worth doing).${w.afterDone === 'auto' ? ' The first one may start automatically without the user: it must not need a decision from the user and must not be destructive (no deleting data, no force push, no release or deploy).' : ''}`}
Rules for new subtasks:
${SUBTASK_RULES}`, { w, lead: true });
    if (run.leaderGen !== gen) return;
    let d = null;
    try { d = parseJson(reply); } catch {
      log(w, 'studio', 'system', '工頭的回覆格式不對，正在請它重新整理…', reply);
      const again = await turn(lead, await conv(w, lead, true), FIX_JSON, { w, lead: true });
      if (run.leaderGen !== gen) return;
      try { d = parseJson(again); } catch { log(w, 'studio', 'system', '工頭這次沒有成功確認整體結果。', again); }
    }
    run.summarizing = false;
    if (run.notes?.length) { run.phase = 'working'; return processNotes(w); } // new instructions beat "done"
    if (!d) return askUser(w, '工頭這次沒有成功確認整體結果，Studio 保留了目前進度。要讓工頭再確認一次嗎？', ['再確認一次']);
    if (d.needs_user) return askUser(w, String(d.needs_user), d.options);
    if (d.done === false) {
      const subs = workers.length ? parseSubtasks(d.subtasks, workers) : [];
      if (!subs.length) return askUser(w, String(d.message || '工頭認為還沒完成，但沒有安排下一步。要怎麼做？'), []);
      if (++run.rounds > MAX_ROUNDS) return askUser(w, `工頭已經追加 ${MAX_ROUNDS} 輪工作，整體還沒完成（${d.message || ''}）。要讓團隊繼續追加嗎？`, ['繼續追加', '就這樣結束']);
      log(w, lead, 'leader', d.message || `整體還沒完成，追加 ${subs.length} 張工作卡`);
      addCards(w, subs, lead);
      run.phase = 'working';
      return pump(w);
    }
    log(w, lead, 'leader', String(d.report || d.message || '工頭確認整體工作已完成。'));
    run.suggestions = w.afterDone === 'stop' ? [] : (Array.isArray(d.next) ? d.next : []).filter((x) => x && (x.request || x.title)).slice(0, 3)
      .map((x) => ({ title: clip(x.title || x.request, 80), why: clip(x.why || '', 200), request: String(x.request || x.title) }));
    if (run.suggestions.length) log(w, lead, 'leader', '建議的下一步：\n' + run.suggestions.map((x, i) => `${i + 1}. ${x.title}${x.why ? '：' + x.why : ''}`).join('\n'));
    finish(w, 'done');
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return;
    run.summarizing = false;
    log(w, 'studio', 'system', '工頭這次沒有完成整體確認。Studio 保留了目前進度，可以按「↻ 接著上次的工作」再試。', e.message);
    finish(w, 'failed');
  }
}

function askUser(w, question, options) {
  const run = w.run;
  run.phase = 'summarizing';
  run.ask = { question, options: (Array.isArray(options) ? options : []).map(String).filter(Boolean).slice(0, 4) };
  log(w, run.leader, 'leader', '需要你決定：' + question);
  notify(`${label(w)}：${AGENTS[run.leader].name} 需要你處理`, question.slice(0, 160), 'ask', w.project);
}

// The user's reply to a card (taskId) or to the Leader (no taskId).
function answer(w, taskId, text) {
  text = String(text || '').trim();
  if (!text) throw new Error('請選一個選項或輸入回覆');
  const run = w.run;
  if (!run?.active) throw new Error('這個專案目前沒有在工作（暫停中請先按「繼續」）');
  if (taskId) {
    const t = w.tasks.find((x) => x.id === taskId);
    if (t?.status !== 'NEEDS_USER') throw new Error('這張工作卡沒有在等你回覆');
    log(w, 'user', 'user', `回覆「${t.title}」：${text}`);
    return wake(w, t, `The user answered your question:\n"""\n${text}\n"""`);
  }
  if (!run.ask || run.summarizing) throw new Error('工頭沒有在等你回覆');
  log(w, 'user', 'user', '回覆工頭：' + text);
  run.rounds = 0;
  summarize(w, text);
}

// Manual 「繼續」 for a wait Studio cannot check by itself.
function continueCard(w, taskId) {
  const t = w.tasks.find((x) => x.id === taskId);
  if (!['WAITING_EXTERNAL', 'WAITING_AGENT'].includes(t?.status)) throw new Error('這張工作卡沒有在等待');
  if (!w.run?.active) throw new Error('這個專案目前沒有在工作（暫停中請先按「繼續」）');
  log(w, 'user', 'user', `「${t.title}」在等的東西好了，請繼續`);
  wake(w, t, `The user says what you were waiting for ("${t.wait?.what || ''}") should be ready now. Check it yourself and continue.`);
}

function stop(w) {
  const run = w.run;
  if (!run?.active && !run?.paused) return;
  run.stopped = true;
  busyConvs(run).forEach(cancelTurn);
  for (const t of w.tasks) if (['WAITING', 'PAUSED', 'INTERRUPTED', ...PARKED].includes(t.status)) { t.status = 'FAILED'; t.result = '已停止'; }
  log(w, 'studio', 'system', '已按下 Stop：這個專案的 Agent 停止目前工作。');
  finish(w, 'stopped');
}

function pause(w) {
  const run = w.run;
  if (!run?.active) throw new Error('目前沒有進行中的工作');
  run.paused = true;
  run.active = false;
  busyConvs(run).forEach(cancelTurn);
  for (const t of w.tasks) if (t.status === 'WORKING') { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; }
  log(w, 'studio', 'system', '已暫停：工作卡和對話都保留，關掉 Studio 也沒關係，之後按「繼續」接著做。');
  saveRun(w, 'paused');
}

// Can be continued: paused by the user, or "running" in the file but no longer live (Studio was closed mid-job).
const resumable = (r) => r.status === 'paused' || (r.status === 'running' && !S.workspaces.some((w) => w.run?.id === r.id && w.run.active));

function loadRun(w, r) {
  // (goal / refs / context / continues come back too: the work memory survives a restart)
  // Cards that were mid-work when the Studio closed are interrupted; waiting cards keep waiting.
  for (const t of r.tasks) if (t.status === 'WORKING') Object.assign(t, { status: 'INTERRUPTED', result: '已中斷', resumed: true });
  for (const t of r.tasks) Object.assign(t, { hold: false, interrupted: false });
  w.tasks = r.tasks;
  w.activity = r.activity;
  w.run = { id: r.id, startedAt: r.startedAt, project: r.project, leader: r.leader, request: r.request, convs: r.convs || {}, phase: r.phase || 'working', leaderGen: 0, rounds: r.rounds || 0, ask: r.ask || null, notes: r.notes || [], goal: r.goal, refs: r.refs, context: r.context, continues: r.continues, active: false, paused: true, stopped: false, summarizing: false };
  for (const [k, cid] of Object.entries(w.run.convs)) convAgent.set(cid, k.split(':')[0]);
}

// w is null when continuing from history: the record's project picks (or opens) the workspace.
function resume(w, id) {
  if (id && w?.run?.id !== id) {
    const r = readHistory(id);
    if (!resumable(r)) throw new Error('這筆紀錄不是暫停或中斷的工作');
    w = wsOf(openWorkspace(r.project).project);
    if (w.run?.id !== id) {
      if (w.run?.active) throw new Error('這個專案有進行中的工作，請先暫停或停止');
      loadRun(w, r);
    }
  }
  const run = w?.run;
  if (!run?.paused) throw new Error('沒有暫停中的工作');
  if (busyConvs(run).length) throw new Error('Agent 還在停下中，請幾秒後再按繼續');
  if (!isDir(run.project)) throw new Error('專案資料夾不存在：' + run.project);
  if (!available(w.leader)) throw new Error(`Leader ${AGENTS[w.leader].name} 目前不可用`);
  if (run.leader !== w.leader) { run.handoffFrom = run.leader; run.leader = w.leader; }
  run.paused = false;
  run.active = true;
  for (const t of w.tasks) if (t.status === 'PAUSED' || t.status === 'INTERRUPTED') t.status = 'WAITING';
  log(w, 'studio', 'system', `繼續工作（Leader：${AGENTS[run.leader].name}）。`);
  if (run.phase === 'planning') planPhase(w);
  else if (run.phase === 'summarizing') { if (!run.ask) summarize(w); } // a pending question waits for the user's answer
  else { run.phase = 'working'; pump(w); watchExternal(); processNotes(w); }
}

function reassign(w, taskId, agent) {
  const run = w.run;
  const t = w.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這項工作');
  if (t.status === 'WORKING') throw new Error('工作進行中，請先暫停或 Stop');
  if (!available(agent)) throw new Error(`${AGENTS[agent]?.name ?? agent} 目前不可用`);
  Object.assign(t, { agent, result: '', wakeNote: '', wait: null, ask: null });
  log(w, 'user', 'user', `重新指派「${t.title}」給 ${AGENTS[agent].name}`);
  if (run.paused) { t.status = 'PAUSED'; saveRun(w, 'paused'); return; } // runs when the user continues
  t.status = 'WAITING';
  Object.assign(run, { active: true, stopped: false, phase: 'working' });
  pump(w);
}

// Changing the Leader mid-run hands the same job over; Workers keep their cards.
async function setLeader(w, agent) {
  if (!AGENTS[agent]) throw new Error('未知的 Agent');
  if (!available(agent)) throw new Error(`${AGENTS[agent].name} 目前不可用`);
  const old = w.leader;
  if (old === agent) return;
  w.leader = S.leader = agent; // the last pick is also the default for the next opened project
  saveSettings();
  const run = w.run;
  if (!run || (!run.active && !run.paused)) return log(w, 'studio', 'system', `Leader 換成 ${AGENTS[agent].name}`);
  run.handoffFrom = run.leader;
  run.leader = agent;
  run.leaderGen++;
  const n = w.tasks.length;
  log(w, 'studio', 'system', `Leader 交接：${AGENTS[old].name} → ${AGENTS[agent].name}。新 Leader 接手原始需求${n ? `和 ${n} 張工作卡（已完成的結果保留）` : ''}，不需要重新輸入。`);
  const oldConv = run.convs[old + ':lead'];
  if (oldConv && active.has(oldConv)) cancelTurn(oldConv);
  const gen = run.leaderGen;
  await refreshState(w); // the new Leader starts from the verified project state
  if (run.leaderGen !== gen || w.run !== run) return;
  run.context = projectContext(w);
  if (run.paused) return saveRun(w, 'paused');
  if (run.phase === 'planning') planPhase(w);
  else if (run.phase === 'summarizing' && !run.ask) summarize(w);
}

// Opens a project as its own tab (or returns the open one).
function openWorkspace(p) {
  if (!String(p || '').trim()) throw new Error('請輸入資料夾路徑');
  p = path.resolve(String(p).trim());
  if (!isDir(p)) throw new Error('資料夾不存在：' + p);
  let w = S.workspaces.find((x) => same(x.project, p));
  if (!w) { S.workspaces.push((w = newWs(p))); refreshState(w); }
  S.recent = [w.project, ...S.recent.filter((x) => !same(x, w.project))].slice(0, 8);
  saveSettings();
  return { project: w.project };
}

function closeWorkspace(w) {
  if (w.run?.active) throw new Error('這個專案的團隊還在工作，請先暫停或停止');
  S.workspaces = S.workspaces.filter((x) => x !== w); // a paused job stays in 歷史紀錄
  saveSettings();
}

function removeRecent(p) {
  S.recent = S.recent.filter((x) => x !== p);
  saveSettings();
}

function readProjectProgress(w) {
  const file = path.join(w.project, '.ai-workspace', 'progress.md');
  if (!fs.existsSync(file)) return { exists: false, text: '' };
  return { exists: true, text: fs.readFileSync(file, 'utf8'), file };
}

function browseFolder() {
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; $d = New-Object System.Windows.Forms.FolderBrowserDialog;
$d.Description = 'Choose project folder'; if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath }`;
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: false }, (e, out) => res(String(out || '').trim())));
}

// ---------- Paseo (extra tool entry: its own app gives remote / phone access) ----------
const PASEO_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Paseo', 'Paseo.exe');
const PASEO_RES = path.join(path.dirname(PASEO_EXE), 'resources');
S.paseo = 'checking'; // missing | stopped | running

// Same as Paseo's bundled paseo.cmd, without going through cmd.exe.
function paseo(args) {
  const argv = ['--disable-warning=DEP0040', path.join(PASEO_RES, 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js'),
    'node-script', path.join(PASEO_RES, 'app.asar', 'node_modules', '@getpaseo', 'cli', 'dist', 'index.js'), ...args];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production', PASEO_DESKTOP_MANAGED: '1' };
  return new Promise((res, rej) => execFile(PASEO_EXE, argv, { env, windowsHide: true, timeout: 30000 },
    (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().slice(0, 300))) : res(String(out)))));
}

async function pollPaseo() {
  if (!fs.existsSync(PASEO_EXE)) return (S.paseo = 'missing');
  try { S.paseo = JSON.parse(await paseo(['status', '--json'])).localDaemon === 'running' ? 'running' : 'stopped'; }
  catch { S.paseo = 'stopped'; }
}

async function openInPaseo(w) {
  if (!fs.existsSync(PASEO_EXE)) throw new Error('這台電腦沒有安裝 Paseo');
  spawn(PASEO_EXE, [], { detached: true, stdio: 'ignore' }).unref(); // opens Paseo, or brings the open window forward
  for (let i = 0; S.paseo !== 'running' && i < 20; i++) { await sleep(1500); await pollPaseo(); }
  if (S.paseo !== 'running') throw new Error('Paseo 已開啟，但它的背景服務還沒準備好，請稍後再按一次');
  if (!JSON.parse(await paseo(['workspace', 'ls', '--json'])).some((x) => same(x.cwd, w.project))) {
    await paseo(['workspace', 'create', '--isolation', 'local', '--path', w.project, '--title', path.basename(w.project), '--json']);
  }
}

// ---------- HTTP ----------
const routes = {
  'POST /api/limits/refresh': async () => { refreshCodexLimits(); await refreshClaudeLimits(); },
  'POST /api/notify': (b) => { S.notify = !!b.on; saveSettings(); },
  'GET /api/state': () => {
    const workspaces = S.workspaces.map((w) => {
      const r = w.run;
      return { project: w.project, name: label(w), leader: w.leader, agentCfg: w.agentCfg, workers: w.workers, pstate: w.pstate, afterDone: w.afterDone, autoRounds: w.autoRounds, strategy: w.strategy, tiers: tiersOf(w), tasks: w.tasks, activity: w.activity, progress: readProjectProgress(w),
        run: r && { id: r.id, active: r.active, stopped: r.stopped, paused: r.paused, phase: r.phase, leader: r.leader, request: r.request, startedAt: r.startedAt, result: r.result, ask: r.ask, continues: r.continues, summarizing: r.summarizing, notes: (r.notes || []).length, noting: !!r.noting } };
    });
    return { ...S, ...teamStats(), agents: Object.values(S.agents), workspaces };
  },
  // Project-scoped calls name their project in `ws` (its folder path).
  'POST /api/pause': (b) => pause(wsOf(b.ws)),
  'POST /api/resume': (b) => resume(b.ws ? wsOf(b.ws) : null, b.id),
  'POST /api/paseo/open': (b) => openInPaseo(wsOf(b.ws)),
  'POST /api/workspace/open': (b) => openWorkspace(b.path),
  'POST /api/workspace/close': (b) => closeWorkspace(wsOf(b.ws)),
  'POST /api/workspace/rename': (b) => renameWorkspace(wsOf(b.ws), b.name),
  'POST /api/notify/test': () => windowsToast('測試通知：Studio 通知正常', '專案完成或需要你處理時會這樣通知你', `http://127.0.0.1:${PORT}/`),
  'POST /api/browse': async () => { const p = await browseFolder(); return p ? openWorkspace(p) : {}; },
  'POST /api/leader': (b) => setLeader(wsOf(b.ws), b.agent),
  'POST /api/start': (b) => { const w = wsOf(b.ws); w.autoRounds = 0; return start(w, String(b.request || ''), !!b.continue); },
  'POST /api/after-done': (b) => setAfterDone(wsOf(b.ws), b.mode),
  'POST /api/stop': (b) => stop(wsOf(b.ws)),
  'POST /api/reassign': (b) => reassign(wsOf(b.ws), b.taskId, b.agent),
  'POST /api/continue': (b) => { const w = wsOf(b.ws); w.autoRounds = 0; return continueProject(w); },
  'POST /api/project-state/refresh': (b) => refreshState(wsOf(b.ws)),
  'POST /api/instruct': (b) => instruct(wsOf(b.ws), b.text, !!b.interrupt),
  'POST /api/strategy': (b) => setStrategy(wsOf(b.ws), b.strategy),
  'POST /api/answer': (b) => answer(wsOf(b.ws), b.taskId, b.text),
  'POST /api/continue-card': (b) => continueCard(wsOf(b.ws), b.taskId),
  'POST /api/check': () => { checkAll().then(refreshClaudeLimits); },
  'POST /api/recent/remove': (b) => removeRecent(b.path),
  'POST /api/agent-config': (b) => setAgentCfg(wsOf(b.ws), b.agent, b.model, b.effort, b.hardModel, b.hardEffort),
  'POST /api/workers': (b) => setWorker(wsOf(b.ws), b.agent, !!b.on),
  // One-time login for Studio's separate Codex home, in a visible console window.
  'POST /api/codex-login': () => { spawn('cmd', ['/c', 'start', 'Codex login (Studio)', 'cmd', '/k', 'codex', 'login'], { env: { ...process.env, CODEX_HOME }, detached: true, stdio: 'ignore' }); },
  'GET /api/history': () => listHistory(),
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body ?? {}) : body); };
  // Local-only: reject other hosts (DNS rebinding) and non-JSON POSTs (cross-site form posts).
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'forbidden' });
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, fs.readFileSync(path.join(import.meta.dirname, 'index.html')), 'text/html; charset=utf-8');
  const hist = req.method === 'GET' && req.url.match(/^\/api\/history\/([\w-]+)$/);
  const fn = hist ? () => readHistory(hist[1]) : routes[`${req.method} ${req.url}`];
  if (!fn) return send(404, { error: 'not found' });
  if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return send(415, { error: 'json only' });
  try {
    let raw = '';
    for await (const c of req) raw += c;
    send(200, (await fn(raw ? JSON.parse(raw) : {})) ?? { ok: true });
  } catch (e) {
    send(400, { error: e.message });
  }
});

// Show each open project's latest paused job again after a restart, ready to continue.
for (const w of S.workspaces) {
  const r = historyItems().find((x) => (x.status === 'paused' || x.status === 'running') && same(x.project, w.project));
  if (r) loadRun(w, r);
}

await startAion();
watchCatalogs();
pollPaseo();
setInterval(pollPaseo, 10000);
setInterval(watchExternal, 60000); // GitHub PR / CI waits
// Port taken (e.g. another Studio copy is open): use the next free one, unless STUDIO_PORT asked for an exact port.
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE' || process.env.STUDIO_PORT || PORT >= 4858) throw e;
  console.log(`Port ${PORT} 已被其他程式使用（可能是另一個 Studio），改用 ${PORT + 1}`);
  server.listen(++PORT, '127.0.0.1');
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Multi-Agent Studio 已啟動：${url}  （關閉此視窗即停止）`);
  if (!process.env.STUDIO_NO_OPEN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
});
server.listen(PORT, '127.0.0.1');
refreshCodexLimits();
checkAll().then(refreshClaudeLimits);
for (const w of S.workspaces) refreshState(w);
