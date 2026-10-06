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
const PORT = Number(process.env.STUDIO_PORT || 4848);
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

const S = { project: '', leader: 'codex', recent: [], historyRev: 0, agentCfg: {}, agents: {}, tasks: [], activity: [], run: null };
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
  if (isDir(saved.project)) S.project = saved.project;
  S.recent = (saved.recent || []).filter(isDir);
  for (const id in S.agentCfg) Object.assign(S.agentCfg[id], saved.agentCfg?.[id]);
} catch { /* first start: defaults */ }

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ leader: S.leader, project: S.project, recent: S.recent, agentCfg: S.agentCfg }, null, 2));
}

function saveRun(status) {
  const run = S.run;
  if (!run) return;
  fs.mkdirSync(HISTORY, { recursive: true });
  // phase + convs let a paused run continue in the same agent conversations after a Studio restart.
  const rec = { id: run.id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), status, phase: run.phase, project: run.project, leader: run.leader, request: run.request, convs: run.convs, tasks: S.tasks, activity: S.activity };
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
  return historyItems().slice(0, 50).map((r) => ({ id: r.id, startedAt: r.startedAt, status: r.status, project: r.project, leader: r.leader, request: String(r.request).slice(0, 120), done: r.tasks.filter((t) => t.status === 'DONE').length, total: r.tasks.length }));
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
  for (const r of historyItems()) if (r.id !== S.run?.id) r.tasks.forEach((t) => count(t, r.finishedAt));
  S.tasks.forEach((t) => count(t, new Date().toISOString()));
  return { todayDone, lastDone };
}

function readHistory(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return JSON.parse(fs.readFileSync(path.join(HISTORY, id + '.json'), 'utf8'));
}

function log(who, role, text) {
  S.activity.push({ time: new Date().toLocaleTimeString('zh-TW', { hour12: false }), who, role, text: String(text) });
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

async function createConv(agent, ws, lead, useCfg = true) {
  const body = AGENTS[agent].create(ws, lead);
  const cfg = S.agentCfg[agent];
  if (useCfg && cfg.model) body.extra.current_model_id = cfg.model;
  if (useCfg && cfg.effort) body.extra.thought_level = cfg.effort;
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

function setAgentCfg(agent, model, effort) {
  const a = S.agents[agent];
  if (!a) throw new Error('未知的 Agent');
  if (model && !a.models.some((m) => m.value === model)) throw new Error(`${a.name} 沒有這個模型：${model}`);
  if (effort && !a.efforts.includes(effort)) throw new Error(`${a.name} 不支援這個推理強度：${effort}`);
  S.agentCfg[agent] = { model: model || '', effort: effort || '' };
  saveSettings();
}

const active = new Map(); // conversationId -> turnId (for Stop)

async function answerConfirmations(convId, allow) {
  // Modes are chosen so this should not happen; if it does, never leave a turn hanging.
  for (const c of (await api('GET', `/api/conversations/${convId}/confirmations`)) || []) {
    const opts = c.options || [];
    const re = allow ? /allow|approve|accept|yes|proceed/i : /reject|deny|cancel|abort|no/i;
    const pick = opts.find((o) => re.test(String(o.value))) || opts[allow ? 0 : opts.length - 1];
    await api('POST', `/api/conversations/${convId}/confirmations/${encodeURIComponent(c.callId ?? c.id)}/confirm`,
      { msg_id: c.msgId ?? c.id, data: pick ? pick.value : allow ? 'allow' : 'reject' }).catch((e) => log('studio', 'system', '自動回應確認失敗：' + e.message));
  }
}

// Send one message and wait until the agent's turn is over. Returns the agent's reply text.
async function turn(agent, convId, text, { lead = false, check = false, timeout = 20 * 60e3 } = {}) {
  const run = S.run;
  const sent = await api('POST', `/api/conversations/${convId}/messages`, { content: text });
  active.set(convId, sent.turn_id);
  if (!check) S.agents[agent].working++;
  try {
    for (const t0 = Date.now(); ;) {
      await sleep(1500);
      const rt = (await api('GET', `/api/conversations/${convId}`)).runtime || {};
      if (rt.pending_confirmations) await answerConfirmations(convId, !lead);
      if (rt.state === 'idle' && !rt.is_processing) break;
      if (Date.now() - t0 > timeout) throw new Error('逾時');
    }
  } finally {
    active.delete(convId);
    if (!check) S.agents[agent].working--;
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
    const reply = await turn(id, await createConv(id, ws, true, false), 'Reply with exactly: OK', { lead: true, check: true, timeout: 120e3 });
    if (!/OK/i.test(reply)) throw new Error('沒有正常回覆：' + (reply || '(空白)'));
    a.status = 'available';
  } catch (e) {
    a.status = 'unavailable';
    a.note = e.message.slice(0, 200);
  }
}
const checkAll = () => Promise.all(Object.keys(AGENTS).map(checkAgent));
const available = (id) => S.agents[id]?.status === 'available';

async function conv(agent, lead) {
  const key = agent + (lead ? ':lead' : ':work');
  return (S.run.convs[key] ??= await createConv(agent, S.run.project, lead));
}

// Thrown when a turn ends because the user paused or stopped the run.
class Halt extends Error {}

const workersFor = (lead) => Object.keys(AGENTS).filter((id) => id !== lead && available(id));
const cancelTurn = (cid) => api('POST', `/api/conversations/${cid}/cancel`, { turn_id: active.get(cid) }).catch(() => {});

function handoffNote(run) {
  return run.handoffFrom ? `\nYou are taking over as LEADER from ${AGENTS[run.handoffFrom].name}. Continue the same job; do not ask the user to repeat the request.\n` : '';
}

function planPrompt(run, workers) {
  return `You are the LEADER (foreman) of a small AI team in "Multi-Agent Studio".
Project folder: ${run.project}
Workers you can assign: ${workers.map((w) => `${w} (${AGENTS[w].name})`).join(', ')}
${handoffNote(run)}
User request:
"""
${run.request}
"""

Rules:
- Do NOT do the work yourself. Do NOT create or modify any files. Only plan and delegate.
- Split the request into 1 to 4 small subtasks. Each subtask goes to exactly one worker id from the list above.
- Workers run in parallel, one task at a time each. When the request has independent parts, spread them across different workers so they work at the same time.
- Never let two subtasks edit the same file. A trivial request may stay a single subtask.
- "instructions" must be complete and self-contained; the worker only sees that text and works in the project folder.

Reply with ONLY one JSON object, no markdown fences, in exactly this shape:
{"message":"<one short sentence to the user, in the user's language>","subtasks":[{"title":"<short title>","agent":"<worker id>","instructions":"<full instructions>"}]}`;
}

function parsePlan(reply, workers) {
  const p = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  const subtasks = (p.subtasks || []).filter((x) => x && (x.instructions || x.title)).slice(0, 5).map((x) => {
    const a = String(x.agent || '').toLowerCase();
    return { title: String(x.title || x.instructions).slice(0, 120), instructions: String(x.instructions || x.title), agent: workers.find((w) => a.includes(w)) || workers[0] };
  });
  return { message: String(p.message || ''), subtasks };
}

function finish(run, status) {
  run.active = false;
  run.paused = false;
  run.phase = 'finished';
  saveRun(status);
}

async function start(request) {
  if (S.run?.active) throw new Error('團隊正在工作中，請先等待、暫停或按 Stop');
  if (!S.project || !fs.existsSync(S.project)) throw new Error('請先選擇存在的專案資料夾');
  if (!request.trim()) throw new Error('請輸入需求');
  const lead = S.leader;
  if (!available(lead)) throw new Error(`Leader ${AGENTS[lead].name} 目前不可用`);
  if (!workersFor(lead).length) throw new Error('至少需要一位可用的 Worker');

  // A paused run stays in history (status "paused") and can be continued from there later.
  S.tasks = [];
  S.activity = [];
  const now = new Date();
  const id = now.toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomUUID().slice(0, 4);
  const run = (S.run = { id, startedAt: now.toISOString(), project: S.project, leader: lead, request, convs: {}, phase: 'planning', leaderGen: 0, active: true, paused: false, stopped: false, summarizing: false });
  log('user', 'user', request);
  log('studio', 'system', `Leader：${AGENTS[lead].name}；Workers：${workersFor(lead).map((w) => AGENTS[w].name).join('、')}`);
  planPhase(run);
}

async function planPhase(run) {
  run.phase = 'planning';
  const gen = run.leaderGen, lead = run.leader;
  try {
    const workers = workersFor(lead);
    if (!workers.length) throw new Error('至少需要一位可用的 Worker');
    const reply = await turn(lead, await conv(lead, true), planPrompt(run, workers), { lead: true });
    if (run.leaderGen !== gen) return; // a new Leader took over and plans again
    let plan;
    try { plan = parsePlan(reply, workers); } catch { throw new Error('Leader 回覆無法解析為工作清單：' + reply.slice(0, 500)); }
    if (!plan.subtasks.length) throw new Error('Leader 沒有產生任何工作：' + reply.slice(0, 500));
    log(lead, 'leader', plan.message || `已拆成 ${plan.subtasks.length} 項工作`);
    for (const st of plan.subtasks) {
      S.tasks.push({ id: crypto.randomUUID().slice(0, 8), ...st, status: 'WAITING', result: '' });
      log(lead, 'leader', `派工給 ${AGENTS[st.agent].name}：${st.title}`);
    }
    run.phase = 'working';
    pump();
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return; // pause: resume() plans again; stop: stop() already saved
    log('studio', 'system', 'Leader 失敗：' + e.message);
    finish(run, 'failed');
  }
}

// Start every WAITING task whose agent is free; when all are finished, the Leader writes the report.
function pump() {
  const run = S.run;
  if (!run?.active || run.paused || run.phase !== 'working') return;
  for (const t of S.tasks) {
    if (t.status === 'WAITING' && !S.tasks.some((x) => x.status === 'WORKING' && x.agent === t.agent)) runTask(t);
  }
  if (!run.summarizing && S.tasks.length && S.tasks.every((t) => t.status === 'DONE' || t.status === 'FAILED')) summarize(run);
}

async function runTask(t) {
  const run = S.run;
  t.status = 'WORKING';
  log(t.agent, 'worker', (t.resumed ? '繼續工作：' : '開始工作：') + t.title);
  try {
    const prompt = `You are a WORKER in "Multi-Agent Studio". Your leader (${AGENTS[run.leader].name}) assigned you this task.
Work only inside the project folder: ${run.project}
${t.resumed ? '\nYou were interrupted while doing this task earlier. First check the current state of the project folder, then finish the task without redoing work that is already done.\n' : ''}
Task: ${t.title}
Instructions:
${t.instructions}

When finished, reply with a short summary of what you did (1-3 sentences).`;
    t.result = (await turn(t.agent, await conv(t.agent, false), prompt)) || '(完成，沒有文字回覆)';
    t.status = 'DONE';
    t.doneAt = new Date().toISOString();
    log(t.agent, 'worker', t.result);
  } catch (e) {
    if (e instanceof Halt && run.paused) { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; return; }
    t.status = 'FAILED';
    t.result = e.message;
    log(t.agent, 'worker', '失敗：' + e.message);
  }
  pump();
}

async function summarize(run) {
  run.summarizing = true;
  run.phase = 'summarizing';
  const gen = run.leaderGen, lead = run.leader;
  const results = S.tasks.map((t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent].name}): ${t.result}`).join('\n');
  try {
    const txt = await turn(lead, await conv(lead, true), `You are the LEADER. The workers have finished.${handoffNote(run)}
Original user request:
"""
${run.request}
"""
Results:
${results}

Do not modify files. Write a short final report to the user (2-4 sentences, in the user's language). Plain text only.`, { lead: true });
    if (run.leaderGen !== gen) return;
    log(lead, 'leader', txt || '(沒有文字回覆)');
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return;
    log('studio', 'system', 'Leader 總結失敗：' + e.message);
  }
  run.summarizing = false;
  finish(run, S.tasks.every((t) => t.status === 'DONE') ? 'done' : 'failed');
}

function stop() {
  const run = S.run;
  if (!run?.active && !run?.paused) return;
  run.stopped = true;
  for (const cid of active.keys()) cancelTurn(cid);
  for (const t of S.tasks) if (['WAITING', 'PAUSED'].includes(t.status)) { t.status = 'FAILED'; t.result = '已停止'; }
  log('studio', 'system', '已按下 Stop：所有 Agent 停止目前工作。');
  finish(run, 'stopped');
}

function pause() {
  const run = S.run;
  if (!run?.active) throw new Error('目前沒有進行中的工作');
  run.paused = true;
  run.active = false;
  for (const cid of active.keys()) cancelTurn(cid);
  for (const t of S.tasks) if (t.status === 'WORKING') { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; }
  log('studio', 'system', '已暫停：工作卡和對話都保留，關掉 Studio 也沒關係，之後按「繼續」接著做。');
  saveRun('paused');
}

function loadRun(r) {
  S.tasks = r.tasks;
  S.activity = r.activity;
  S.run = { id: r.id, startedAt: r.startedAt, project: r.project, leader: r.leader, request: r.request, convs: r.convs || {}, phase: r.phase || 'working', leaderGen: 0, active: false, paused: true, stopped: false, summarizing: false };
  for (const [k, cid] of Object.entries(S.run.convs)) convAgent.set(cid, k.split(':')[0]);
}

function resume(id) {
  if (id && S.run?.id !== id) {
    if (S.run?.active) throw new Error('目前有進行中的工作，請先暫停或停止');
    const r = readHistory(id);
    if (r.status !== 'paused') throw new Error('這筆紀錄不是暫停中的工作');
    loadRun(r);
  }
  const run = S.run;
  if (!run?.paused) throw new Error('沒有暫停中的工作');
  if (active.size) throw new Error('Agent 還在停下中，請幾秒後再按繼續');
  if (!isDir(run.project)) throw new Error('專案資料夾不存在：' + run.project);
  if (!available(S.leader)) throw new Error(`Leader ${AGENTS[S.leader].name} 目前不可用`);
  if (run.leader !== S.leader) { run.handoffFrom = run.leader; run.leader = S.leader; }
  run.paused = false;
  run.active = true;
  for (const t of S.tasks) if (t.status === 'PAUSED') t.status = 'WAITING';
  log('studio', 'system', `繼續工作（Leader：${AGENTS[run.leader].name}）。`);
  if (run.phase === 'planning') planPhase(run);
  else if (run.phase === 'summarizing') summarize(run);
  else { run.phase = 'working'; pump(); }
}

function reassign(taskId, agent) {
  const run = S.run;
  const t = S.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這項工作');
  if (t.status === 'WORKING') throw new Error('工作進行中，請先暫停或 Stop');
  if (!available(agent)) throw new Error(`${AGENTS[agent]?.name ?? agent} 目前不可用`);
  t.agent = agent;
  t.result = '';
  log('user', 'user', `重新指派「${t.title}」給 ${AGENTS[agent].name}`);
  if (run.paused) { t.status = 'PAUSED'; saveRun('paused'); return; } // runs when the user continues
  t.status = 'WAITING';
  Object.assign(run, { active: true, stopped: false, phase: 'working' });
  pump();
}

// Changing the Leader mid-run hands the same job over; Workers keep their cards.
function setLeader(agent) {
  if (!AGENTS[agent]) throw new Error('未知的 Agent');
  if (!available(agent)) throw new Error(`${AGENTS[agent].name} 目前不可用`);
  const old = S.leader;
  if (old === agent) return;
  S.leader = agent;
  saveSettings();
  const run = S.run;
  if (!run || (!run.active && !run.paused)) return log('studio', 'system', `Leader 換成 ${AGENTS[agent].name}`);
  run.handoffFrom = run.leader;
  run.leader = agent;
  run.leaderGen++;
  const n = S.tasks.length;
  log('studio', 'system', `Leader 交接：${AGENTS[old].name} → ${AGENTS[agent].name}。新 Leader 接手原始需求${n ? `和 ${n} 張工作卡（已完成的結果保留）` : ''}，不需要重新輸入。`);
  const oldConv = run.convs[old + ':lead'];
  if (oldConv && active.has(oldConv)) cancelTurn(oldConv);
  if (run.paused) return saveRun('paused');
  if (run.phase === 'planning') planPhase(run);
  else if (run.phase === 'summarizing') summarize(run);
}

function setProject(p) {
  p = path.resolve(String(p || '').trim());
  if (!isDir(p)) throw new Error('資料夾不存在：' + p);
  if (S.run?.active) throw new Error('團隊工作中，請等工作結束再換專案');
  S.project = p;
  S.recent = [p, ...S.recent.filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 8);
  saveSettings();
}

function removeRecent(p) {
  S.recent = S.recent.filter((x) => x !== p);
  saveSettings();
}

function readProjectProgress() {
  if (!S.project) return { exists: false, text: '' };
  const file = path.join(S.project, '.ai-workspace', 'progress.md');
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

async function openInPaseo() {
  if (!fs.existsSync(PASEO_EXE)) throw new Error('這台電腦沒有安裝 Paseo');
  if (!S.project) throw new Error('請先選擇專案');
  spawn(PASEO_EXE, [], { detached: true, stdio: 'ignore' }).unref(); // opens Paseo, or brings the open window forward
  for (let i = 0; S.paseo !== 'running' && i < 20; i++) { await sleep(1500); await pollPaseo(); }
  if (S.paseo !== 'running') throw new Error('Paseo 已開啟，但它的背景服務還沒準備好，請稍後再按一次');
  const same = (p) => path.resolve(p).toLowerCase() === S.project.toLowerCase();
  if (!JSON.parse(await paseo(['workspace', 'ls', '--json'])).some((w) => same(w.cwd))) {
    await paseo(['workspace', 'create', '--isolation', 'local', '--path', S.project, '--title', path.basename(S.project), '--json']);
  }
}

// ---------- HTTP ----------
const routes = {
  'GET /api/state': () => {
    const r = S.run;
    return { ...S, ...teamStats(), agents: Object.values(S.agents), progress: readProjectProgress(),
      run: r && { id: r.id, active: r.active, stopped: r.stopped, paused: r.paused, phase: r.phase, leader: r.leader, request: r.request, project: r.project } };
  },
  'POST /api/pause': () => pause(),
  'POST /api/resume': (b) => resume(b.id),
  'POST /api/paseo/open': () => openInPaseo(),
  'POST /api/project': (b) => setProject(b.path),
  'POST /api/browse': async () => { const p = await browseFolder(); if (p) setProject(p); return { path: p }; },
  'POST /api/leader': (b) => setLeader(b.agent),
  'POST /api/start': (b) => start(String(b.request || '')),
  'POST /api/stop': () => stop(),
  'POST /api/reassign': (b) => reassign(b.taskId, b.agent),
  'POST /api/check': () => { checkAll(); },
  'POST /api/recent/remove': (b) => removeRecent(b.path),
  'POST /api/agent-config': (b) => setAgentCfg(b.agent, b.model, b.effort),
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

// Show the latest paused job again after a restart, ready to continue.
const lastPaused = historyItems().find((r) => r.status === 'paused');
if (lastPaused) loadRun(lastPaused);

await startAion();
watchCatalogs();
pollPaseo();
setInterval(pollPaseo, 10000);
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Multi-Agent Studio 已啟動：${url}  （關閉此視窗即停止）`);
  if (!process.env.STUDIO_NO_OPEN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
});
checkAll();
