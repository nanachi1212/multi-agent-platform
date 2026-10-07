// Multi-Agent Studio MVP: local web UI + AionCore as the agent runtime.
// Run: node studio/server.mjs   (or start-studio.cmd)
import http from 'node:http';
import { createWorkspaceLeaseStore } from './workspace-lease.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { cleanupRuntime, verifyRuntimeProcess, cleanupJobRuntimes, cleanupStaleRuntimes, checkPortOwnership, getProcessInfo, isPidAlive, killProcessTree, listRuntimes, registerRuntime, updateRuntime } from './runtime-registry.mjs';
import { checkBackendReadiness, recoverOwnedRuntime } from './runtime-readiness.mjs';

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

// ---------- External LLM providers ----------
// A provider (name, API format, base URL, API key, model) lives in AionCore, which stores the key encrypted and runs
// the model with its own agent loop (tools, file edits). Studio keeps only { id, name, platform, baseUrl, model, providerId }:
// never the key, so settings.json, /api/state and the logs cannot leak it.
const EXT_PLATFORMS = ['openai', 'anthropic', 'gemini'];
function registerExternal(e) {
  AGENTS[e.id] = { name: e.name, external: true, create: (ws, lead) => ({ type: 'aionrs', model: { provider_id: e.providerId, model: e.model, use_model: e.model }, extra: { workspace: ws, session_mode: lead ? 'plan' : 'yolo' } }) };
  const a = (S.agents[e.id] ??= { id: e.id, status: 'checking', note: '', working: 0, models: [], efforts: [] });
  Object.assign(a, { name: e.name, external: true, models: [{ value: e.model, name: e.model, description: '' }] });
  S.agentCfg[e.id] ??= { model: '', effort: '' };
  for (const w of S.workspaces) w.agentCfg[e.id] ??= { model: '', effort: '' };
}

// What a project does when a job is done: stop (default) | suggest next steps | auto-continue (user opts in).
const AFTER_DONE = ['stop', 'suggest', 'auto'];
const STRATEGY_IDS = ['save', 'balanced', 'quality', 'custom']; // model strategies (see STRATEGIES)
const DELIVERY_IDS = ['auto', 'pr']; // delivery: auto = all the way to merge (default), pr = stop at the pull request
const AUTO_MAX = 5; // auto-started jobs in a row before Studio stops and waits for the user
// S.leader is the default Leader for newly opened projects.
const S = { leader: 'codex', recent: [], historyRev: 0, agentCfg: {}, agents: {}, workspaces: [], leases: [], external: [],
  limits: {}, notify: true, notices: [], noticeSeq: 0, runtimes: [] };
// One workspace per project folder: its own Leader, board, team chat and run, so projects work side by side.
// name = optional display name (tabs, cards, notifications); the folder name is used when empty.
// agentCfg = this project's model / effort per agent; workers = agents allowed to work here.
// New projects start from S.agentCfg (the last choices).
const newWs = (project, leader = S.leader, name = '', agentCfg = S.agentCfg, workers = Object.keys(AGENTS)) => ({
  project, leader, name, run: null, tasks: [], activity: [], pstate: null, afterDone: 'stop', autoRounds: 0, strategy: 'save', delivery: 'auto',
  agentCfg: Object.fromEntries(Object.keys(AGENTS).map((id) => [id, { model: '', effort: '', ...agentCfg?.[id] }])),
  workers: workers.filter((id) => AGENTS[id]),
});
// An agent may be gone (an external model that was deleted); old cards still name it.
const agentName = (id) => AGENTS[id]?.name || id;
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
  for (const e of saved.external || []) if (e?.id && e.providerId && e.model) { S.external.push({ id: String(e.id), name: String(e.name || e.model), platform: e.platform, baseUrl: String(e.baseUrl || ''), isFullUrl: !!e.isFullUrl, model: String(e.model), providerId: String(e.providerId) }); registerExternal(S.external.at(-1)); }
  if (AGENTS[saved.leader]) S.leader = saved.leader;
  for (const id in S.agentCfg) Object.assign(S.agentCfg[id], saved.agentCfg?.[id]);
  // Older settings had one `project` and global models; it becomes the first open workspace with those models.
  S.workspaces = (saved.workspaces || (saved.project ? [{ project: saved.project }] : []))
    .filter((x) => isDir(x.project))
    .map((x) => Object.assign(newWs(x.project, AGENTS[x.leader] ? x.leader : S.leader, String(x.name || ''), x.agentCfg || S.agentCfg, x.workers || Object.keys(AGENTS)), { pstate: x.pstate || null, afterDone: AFTER_DONE.includes(x.afterDone) ? x.afterDone : 'stop', strategy: STRATEGY_IDS.includes(x.strategy) ? x.strategy : 'save', delivery: DELIVERY_IDS.includes(x.delivery) ? x.delivery : 'auto' }));
  S.recent = (saved.recent || []).filter(isDir);
  if (saved.notify === false) S.notify = false;
} catch (e) {
  if (e.code !== 'ENOENT') { // not a first start: the file exists but could not be used
    console.error('設定檔讀取失敗（專案分頁沒有載入）：' + e.message);
    try { fs.copyFileSync(SETTINGS, SETTINGS.replace(/.json$/, '.broken.json')); console.error('已把原檔另存成 settings.broken.json，不會被覆蓋。'); } catch { /* nothing to keep */ }
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const workspaces = S.workspaces.map((w) => ({ project: w.project, leader: w.leader, name: w.name, agentCfg: w.agentCfg, workers: w.workers, pstate: w.pstate, afterDone: w.afterDone, strategy: w.strategy, delivery: w.delivery }));
  fs.writeFileSync(SETTINGS, JSON.stringify({ leader: S.leader, workspaces, recent: S.recent, agentCfg: S.agentCfg, notify: S.notify, external: S.external }, null, 2));
}

function saveRun(w, status) {
  const run = w.run;
  if (!run) return;
  fs.mkdirSync(HISTORY, { recursive: true });
  // phase + convs let a paused run continue in the same agent conversations after a Studio restart.
  const rec = { treeStamps: run.treeStamps, treeStamp: run.treeStamp, leftAt: run.leftAt, extMod: run.extMod, claimedBy: run.claimedBy, id: run.id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), status, phase: run.phase, project: run.project, leader: run.leader, request: run.request, goal: run.goal, refs: run.refs, context: run.context, continues: run.continues, rounds: run.rounds, ask: run.ask, notes: run.notes, suggestions: run.suggestions, convs: run.convs, tasks: w.tasks, activity: w.activity };
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
  if (p.pid) {
    const args = ['--local', '--port', '0', '--data-dir', data, '--work-dir', work, '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)];
    registerRuntime({
      job_id: 'studio_core',
      purpose: 'helper',
      root_pid: p.pid,
      process_identity: await getProcessInfo(p.pid),
      executable: AION,
      command: `${AION} ${args.join(' ')}`,
      args,
      cwd: ROOT,
      rtDir: RT
    });
  }
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
  if (cfg?.model && !AGENTS[agent].external) body.extra.current_model_id = cfg.model;
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
// Stops whatever the conversation is doing (a step still waiting for a permission answer, a runaway command)
// and waits until it is idle. Returns false when it will not stop.
async function stopTurn(convId) {
  // An orphan turn (e.g. left by a timed-out step) is not in `active`: ask the conversation which turn is running.
  const turnId = active.get(convId) ?? (await api('GET', `/api/conversations/${convId}`).catch(() => ({}))).runtime?.turn_id;
  await api('POST', `/api/conversations/${convId}/cancel`, { turn_id: turnId }).catch(() => {});
  for (let k = 0; k < 10; k++) {
    const rt = (await api('GET', `/api/conversations/${convId}`).catch(() => ({}))).runtime || {};
    if (rt.state === 'idle' && !rt.is_processing) return true;
    await sleep(2000);
  }
  return false;
}

// "Conversation already running" = an older step is still busy: stop it, then send once more.
async function sendMessage(convId, text) {
  try { return await api('POST', `/api/conversations/${convId}/messages`, { content: text }); }
  catch (e) {
    if (!/already running|CONFLICT/i.test(e.message)) throw e;
    if (!(await stopTurn(convId))) throw Object.assign(e, { stuck: true, stopUnconfirmed: true });
    return api('POST', `/api/conversations/${convId}/messages`, { content: text });
  }
}

// Changes whenever the agent adds or updates a message: the sign that a long step is still making progress.
async function progressMark(convId) {
  const items = (await api('GET', `/api/conversations/${convId}/messages`)).items || [];
  const last = items.at(-1);
  return { mark: items.length + '|' + items.slice(-3).map((m) => `${m.id}:${m.status}:${m.created_at}`).join(','),
    tool: last?.type === 'tool_call' && last.status !== 'finish' ? clip(toolText(last.content), 140) : '' }; // a command that is still running
}
// conversationId -> { at: last time the agent showed progress, tool: command still running, confirm: waiting for a permission answer }
const convActivity = new Map();

const HARD_CAP_MS = 3 * 3600e3; // no single step may run longer than this
// timeout = how long the agent may show NO progress (new messages); a long job that keeps working is never cut off.
async function turn(agent, convId, text, { w, lead = false, check = false, allowStart, ask = false, timeout = 25 * 60e3, progressEvery = 30000 } = {}) {
  const run = w?.run;
  if (!check && (run?.stopped || run?.paused || allowStart && !allowStart())) throw new Halt('執行已停止');
  const sent = await sendMessage(convId, text);
  active.set(convId, sent.turn_id);
  convActivity.set(convId, { at: Date.now(), tool: '', confirm: false }); // a fresh turn starts with fresh activity
  if (!check) S.agents[agent].working++;
  let confirmedIdle = false;
  try {
    if (!check && (run?.stopped || run?.paused || allowStart && !allowStart())) throw new Halt('執行已停止');
    let mark = '', markAt = Date.now(), checkedAt = 0, tool = '';
    for (const t0 = Date.now(); ;) {
      await sleep(1500);
      const rt = (await api('GET', `/api/conversations/${convId}`)).runtime || {};
      if (rt.pending_confirmations) await answerConfirmations(w, convId, !lead);
      if (rt.state === 'idle' && !rt.is_processing) { confirmedIdle = true; break; }
      const now = Date.now();
      if (now - checkedAt >= progressEvery) {
        checkedAt = now;
        const m = await progressMark(convId).catch(() => null);
        if (m && m.mark !== mark) { mark = m.mark; markAt = now; }
        if (m) tool = m.tool;
      }
      convActivity.set(convId, { at: markAt, tool, confirm: !!rt.pending_confirmations });
      if (now - markAt > timeout || now - t0 > HARD_CAP_MS) {
        const mins = Math.round((now - markAt) / 60e3);
        confirmedIdle = await stopTurn(convId); // never leave the conversation busy: the next card on it would bounce with "already running"
        throw Object.assign(new Error(`逾時：${mins >= 1 ? mins + ' 分鐘' : '一段時間'}沒有任何新進度，Studio 已停止這一步`), { timeout: true });
      }
    }
  } catch (e) {
    if (!confirmedIdle && !(await stopTurn(convId))) e.stopUnconfirmed = true;
    throw e;
  } finally {
    active.delete(convId);
    convActivity.delete(convId);
    if (!check) S.agents[agent].working--;
    if (agent === 'codex') refreshCodexLimits();
  }
  if (!check && (run?.stopped || run?.paused)) throw new Halt(run.stopped ? '已停止' : '已暫停');
  const items = (await api('GET', `/api/conversations/${convId}/messages`)).items || [];
  const after = items.slice(items.findIndex((m) => m.id === sent.msg_id) + 1);
  // A failed tool call mid-turn is normal (agents retry); only a failed text reply means the turn failed.
  const texts = after.filter((m) => m.type === 'text' && m.position === 'left' && (ask || !isAskAnswer(m))); // a progress answer is never a card's result
  const last = texts.at(-1);
  const err = last?.status === 'error' ? last : !last && after.find((m) => m.status === 'error');
  if (err) throw new Error(String(err.content?.content ?? JSON.stringify(err.content)).slice(0, 1000));
  return String(last?.content?.content ?? '').trim();
}

// ---------- External provider operations ----------
const extOf = (id) => S.external.find((x) => x.id === id);
async function extProvider(id) {
  const e = extOf(id);
  const p = ((await api('GET', '/api/providers')) || []).find((x) => x.id === e?.providerId);
  if (!p) throw new Error('這個外部模型的供應商設定不見了（AionCore 資料被清掉？），請按「編輯」重新輸入 API key');
  return p;
}
// Error text never carries a key, even when AionCore or the provider echoes it.
const hideKey = (e, key) => { if (key && key.length > 3) e.message = e.message.split(key).join('***'); return e; };
const isLocalUrl = (u) => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(new URL(u).hostname);

function extFields(b) {
  const f = { name: String(b.name || '').trim(), platform: String(b.platform || 'openai'), baseUrl: String(b.baseUrl || '').trim().replace(/\/+$/, ''), model: String(b.model || '').trim(), isFullUrl: !!b.isFullUrl };
  if (!f.name) throw new Error('請填顯示名稱');
  if (!f.model) throw new Error('請填模型名稱');
  if (!EXT_PLATFORMS.includes(f.platform)) throw new Error('不支援的 API 格式：' + f.platform);
  let u; try { u = new URL(f.baseUrl); } catch { throw new Error('Base URL 不是有效的網址（例如 https://api.example.com/v1）'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Base URL 必須是 http:// 或 https://');
  return f;
}

// Add (no id) or change (id) an external model. A blank key on edit keeps the saved key.
async function saveExternal(b) {
  const f = extFields(b), key = String(b.apiKey || '').trim(), old = b.id ? extOf(b.id) : null;
  if (b.id && !old) throw new Error('找不到這個外部模型');
  if (old && !key && (f.baseUrl !== old.baseUrl || f.platform !== old.platform)) throw new Error('改了網址或 API 格式，請重新輸入 API key（已存的 key 不會被送到新的位址）');
  if (!old && !key && !isLocalUrl(f.baseUrl)) throw new Error('請填 API key（只有本機位址如 Ollama 可以留空）');
  const body = { platform: f.platform, name: f.name, base_url: f.baseUrl, models: [f.model], enabled: true, is_full_url: f.isFullUrl };
  if (key) body.api_key = key; else if (!old) body.api_key = 'local';
  try {
    let providerId = old?.providerId;
    if (old) await api('PUT', '/api/providers/' + providerId, body);
    else providerId = (await api('POST', '/api/providers', body)).id;
    const e = Object.assign(old || { id: 'ext_' + crypto.randomBytes(4).toString('hex') }, f, { providerId });
    if (!old) { S.external.push(e); for (const w of S.workspaces) w.workers = [...new Set([...w.workers, e.id])]; }
    registerExternal(e);
    saveSettings();
    checkAgent(e.id); // runs in the background: the card shows "checking" and then available / the reason
    return { id: e.id };
  } catch (err) { throw hideKey(err, key); }
}

async function deleteExternal(id) {
  const e = extOf(id);
  if (!e) throw new Error('找不到這個外部模型');
  const w = S.workspaces.find((x) => x.leader === id || x.run?.convs && x.tasks.some((t) => t.agent === id && !['DONE', 'FAILED'].includes(t.status)));
  if (w) throw new Error(`「${label(w)}」正在用 ${e.name}（工頭或未完成的工作卡）；先換掉或等它做完再刪除`);
  await api('DELETE', '/api/providers/' + e.providerId, {}).catch((err) => { if (!/404|not found/i.test(err.message)) throw err; });
  S.external = S.external.filter((x) => x !== e);
  if (S.leader === id) S.leader = 'codex';
  delete AGENTS[id]; delete S.agents[id]; delete S.agentCfg[id];
  for (const x of S.workspaces) { delete x.agentCfg[id]; x.workers = x.workers.filter((a) => a !== id); }
  saveSettings();
}

// Ask the provider which models it offers (the key comes from the form, or from the saved provider when editing).
async function extModels(b) {
  const f = extFields({ ...b, name: 'x', model: 'x' }), old = b.id ? extOf(b.id) : null;
  let key = String(b.apiKey || '').trim();
  if (!key && old) { // the saved key only goes to the address it was saved for
    if (f.baseUrl !== old.baseUrl || f.platform !== old.platform) throw new Error('改了網址或 API 格式，請重新輸入 API key（已存的 key 不會被送到新的位址）');
    key = (await extProvider(b.id)).api_key || '';
  }
  try { return (await api('POST', '/api/providers/fetch-models', { platform: f.platform, base_url: f.baseUrl, api_key: key || 'local' })).models || []; }
  catch (err) { throw hideKey(err, key); }
}

// ---------- Team ----------
async function checkAgent(id) {
  const a = S.agents[id], tok = (a.checkTok = {}); // a newer check (after an edit or re-test) wins over this one
  a.status = 'checking';
  a.note = '';
  try {
    const ws = path.join(RT, 'studio', 'check');
    fs.mkdirSync(ws, { recursive: true });
    // The check uses agent defaults so a bad saved model can't make the agent look unavailable.
    if (AGENTS[id].external) await extProvider(id);
    const reply = await turn(id, await createConv(id, ws, true), 'Reply with exactly: OK', { lead: true, check: true, timeout: 120e3 });
    if (!/OK/i.test(reply)) throw new Error('沒有正常回覆：' + (reply || '(空白)'));
    if (a.checkTok === tok) a.status = 'available';
  } catch (e) {
    if (a.checkTok !== tok) return;
    a.status = 'unavailable';
    a.note = e.message.slice(0, 200);
  }
}
const checkAll = () => Promise.all(Object.keys(AGENTS).map(checkAgent));
const available = (id) => S.agents[id]?.status === 'available';

// One conversation per agent and role; hard cards get their own conversation on the hard model.
// The Leader always uses the normal tier (it should be cheap: it only plans and checks).
const dirTag = (d) => (d ? '@' + crypto.createHash('sha1').update(String(d)).digest('hex').slice(0, 6) : '');
const workKey = (t) => t.agent + ':work' + (t.hard ? ':hard' : '') + dirTag(t.workdir);
async function conv(w, agent, lead, hard = false, workdir = '') {
  const key = agent + (lead ? ':lead' : ':work') + (hard ? ':hard' : '') + dirTag(workdir);
  return (w.run.convs[key] ??= await createConv(agent, workdir || w.run.project, lead, tierCfg(w, agent, hard)));
}
// This run's conversations that have a turn in progress (other projects keep working).
const busyConvs = (run) => Object.values(run.convs).filter((c) => active.has(c));

// Thrown when a turn ends because the user paused or stopped the run.
class Halt extends Error {}

const workersFor = (w, lead) => w.workers.filter((id) => id !== lead && available(id));
const cancelTurn = (cid) => api('POST', `/api/conversations/${cid}/cancel`, { turn_id: active.get(cid) }).catch(() => {});

function handoffNote(run) {
  return run.handoffFrom ? `\nYou are taking over as LEADER from ${agentName(run.handoffFrom)}. Continue the same job; do not ask the user to repeat the request.\n` : '';
}

const SUBTASK_RULES = `- Each subtask goes to exactly one worker id from the list above.
- Workers run in parallel, one task at a time each. Spread independent parts across different workers.
- Use "after" (0-based indexes of EARLIER subtasks in this list) when a subtask needs their results first, e.g. a review after the implementation, a fix after the review, a merge after the fix. Independent subtasks have no "after".
- When the request needs it, include review, verification and delivery (PR / merge) steps as their own subtasks.
- Never let two subtasks edit the same file at the same time. A trivial request may stay a single subtask.
- "instructions" must be complete and self-contained; the worker only sees that text, the results of its "after" subtasks, and the project folder.
- Mark "writes": true for a subtask that changes files, commits, pushes or switches branches; "writes": false for review, reading code, investigation and analysis. Only ONE writing card runs at a time in a project's working tree (Studio queues the others); read-only cards run alongside it. Put changes that touch the same files in sequence with "after".
- Claude Code has the smallest quota: give it a subtask only when codex and antigravity cannot do it.
- Set "hard": true only when a subtask needs deep reasoning (a tricky bug, a design across many files, a security-sensitive change). Most subtasks are not hard; hard ones run on a stronger, more expensive model.`;

// Delivery policy: how far an agent carries the work without stopping for the user.
const STOP_CONDITIONS = `a requirement so ambiguous that different readings give different product behavior; a destructive operation that could permanently lose the user's important data; a new paid service, credential, account permission or external publication; a review blocker that cannot be fixed safely inside the original scope; CI that keeps failing after a minimal fix; a merge conflict that touches uncommitted changes of the user or of another agent; anything that cannot reasonably be rolled back`;
function deliveryRules(mode, role, afterDone = 'stop') {
  const ask = role === 'worker' ? 'report STATUS: NEEDS_USER' : 'use needs_user';
  const stops = `Stop and ask the user (${ask}) ONLY for: ${STOP_CONDITIONS}. Side problems that are not blockers: note them in one line and move on.`;
  const triage = `Review triage (the Leader's rule; ask the user about none of it): a Blocker or P1 finding is always fixed. A P2 that is directly caused by or inside what this PR changes is fixed. Every other P2 and every P3 is NOT fixed: record it in one line each (in the PR description or the card result, under "Recorded, not fixed") and keep delivering. Fix inside the original PR scope with a regression test and targeted validation, then run CI again. Review ONCE: after the fixes do not ask for another full review; only a Blocker/P1, or a problem your own fix introduced, may reopen the loop. At most two fix rounds; a Blocker/P1 that is still open after the second one counts as a review blocker that cannot be fixed safely in scope: stop and ask the user.`;
  if (mode === 'pr') {
    return `Delivery policy (stop at the pull request): when the request is clear and nothing high-risk is involved, carry the work through change -> targeted validation -> commit -> push -> pull request -> CI without stopping, then report. Do NOT merge: the user merges. ${role === 'leader' ? 'Give the whole chain to ONE worker card (it parks on CI with STATUS: WAITING_EXTERNAL and the PR URL, and continues when woken).' : ''} ${stops}`;
  }
  const chain = 'change -> targeted validation -> commit -> push -> pull request -> CI -> one review (the repository\'s own review bot if it has one, otherwise one independent review by a different worker) -> fix by the review triage below -> CI again -> squash merge -> sync main -> clean up: delete this PR\'s branch (and its worktree, if Studio made one) now that it is merged -> next card';
  const how = role === 'leader' ? `Plan the whole chain, not just the code: give it to ONE worker card (that worker parks the card on CI with STATUS: WAITING_EXTERNAL and the PR URL, and continues when woken); add a review card for a different worker only when the repository has no review bot.`
    : role === 'check' ? 'A request that changes a repository is complete only when the work is delivered (merged, main synced, branch deleted); if it is not, add cards for the missing steps instead of reporting it done or asking the user. Findings that were recorded as not fixed (other P2, P3) are NOT a reason to add cards or to ask for another review: list them briefly in your report under "Recorded, not fixed"' + (afterDone === 'stop' ? '.' : ', and use the worthwhile ones as candidates for the next steps.')
    : 'Carry YOUR card through this chain; when CI is pending report STATUS: WAITING_EXTERNAL with the PR URL instead of waiting inside your turn. In your final reply list the findings you did not fix under "Recorded, not fixed".';
  return `Delivery policy (autonomous): when the request is clear and nothing high-risk is involved, carry the work all the way to delivery: ${chain}. Do NOT stop because of a commit, a push, opening a PR, green CI or a normal merge. Never bypass required checks (no --admin); merge only when checks are green (a repository without checks: after validation and review). If the folder is not a Git repository or has no GitHub remote, skip the steps that need one and never create a remote. ${how} ${triage} ${stops}`;
}

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

const SUBTASK_SHAPE = `{"title":"<short title>","agent":"<worker id>","instructions":"<full instructions>","after":[<indexes>],"hard":false,"writes":true}`;

function planPrompt(run, workers, delivery) {
  return `You are the LEADER (foreman) of a small AI team in "Multi-Agent Studio".
Project folder: ${run.project}
Workers you can assign: ${workers.map((w) => `${w} (${agentName(w)})`).join(', ')}
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
${deliveryRules(delivery, 'leader')}
${SUBTASK_RULES}

Reply with ONLY one JSON object, no markdown fences, in exactly this shape:
{"message":"<one short sentence to the user, in the user's language; for a continuation say where the project stands (PR / CI state) and where you pick up>","subtasks":[${SUBTASK_SHAPE}]}`;
}

const parseJson = (reply) => JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));

function parseSubtasks(list, workers) {
  return (list || []).filter((x) => x && (x.instructions || x.title)).slice(0, 6).map((x, i) => {
    const a = String(x.agent || '').toLowerCase();
    const after = (Array.isArray(x.after) ? x.after : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i);
    return { hard: x.hard === true, writes: x.writes !== false, title: String(x.title || x.instructions).slice(0, 120), instructions: String(x.instructions || x.title), agent: workers.find((w) => a.includes(w)) || workers[0], after };
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
    w.tasks.push({ id: ids[i], hard: st.hard, writes: st.writes, title: st.title, instructions: st.instructions, agent: st.agent, after: st.after.map((n) => ids[n]), status: 'WAITING', result: '' });
    log(w, lead, 'leader', `派工給 ${agentName(st.agent)}：${st.title}${st.after.length ? `（等「${st.after.map((n) => subtasks[n].title).join('」「')}」完成後開始）` : ''}`);
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
  log(w, 'studio', 'system', `「${t.title}」等待的結果到了，交回 ${agentName(t.agent)} 繼續。`);
  pump(w);
}

// When a card ends (done or failed), cards waiting on that agent get its result.
function wakeWaiters(w, done) {
  for (const t of w.tasks) {
    if (t !== done && t.status === 'WAITING_AGENT' && t.wait?.agent === done.agent) {
      wake(w, t, `${agentName(done.agent)} finished "${done.title}" (${done.status}). Their result:\n${done.result}`);
    }
  }
}

function finish(w, status) {
  const run = w.run, finishedCards = [...w.tasks];
  run.active = false;
  run.paused = false;
  run.phase = 'finished';
  markRuntimeStops(w);
  releaseJobLeases(w, 'job ended');
  if (typeof cleanupJobRuntimes === 'function') {
    run.runtimeCleanup = Promise.all([...w.recoverySteps?.values() || [], ...w.runtimeStarts?.values() || []].map((step) => step.catch(() => {}))).then(() => cleanupCardRuntimes(w, finishedCards, run.id)).then(() => {
      if (w.run === run) { releaseJobLeases(w, 'runtime stopped'); saveRun(w, status); }
    }).catch((error) => log(w, 'studio', 'system', error.message));
  }

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
      : `${label(w)}：${agentName(failed?.agent ?? run.leader)} 需要你處理`;
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
  start(w, next.request, true, true).then(() => log(w, 'studio', 'system', `自動持續開發（第 ${w.autoRounds}/${AUTO_MAX} 件）：工頭選了「${next.title}」`))
    .catch((e) => log(w, 'studio', 'system', '自動開始下一步失敗：' + e.message));
}

function setDelivery(w, mode) {
  if (!DELIVERY_IDS.includes(mode)) throw new Error('未知的交付方式');
  w.delivery = mode;
  saveSettings();
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
  const card = (t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent]?.name || t.agent}): ${clip(t.result, 400)}${t.status === 'FAILED' && t.detail ? ` [technical reason: ${clip(t.detail, 160)}]` : ''}`
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

async function start(w, request, cont = false, inherit = false) {
  // "繼續…" / the 接著上次的工作 button continue the latest job instead of starting from zero.
  cont = cont || CONTINUE_RE.test(request);
  if (cont && w.run?.paused) return resume(w); // the paused job itself picks up where it stopped
  if (w.run?.active) throw new Error('這個專案的團隊正在工作中，請先等待、暫停或按 Stop');
  if (w.executingSteps?.size || w.recoverySteps?.size || w.runtimeStarts?.size || w.tasks.some((t) => t.stopUnconfirmed || t.runtimeStopPending)) throw new Error('Agent 還在停下中，不能啟動新工作');
  if (!isDir(w.project)) throw new Error('專案資料夾不存在：' + w.project);
  if (!request.trim()) throw new Error('請輸入需求');
  const lead = w.leader;
  if (!available(lead)) throw new Error(`Leader ${agentName(lead)} 目前不可用`);
  if (!workersFor(w, lead).length) throw new Error('這個專案至少需要一位可用的 Worker');

  const prev = latestJob(w);
  const continues = cont && (!!prev || ['open', 'wait', 'need'].includes(w.pstate?.level));
  const context = projectContext(w);
  // A paused run stays in history (status "paused") and can be continued from there later.
  w.tasks = [];
  w.activity = [];
  const now = new Date();
  const id = now.toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomUUID().slice(0, 4);
  // Auto-continue inherits the fingerprint of the tree the last job left, so changes made in between are noticed.
  w.run = { treeStamp: inherit ? prev?.run?.treeStamp : undefined, leftAt: inherit ? prev?.run?.leftAt : undefined, id, startedAt: now.toISOString(), project: w.project, leader: lead, request, convs: {}, phase: 'planning', leaderGen: 0, rounds: 0, ask: null, continues, context, goal: continues ? prev.run.goal || prev.run.request : request, refs: continues ? knownRefs(prev) : [], active: true, paused: false, stopped: false, summarizing: false };
  log(w, 'user', 'user', request);
  if (continues) log(w, 'studio', 'system', '接續上次的工作：工頭會拿到目前的進度摘要，不用重講。', context);
  log(w, 'studio', 'system', `Leader：${agentName(lead)}；Workers：${workersFor(w, lead).map((x) => agentName(x)).join('、')}`);
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
    let reply = await turn(lead, cid, planPrompt(run, workers, w.delivery), { w, lead: true });
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
  const order = [...w.tasks].sort((a, b) => (b.wakeNote ? 1 : 0) - (a.wakeNote ? 1 : 0));
  for (const t of order) {
    if (t.status !== 'WAITING') continue;
    const deps = (t.after || []).map(byId).filter(Boolean);
    if (deps.some((d) => d.status === 'FAILED')) { Object.assign(t, { status: 'FAILED', result: '前一張工作卡失敗，這張沒有開始；交給工頭決定下一步。' }); continue; }
    if (deps.some((d) => d.status !== 'DONE')) continue;
    if (!t.hold && !w.executingSteps?.has(t.id) && !w.tasks.some((x) => x.status === 'WORKING' && x.agent === t.agent) && !(isWriter(t) && writerBusy(w, t))) runTask(w, t);
  }
  // Cards that only wait on each other would wait forever.
  const onAgents = w.tasks.filter((t) => t.status === 'WAITING_AGENT');
  if (onAgents.length && !w.tasks.some((t) => ['WORKING', 'WAITING', 'WAITING_EXTERNAL', 'NEEDS_USER'].includes(t.status))) {
    for (const t of onAgents) wake(w, t, 'Everyone you could wait for is waiting too or has finished, so nothing more will arrive. Continue with what you have, or report NEEDS_USER.');
  }
  if (!run.summarizing && w.tasks.length && w.tasks.every((t) => t.status === 'DONE' || t.status === 'FAILED')) summarize(w);
}

// ---------- Workspace lease: who may write which working tree ----------
// A lease records WHO holds a physical working tree, doing WHAT (job / card), on which branch, and whether the holder
// is still alive. Leases are persisted (runtime/studio/leases.json), so after a restart Studio still knows who held a
// tree. One working tree has at most ONE write lease; any number of read leases. Different worktrees of one repository
// are different trees and can each have a writer.
//   write lease status: ACTIVE (the owner is executing) / RESERVED (paused or waiting, still the owner's) /
//   STALE (the owner is gone: crashed Studio, dead pid, silent too long) / RELEASED.
// Studio never takes a lease from a live owner; a STALE lease is retired when somebody reclaims it.
const INSTANCE = crypto.randomUUID().slice(0, 8);
const LOCK_STALE_MS = 3 * 60e3, RECENT_EDIT_MS = 90e3, LOCK_BEAT_MS = 30e3;
const LEASE_BEAT_MS = 20e3, LEASE_HUNG_MS = 30 * 60e3, LEASE_RESERVED_TTL_MS = 12 * 3600e3;
const isWriter = (t) => t.writes !== false;
const sameTree = (a, b) => (a.workdir || '') === (b.workdir || '');
const holdsWriteLock = (t) => isWriter(t) && ['WORKING', 'WAITING_EXTERNAL', 'NEEDS_USER'].includes(t.status);
const writerBusy = (w, t) => w.tasks.some((x) => x !== t && sameTree(x, t) && holdsWriteLock(x));
const nowIso = () => new Date().toISOString();

function accessRules(t) {
  if (!isWriter(t)) return 'ACCESS: READ-ONLY card. Another card may be editing this working tree at the same time. Read files and run read-only commands (git log / diff / show, gh pr view / diff, searches). Do NOT modify, create or delete files in the working tree and do not run commands that change it (no commit, checkout, switch, stash, pull, merge, rebase, reset, formatters, installs). You may post review comments with gh. If something must change, say exactly what in your reply; do not change it yourself.';
  if (t.worktree) return `ACCESS: you work in your own git worktree ${t.workdir} on branch ${t.worktree.branch}. Commit and push from there; never touch the main working tree. Do not leave it half changed when you finish or wait.`;
  return 'ACCESS: you are the only one allowed to modify this working tree right now; other cards only read. Do not leave it half changed when you finish or wait: commit, or say clearly what is uncommitted. All file changes must happen inside your own turn: never leave a background process that changes files after your turn ends (Studio treats changes made while you are not running as changes by another party).';
}

// ----- identity of a working tree -----
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const canonPath = (p) => { let r = String(p || ''); try { r = fs.realpathSync.native(r); } catch { r = path.resolve(r); } return r.replace(/[\\/]+$/, ''); };
const treeKey = (p) => { const c = canonPath(p).split('/').join('\\'); return process.platform === 'win32' ? c.toLowerCase() : c; };

// The physical working tree a folder belongs to: key (same for any spelling of the path), top folder, branch, repository.
async function workspaceOf(dir) {
  const top = (await git(dir, 'rev-parse', '--show-toplevel')).out?.trim();
  const base = top || dir;
  return { key: treeKey(base), path: canonPath(base), isGit: !!top,
    branch: top ? (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).out?.trim() || '' : '', repo: top ? await originRepo(dir) || canonPath((await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')).out?.trim() || top) : '' };
}

const { mergeLeasesFromDisk, saveLeases, loadLeases, withLeaseTransaction, leaseState, writerOf, retire, ownerName, sameCard, leaseView, newLease, acquireWrite, acquireRead, cardLeases, releaseCardLeases, reserveCardLeases, releaseJobLeases, reserveJobLeases, beatLeases } = createWorkspaceLeaseStore({ fs, path, crypto, S, RT, INSTANCE, AGENTS, nowIso, pidAlive, LEASE_HUNG_MS, LEASE_RESERVED_TTL_MS });

// ----- file mirror in the git dir (so programs that know nothing about Studio can see a writer) -----
async function lockFile(w, dir = w.project) {
  w.lockPaths ||= {};
  if (w.lockPaths[dir] === undefined) { const r = await git(dir, 'rev-parse', '--absolute-git-dir'); w.lockPaths[dir] = r.out ? path.join(r.out.trim(), 'studio-writer.lock') : null; }
  return w.lockPaths[dir];
}
async function foreignLock(w, dir = w.project) {
  const f = await lockFile(w, dir);
  if (!f) return null;
  let l;
  try { l = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  if (l.status === 'EXTERNAL') return l;
  if (l.instance === INSTANCE) return null;
  let alive = true;
  try { process.kill(l.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
  return alive && Date.now() - Date.parse(l.beat || 0) < LOCK_STALE_MS ? l : null;
}
async function acquireLock(w, t) {
  const dir = (await workspaceOf(t.workdir || w.project)).path, f = await lockFile(w, dir);
  if (!f) return;
  const key = treeKey(dir);
  const record = { owner: 'Multi-Agent Studio', instance: INSTANCE, pid: process.pid, project: dir, card: t.title, since: nowIso(), beat: nowIso() };
  let fd;
  try { fd = fs.openSync(f, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (old.status === 'EXTERNAL' || old.instance !== INSTANCE && pidAlive(old.pid) && Date.now() - Date.parse(old.beat || 0) < LOCK_STALE_MS)
      throw new Error('Workspace writer lock is held by another owner');
    // Same-directory installers also serialize stale mirror recovery via an exclusive recovery marker.
    const recovery = fs.openSync(f + '.reclaim', 'wx');
    try {
      const current = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (current.status === 'EXTERNAL' || current.instance !== INSTANCE && pidAlive(current.pid) && Date.now() - Date.parse(current.beat || 0) < LOCK_STALE_MS)
        throw new Error('Workspace writer lock is held by another owner');
      fs.unlinkSync(f); fd = fs.openSync(f, 'wx');
    } finally { fs.closeSync(recovery); fs.unlinkSync(f + '.reclaim'); }
  }
  try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
  w.lockTimers ||= new Map();
  clearInterval(w.lockTimers.get(key));
  const timer = setInterval(() => {
    try {
      const old = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (old.instance !== INSTANCE || old.status === 'EXTERNAL') { flagExternalModification(w, '寫入鎖已由其他程式接手'); return; }
      record.beat = nowIso(); fs.writeFileSync(f, JSON.stringify(record));
    } catch { flagExternalModification(w, '無法確認工作區寫入鎖'); }
  }, LOCK_BEAT_MS);
  timer.unref?.(); w.lockTimers.set(key, timer);
}
async function releaseLock(w, t) {
  const dir = (await workspaceOf(t?.workdir || w.project)).path, key = treeKey(dir);
  if (S.leases.some((l) => l.key === key && l.mode === 'write' && l.status !== 'RELEASED' && l.instance === INSTANCE)) return;
  clearInterval(w.lockTimers?.get(key)); w.lockTimers?.delete(key);
  const f = await lockFile(w, dir);
  if (!f) return;
  try { if (JSON.parse(fs.readFileSync(f, 'utf8')).instance === INSTANCE) fs.unlinkSync(f); } catch { /* no lock of ours */ }
}

// ----- what the tree looks like (read-only git) -----
async function treeStamp(w, dir = w.project) {
  const st = await git(dir, 'status', '--porcelain=v1');
  if (st.err) { if (!(await lockFile(w, dir))) return ''; throw new Error('無法讀取 workspace git status'); }
  const head = (await git(dir, 'rev-parse', 'HEAD')).out?.trim() || '';
  const branch = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).out?.trim() || '';
  const files = await git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  if (files.err) throw new Error('無法讀取 workspace snapshot');
  const metadata = [...new Set(files.out.split('\0').filter(Boolean))].sort().map((p) => {
    try { const st = fs.lstatSync(path.join(dir, p)); return [p, st.size, st.mtimeMs, st.ctimeMs]; }
    catch (e) { if (e.code === 'ENOENT') return [p, 'deleted']; throw e; }
  });
  return crypto.createHash('sha1').update(head + '\n' + branch + '\n' + st.out + JSON.stringify(metadata)).digest('hex');
}
// A file the working tree has changed after Studio last wrote, and only seconds ago: someone is editing now.
async function recentEdit(w, sinceMs, dir = w.project) {
  const st = await git(dir, '-c', 'core.quotepath=false', 'status', '--porcelain=v1');
  if (st.err) return null;
  let newest = null;
  for (const line of st.out.split('\n').filter(Boolean).slice(0, 200)) {
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    try { const m = fs.statSync(path.join(dir, p.replace(/^"|"$/g, ''))).mtimeMs; if (!newest || m > newest.m) newest = { m, p }; } catch { /* deleted file */ }
  }
  const age = newest ? Date.now() - newest.m : Infinity;
  return newest && newest.m > sinceMs && age < RECENT_EDIT_MS ? { file: newest.p, secs: Math.round(age / 1000) } : null;
}

// Extra checks before a writer starts, once the lease is ours.
// null = go; busy = somebody is editing right now (wait); changed = the tree changed while Studio was away (ask).
async function externalReason(w, t) {
  const dir = (await workspaceOf(t.workdir || w.project)).path;
  if (!(await lockFile(w, dir))) return null; // not a git project: nothing to compare with
  const lock = await foreignLock(w, dir);
  if (lock) return { kind: 'busy', text: `${lock.owner || '另一個程式'} 正在修改這個專案（鎖定檔：${lock.card || '進行中'}）` };
  if (w.tasks.some((x) => x !== t && treeKey(x.workdir || w.project) === treeKey(dir) && holdsWriteLock(x))) return null; // our own writer is active
  const run = w.run;
  const recent = await recentEdit(w, Date.parse(run.leftAt || run.startedAt) || 0, dir);
  if (recent) return { kind: 'busy', text: `${recent.secs} 秒前有檔案被改過（${recent.file}），可能有別的 AI 或程式正在修改這個專案` };
  const baseline = run.treeStamps?.[treeKey(dir)] || (!t.workdir && run.treeStamp);
  if (!t.trust && baseline && (await treeStamp(w, dir)) !== baseline) return { kind: 'changed', text: 'Studio 離開期間，這個專案的檔案、分支或 commit 被改過（不是這一輪工作改的）' };
  return null;
}

function holderText(l) {
  const v = leaseView(l);
  return `此工作區目前由 ${v.owner} ${v.state === 'ACTIVE' ? '使用中' : '保留中'}${v.card ? `（工作卡「${v.card}」）` : ''}${v.branch ? `，branch ${v.branch}` : ''}，${new Date(v.since).toLocaleTimeString('zh-TW', { hour12: false })} 開始`;
}
function retryLater(w) {
  clearTimeout(w.retryTimer);
  w.retryTimer = setTimeout(() => pump(w), 30e3);
  w.retryTimer.unref?.();
}

// Returns true when the card may start now (lease taken); otherwise the card is parked with the reason and nothing is written.
async function takeWriteSlot(w, t) {
  const dir = t.workdir || w.project;
  const info = await workspaceOf(dir);
  if (!t.workdir) w.wsKey = info.key; // the project's own tree: lets the page find its leases
  if (!isWriter(t)) { acquireRead(w, t, info); return true; } // reading never needs the lease
  const got = await acquireWrite(w, t, info);
  if (!got.ok) { // never steal a live lease: say who has it and offer the ways out
    const text = holderText(got.holder);
    Object.assign(t, { status: 'WAITING', blockReason: text, blocked: leaseView(got.holder) });
    if (t.blockLogged !== text) { t.blockLogged = text; log(w, 'studio', 'system', `「${t.title}」先不動：${text}。可以等它做完、改成唯讀 Review、或使用獨立 worktree。`); }
    retryLater(w);
    return false;
  }
  const why = await externalReason(w, t);
  if (!why) { Object.assign(t, { trust: false, blockReason: '', blockLogged: '', blocked: null }); await acquireLock(w, t); return true; }
  if (why.kind === 'busy') {
    if (got.reused) Object.assign(got.lease, { status: 'RESERVED', reason: 'waiting: ' + why.text }); else retire(got.lease, 'not started: ' + why.text); // a lease the card already owned stays reserved
    saveLeases();
    Object.assign(t, { status: 'WAITING', blockReason: why.text, blocked: null });
    if (t.blockLogged !== why.text) { t.blockLogged = why.text; log(w, 'studio', 'system', `「${t.title}」先不動：${why.text}。等對方做完，Studio 每 30 秒再看一次。`); }
    retryLater(w);
    return false;
  }
  reserveCardLeases(w, t, 'asking the user'); // the lease stays ours while the user decides
  Object.assign(t, { status: 'NEEDS_USER', takeover: true, ask: { question: why.text + '。要讓 Studio 接手繼續寫嗎？', options: ['確認接手，繼續', '先不要（暫停）'] } });
  log(w, 'studio', 'system', `「${t.title}」先不動：${why.text}。需要你決定要不要讓 Studio 接手。`);
  notify(`${label(w)}：${agentName(t.agent)} 需要你處理`, why.text, 'ask', w.project);
  return false;
}

// After a writing step: remember what the tree looks like, and keep or give back the lease of the agent that ran the step.
async function endWriteStep(w, t, ranAs = t.agent) {
  if (!isWriter(t)) { releaseCardLeases(w, t, 'read finished', ranAs); return; }
  if (w.run?.paused || w.run?.stopped || ['DONE', 'FAILED'].includes(t.status)) await w.runtimeStarts?.get(t.id)?.catch(() => {});
  if (typeof cleanupJobRuntimes === 'function' && (w.run?.paused || w.run?.stopped || ['DONE', 'FAILED'].includes(t.status))) {
    try { await cleanupCardRuntimes(w, [t]); }
    catch { t.runtimeStopPending = true; }
  }
  if (t.stopUnconfirmed || t.runtimeStopPending) { reserveCardLeases(w, t, 'runtime stop unconfirmed', ranAs); return; }
  if (w.run) {
    const dir = (await workspaceOf(t.workdir || w.project)).path, stamp = await treeStamp(w, dir);
    (w.run.treeStamps ||= {})[treeKey(dir)] = stamp;
    if (!t.workdir) w.run.treeStamp = stamp;
    w.run.leftAt = nowIso();
  }
  if (t.agent !== ranAs) releaseCardLeases(w, t, 'handed off', ranAs); // the card moved on while this step was ending: not our lease any more
  else if (w.run?.stopped) releaseCardLeases(w, t, 'stopped', ranAs);
  else if (w.run?.paused) reserveCardLeases(w, t, 'paused', ranAs);
  else if (holdsWriteLock(t)) reserveCardLeases(w, t, 'waiting', ranAs);
  else releaseCardLeases(w, t, 'card finished', ranAs);
  if (!w.tasks.some((x) => holdsWriteLock(x) && sameTree(x, t))) await releaseLock(w, t);
}

async function runTask(w, t) {
  const ranAs = t.agent;
  let settleStep;
  w.executingSteps ||= new Map();
  w.executingSteps.set(t.id, { agent: ranAs, done: new Promise((resolve) => { settleStep = resolve; }) });
  w.stepsInFlight = (w.stepsInFlight || 0) + 1; // from now until the lease is settled, the watcher must not call our own edits "unknown"
  try {
    t.status = 'WORKING'; // reserve the slot at once: no second writer may start while the checks below run
    if (!(await takeWriteSlot(w, t))) return;
    if (!w.run?.active || t.status !== 'WORKING') { // paused or stopped while the check ran
      if (t.status === 'WORKING') Object.assign(t, w.run?.stopped ? { status: 'FAILED', result: '已停止' } : { status: 'PAUSED', result: '已暫停', resumed: true });
      await endWriteStep(w, t, ranAs);
      return;
    }
    try { await runCard(w, t); } finally { await endWriteStep(w, t, ranAs); }
    if (t.status === 'DONE' && t.worktree) await cleanupWorktree(w, t);
  } catch (e) {
    Object.assign(t, { status: w.run?.stopped ? 'FAILED' : 'PAUSED', result: w.run?.stopped ? '已停止' : e.message, resumed: true });
    if (w.run?.active) pause(w);
    log(w, 'studio', 'system', '工作區檢查失敗，未啟動 Agent：' + e.message);
    saveRun(w, w.run?.stopped ? 'stopped' : 'paused');
  } finally { w.stepsInFlight--; w.executingSteps.delete(t.id); settleStep(); }
  pump(w);
  for (const x of S.workspaces) if (x !== w && x.run?.active) pump(x); // a lease was just given back: jobs that were refused can go now
}

// ----- resume safety: a job may only continue writing if the tree is still its own -----
async function leaseBlocker(w) {
  mergeLeasesFromDisk();
  for (const t of w.tasks) {
    if (!isWriter(t) || ['DONE', 'FAILED'].includes(t.status)) continue; // every unfinished writing card will write again
    const cur = writerOf((await workspaceOf(t.workdir || w.project)).key);
    if (cur && !sameCard(cur, w, t) && !(cur.owner.kind === 'studio' && cur.jobId === w.run?.id && w.tasks.some((x) => sameCard(cur, w, x)))) return cur;
  }
  return null;
}

// Runtime ownership hook: stopTurn must confirm cancellation, then all card cleanup must finish.
function markRuntimeStops(w) {
  for (const task of w.tasks) if (w.recoverySteps?.has(task.id) || w.runtimeStarts?.has(task.id)) task.runtimeStopPending = true;
  if (typeof listRuntimes !== 'function') return;
  for (const runtime of listRuntimes({ rtDir: RT })) if (runtime.job_id === w.run?.id && ['running', 'exited', 'stale'].includes(runtime.status)) {
    const task = w.tasks.find((t) => t.id === runtime.card_id);
    if (task) task.runtimeStopPending = true;
  }
}
async function cleanupCardRuntimes(w, cards, jobId = w.run.id) {
  if (typeof cleanupJobRuntimes !== 'function') return;
  const result = await cleanupJobRuntimes(jobId, { rtDir: RT, cardIds: cards.map((t) => t.id) });
  if (result.blocked?.length) {
    for (const t of cards) t.runtimeStopPending = true;
    throw new Error('Runtime 尚未確認停止；保留租約: ' + result.blocked.map((r) => r.reason).join('; '));
  }
  for (const t of cards) t.runtimeStopPending = false;
}

async function drainExecution(w, cards = w.tasks) {
  const pending = cards.map((t) => w.executingSteps?.get(t.id)).filter(Boolean);
  const cids = [...new Set([...(cards === w.tasks ? busyConvs(w.run) : []), ...cards.map((t) => w.run.convs[workKey(t)]).filter(Boolean)])];
  const stopped = await Promise.all(cids.map((cid) => stopTurn(cid)));
  if (stopped.some((ok) => !ok)) throw new Error('Agent 還沒有真的停下來；保留寫入租約');
  let timer;
  try {
    await Promise.race([Promise.all(pending.map((step) => step.done)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Agent 還在停下中；保留寫入租約')), 20000);
    })]);
  } finally { clearTimeout(timer); }
  await Promise.all(cards.flatMap((t) => [w.recoverySteps?.get(t.id), w.runtimeStarts?.get(t.id)]).filter(Boolean));
  await w.run.runtimeCleanup;
  await cleanupCardRuntimes(w, cards);
  for (const t of cards) t.stopUnconfirmed = false;
}
async function pauseAndDrain(w) { pause(w); await drainExecution(w); saveRun(w, 'paused'); }
async function stopAndDrain(w) {
  stop(w); await drainExecution(w); releaseJobLeases(w, 'stopped');
  for (const t of w.tasks) if (isWriter(t)) await releaseLock(w, t);
  saveRun(w, 'stopped');
}

// ----- external takeover: another AI session / the user takes the tree -----
// Studio stops its own writers on that tree (and waits until they really stopped), gives up its leases and records the
// external owner. The paused Studio jobs stay paused: a restart never brings them back, and 繼續 is refused while the claim lasts.
async function claimWorkspace(dir, who = {}) {
  const info = await workspaceOf(dir);
  const labelText = String(who.label || 'external').slice(0, 60);
  const mirrorWs = { project: info.path }, mirror = await lockFile(mirrorWs);
  const jobs = new Set();
  for (const w of S.workspaces) {
    if (!w.run) continue;
    for (const t of w.tasks) if (isWriter(t) && (await workspaceOf(t.workdir || w.project)).key === info.key) jobs.add(w);
  }
  for (const w of jobs) {
    if (w.run.active) pause(w);
    await drainExecution(w);
    w.run.claimedBy = labelText;
  }
  const existingMirror = mirror && await foreignLock(mirrorWs);
  if (existingMirror?.status !== 'EXTERNAL') await acquireLock(mirrorWs, { title: 'External takeover' });
  try { return withLeaseTransaction(() => {
  const holder = writerOf(info.key);
  if (holder?.owner.kind === 'studio' && holder.instance !== INSTANCE && (pidAlive(holder.pid) || ![...jobs].some((w) => w.run.id === holder.jobId))) throw new Error('另一個 Studio 仍持有寫入租約，請先停止該 Agent');
  for (const l of S.leases) if (l.key === info.key && l.mode === 'write' && l.status !== 'RELEASED' && l.owner.kind === 'studio') retire(l, `外部接手：${labelText}`);
  let ext = S.leases.find((l) => l.key === info.key && l.owner.kind === 'external' && l.status !== 'RELEASED');
  if (!ext) { ext = { id: crypto.randomUUID().slice(0, 8), key: info.key, path: info.path, repo: info.repo, mode: 'write', owner: { kind: 'external' }, acquiredAt: nowIso() }; S.leases.push(ext); }
  Object.assign(ext, { owner: { kind: 'external', label: labelText }, branch: info.branch, pid: who.pid || null, status: 'EXTERNAL', worktree: info.path, provider: 'external', session: who.session || '', heartbeatAt: nowIso(), reason: who.description || who.note || '' });
  if (mirror) {
    let current;
    try { current = JSON.parse(fs.readFileSync(mirror, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current?.status === 'EXTERNAL' && current.leaseId !== ext.id) throw new Error('工作區已由另一個 external claim 持有');
    if (current && current.status !== 'EXTERNAL' && current.instance !== INSTANCE && pidAlive(current.pid) && Date.now() - Date.parse(current.beat || 0) < LOCK_STALE_MS)
      throw new Error('另一個 Studio 仍持有寫入鎖');
    fs.writeFileSync(mirror, JSON.stringify({ owner: labelText, status: 'EXTERNAL', leaseId: ext.id, branch: info.branch, beat: nowIso() }));
  }
  saveLeases();
  for (const w of jobs) { clearWorkspaceLockTimer(w, info.key); }
  for (const w of jobs) log(w, 'studio', 'system', `工作區已由外部（${labelText}）接手：Studio 的寫入已停止，這件工作保持暫停。外部歸還後，由你按「繼續」。`);
  for (const w of jobs) saveRun(w, 'paused');
  return leaseView(ext);
  }); } finally { clearWorkspaceLockTimer(mirrorWs, info.key); }
}
function clearWorkspaceLockTimer(w, key) { clearInterval(w.lockTimers?.get(key)); w.lockTimers?.delete(key); }
async function releaseClaim(dir) {
  const info = await workspaceOf(dir);
  const mirror = await lockFile({ project: info.path });
  return withLeaseTransaction(() => {
  let n = 0;
  const ids = S.leases.filter((l) => l.key === info.key && l.owner.kind === 'external' && l.status !== 'RELEASED').map((l) => l.id);
  if (mirror) {
    try { const current = JSON.parse(fs.readFileSync(mirror, 'utf8')); if (current.status === 'EXTERNAL' && ids.includes(current.leaseId)) fs.unlinkSync(mirror); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const l of S.leases) if (l.key === info.key && l.owner.kind === 'external' && l.status !== 'RELEASED') { retire(l, '外部已歸還'); n++; }
  saveLeases();
  return { released: n };
  });
}

// ----- formal handoff: the writer role of a card moves from one agent to another -----
function writerHandoffNote(from, to, prior) {
  return `HANDOFF: ${agentName(from)} was working on this card and has been stopped by the user's handoff; you (${agentName(to)}) take over the SAME working tree and branch. First check git status / log and the files, continue from where it stopped, do not redo finished work and do not open a duplicate PR. ${agentName(from)} no longer writes here.${prior ? `\nIts last report: ${prior}` : ''}`;
}
async function lastAgentText(cid) {
  if (!cid) return '';
  try { const items = (await api('GET', `/api/conversations/${cid}/messages`)).items || []; const m = items.filter((x) => x.type === 'text' && x.position === 'left' && !isAskAnswer(x)).at(-1); return clip(m?.content?.content || '', 700); } catch { return ''; }
}
async function handoffWriter(w, toAgent, taskId) {
  if (!AGENTS[toAgent]) throw new Error('未知的 Agent');
  if (!available(toAgent)) throw new Error(`${agentName(toAgent)} 目前不可用`);
  const run = w.run;
  if (!run) throw new Error('這個專案目前沒有工作可以交接');
  const held = S.leases.find((l) => l.mode === 'write' && l.jobId === run.id && ['ACTIVE', 'RESERVED'].includes(leaseState(l)));
  const t = taskId ? w.tasks.find((x) => x.id === taskId) : held && w.tasks.find((x) => x.id === held.cardId);
  if (!t) throw new Error('目前沒有人在這個工作區寫入，不需要交接（直接把工作卡改派即可）');
  if (run.stopped) throw new Error('這件工作已經停止，不能交接');
  const from = t.agent;
  if (from === toAgent) throw new Error(`${agentName(toAgent)} 已經是這張卡的寫入者`);
  // PAUSED is a visible state, not proof that the old turn has stopped.
  t.hold = true;
  if (t.status === 'WORKING' || w.executingSteps?.has(t.id)) t.interrupted = true;
  saveRun(w, run.paused ? 'paused' : 'running');
  try { await drainExecution(w, [t]); }
  catch (e) { t.interrupted = false; throw e; }
  // 4-5. the old agent gives up the lease; the card (with its conversation, history) goes to the new agent
  const prior = await lastAgentText(run.convs[workKey(t)]);
  const info = await workspaceOf(t.workdir || w.project);
  withLeaseTransaction(() => {
  const holder = writerOf(info.key);
  if (holder && !sameCard(holder, w, t)) throw new Error('工作區已由另一個 Agent 接手');
  for (const l of S.leases) if (l.jobId === run.id && l.cardId === t.id && l.owner.agent === from && (l.generation || 0) === (t.leaseGeneration || 0)) { l.revoked = true; retire(l, `交接給 ${agentName(toAgent)}`); }
  releaseCardLeases(w, t, `交接給 ${agentName(toAgent)}`);
  (t.handoffs ||= []).push({ from, to: toAgent, at: nowIso() });
  t.leaseGeneration = (t.leaseGeneration || 0) + 1;
  Object.assign(t, { agent: toAgent, hold: false, interrupted: false, resumed: true, trust: true, convReset: false, detail: '',
    status: ['PAUSED', 'INTERRUPTED'].includes(t.status) ? t.status : 'WAITING', wakeNote: writerHandoffNote(from, toAgent, prior) });
  log(w, 'studio', 'system', `工作區交接：${agentName(from)} 已停止並放下寫入權，改由 ${agentName(toAgent)} 從目前的資料夾和 branch 接續「${t.title}」。${agentName(from)} 的對話和紀錄都保留，但不再是寫入者。`);
  const got = acquireWrite(w, t, info);
  if (!got.ok) throw new Error('新 Agent 無法取得寫入租約');
  Object.assign(got.lease, { status: 'RESERVED', reason: `交接自 ${agentName(from)}` });
  saveLeases();
  });
  if (run.active) pump(w);
  saveRun(w, run.paused ? 'paused' : 'running'); // the record now says who owns the card
  return { ok: true, card: t.title, from, to: toAgent };
}

// ----- parallel work the right way: an own worktree (own branch, own lease) -----
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'card';
async function useWorktree(w, taskId) {
  const t = w.tasks.find((x) => x.id === taskId);
  if (!t || !isWriter(t)) throw new Error('只有會修改檔案的工作卡才需要獨立 worktree');
  if (t.workdir) throw new Error('這張卡已經在獨立 worktree 裡');
  if (['WORKING', 'DONE'].includes(t.status)) throw new Error('這張卡已經開始或已完成');
  const info = await workspaceOf(w.project);
  if (!info.isGit) throw new Error('這個資料夾不是 git 專案，不能建立獨立 worktree');
  const dir = path.join(RT, 'studio', 'worktrees', `${path.basename(info.path)}-${t.id}`);
  const branch = `studio/${t.id}-${slugOf(t.title)}`;
  const base = (await git(info.path, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')).out?.trim() || 'HEAD';
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(info.path, 'worktree', 'add', '-b', branch, dir, base);
  if (r.err) throw new Error('建立 worktree 失敗：' + r.err);
  Object.assign(t, { workdir: dir, worktree: { path: dir, branch, base, repoPath: info.path }, blocked: null, blockReason: '', blockLogged: '' });
  log(w, 'studio', 'system', `「${t.title}」改在獨立 worktree 做（branch ${branch}）：不會碰到主資料夾的寫入者。`);
  pump(w);
  return { path: dir, branch };
}
function useReadOnly(w, taskId) {
  const t = w.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這張工作卡');
  if (['WORKING', 'DONE'].includes(t.status)) throw new Error('這張卡已經開始或已完成');
  Object.assign(t, { writes: false, forcedReadOnly: true, blocked: null, blockReason: '', blockLogged: '',
    instructions: t.instructions + '\n\nNOTE: the working tree is being edited by someone else right now, so do this card READ-ONLY: review / analysis / report only. Do not modify files.' });
  log(w, 'studio', 'system', `「${t.title}」改成唯讀 Review：只讀、不修改，可以和寫入者同時進行。`);
  pump(w);
}
// The PR is merged (or, without a remote, the branch is part of the base): the worktree and its branch can go.
async function cleanupWorktree(w, t) {
  const wt = t.worktree;
  if (!wt || wt.cleaned) return;
  let merged = false;
  const pr = await sh('gh', ['pr', 'list', '--head', wt.branch, '--state', 'merged', '--json', 'number'], wt.repoPath);
  try { merged = JSON.parse(pr.out || '[]').length > 0; } catch { /* no gh answer */ }
  if (!merged && !(await originRepo(wt.repoPath))) merged = !(await git(wt.repoPath, 'merge-base', '--is-ancestor', wt.branch, 'HEAD')).err;
  if (!merged) { log(w, 'studio', 'system', `worktree「${wt.branch}」先保留：它的 PR 還沒 merge。`); return; }
  if ((await git(wt.path, 'status', '--porcelain')).out?.trim()) { log(w, 'studio', 'system', `worktree「${wt.branch}」先保留：裡面還有沒提交的檔案。`); return; }
  await git(wt.repoPath, 'worktree', 'remove', '--force', wt.path);
  await git(wt.repoPath, 'branch', '-D', wt.branch);
  wt.cleaned = true;
  log(w, 'studio', 'system', `已 merge：清掉本次建立的 worktree 和 branch「${wt.branch}」。`);
}

// ----- unknown changes: never reset / stash / overwrite; stop writing and ask -----
function flagExternalModification(w, why) {
  const run = w.run;
  if (!run || run.extMod) return;
  run.extMod = { at: nowIso(), why };
  for (const l of S.leases) if (l.jobId === run.id && l.status !== 'RELEASED') l.flag = 'EXTERNAL_MODIFICATION_DETECTED';
  if (run.active) pause(w); // stops the writers and keeps the leases RESERVED; nothing in the tree is touched
  log(w, 'studio', 'system', `偵測到來源不明的修改（EXTERNAL_MODIFICATION_DETECTED）：${why}。Studio 已停止寫入，什麼都沒有改動（沒有 reset、沒有 stash）。確認後按「確認接手並繼續」。`);
  notify(`${label(w)}：偵測到來源不明的修改`, why, 'ask', w.project);
  saveRun(w, 'paused');
}
// Runs every few seconds. While none of Studio's agents is executing, any change to a tree Studio holds is somebody else's;
// while one is executing, only cooperating signals (a fresh outside lock file) can be told apart from the agent's own edits.
async function checkWorkspaces() {
  for (const w of S.workspaces) {
    const run = w.run;
    if (!run || run.extMod || run.stopped) continue;
    const holding = w.tasks.filter((t) => isWriter(t) && !t.takeover && cardLeases(w, t).some((l) => l.mode === 'write'));
    for (const t of holding) {
      const dir = (await workspaceOf(t.workdir || w.project)).path;
      if (w.executingSteps?.has(t.id) || t.status === 'WORKING' || t.stopUnconfirmed) {
        const lock = await foreignLock(w, dir);
        if (lock) flagExternalModification(w, `${lock.owner || '另一個程式'} 在 Studio 寫入期間也開始修改這個工作區（鎖定檔）`);
        continue;
      }
      const baseline = run.treeStamps?.[treeKey(dir)] || (!t.workdir && run.treeStamp);
      if (baseline && (await treeStamp(w, dir)) !== baseline) flagExternalModification(w, '持有寫入權的 Agent 沒有在執行，工作區卻被改動了');
    }
  }
}

async function runCard(w, t) {
  const run = w.run;
  const note = t.wakeNote;
  const startAgent = t.agent;
  t.status = 'WORKING';
  t.workingSince = nowIso(); // this work spell (shown as 已執行)
  t.firstStartedAt ||= t.workingSince;
  t.wakeNote = '';
  log(w, t.agent, 'worker', (note ? '收到等待的結果，繼續：' : t.resumed ? '繼續工作：' : '開始工作：') + t.title);
  try {
    const deps = (t.after || []).map((id) => w.tasks.find((x) => x.id === id)).filter(Boolean);
    const knowsTask = !!run.convs[workKey(t)]; // a new conversation (e.g. after a handoff) has not seen the task yet
    const prompt = note && knowsTask ? `Update from Multi-Agent Studio for your task "${t.title}":
${note}

Continue the task. End your reply with a short summary (1-3 sentences).
${STATUS_RULES}` : `You are a WORKER in "Multi-Agent Studio". Your leader (${agentName(run.leader)}) assigned you this task.
Work only inside this folder: ${t.workdir || run.project}
If you must run this project's backend on port 3018 for validation, let Studio own the process so it can verify and recover it: POST JSON to http://127.0.0.1:${PORT}/api/runtime/start with ws (project path), cardId (${t.id}), executable (absolute path), args (string array), cwd (inside this workspace), dataDir (an existing directory inside this workspace), port (3018), smokePath, and noCredentialsConfirmed:true only when restart needs no account credentials. Never register or stop an unknown process. A listener is not ready until Studio confirms process alive + reachable port + GET /health HTTP 200 + application ready.
${note ? `\nNOTE FROM STUDIO:\n${note}\n` : ''}${t.resumed ? '\nYou were interrupted while doing this task earlier. First check the current state of the project folder, then finish the task without redoing work that is already done.\n' : ''}
Task: ${t.title}
Instructions:
${t.instructions}
${deps.length ? `\nResults of the earlier cards this task builds on:\n${deps.map((d) => `- ${d.title} (${agentName(d.agent)}): ${d.result}`).join('\n')}\n` : ''}
${accessRules(t)}
${deliveryRules(w.delivery, 'worker')}
When you end your turn, reply with a short summary of what you did (1-3 sentences).
${STATUS_RULES}`;
    const cid = await conv(w, t.agent, false, t.hard, t.workdir);
    // A step stopped by 立刻打斷 ends early (maybe with an error): park the card until the Leader has read the note.
    const step = async (text) => {
      cardStep.add(cid);
      try {
        if (askBusy.has(cid)) { // a progress question is being answered: Stop / Pause / 打斷 / handoff meanwhile cancelled that turn, not this step
          await askBusy.get(cid);
          if (t.interrupted) return '';
          if (run.stopped || run.paused) throw new Halt(run.stopped ? '已停止' : '已暫停');
        }
        return await turn(t.agent, cid, text, { w, allowStart: () => t.agent === startAgent && !t.hold && run.active });
      } catch (e) { if (t.interrupted && !(e instanceof Halt)) return ''; throw e; } finally { cardStep.delete(cid); t.stepEndAt = Date.now(); }
    };
    const park = () => {
      Object.assign(t, { status: 'WAITING', interrupted: false, resumed: true,
        wakeNote: 'The user stopped your previous step midway to give you a new instruction. First check the current state of the files (your last step may be half done), then continue the task.'
          + (t.notes?.length ? '\nNew instruction from the user (via the leader): ' + t.notes.splice(0).join('\n') : '') }); // the note may arrive before the stop
      log(w, t.agent, 'worker', '已停下，等工頭轉達你的新指示：' + t.title);
    };
    const reply = await step(prompt);
    if (t.interrupted) { park(); return; }
    let st = parseStatus(reply);
    if (!st) { // ask once instead of guessing
      const again = await step(`Your last reply had no STATUS line. Reply with only the status line now.\n${STATUS_RULES}`);
      if (t.interrupted) { park(); return; }
      st = parseStatus(again);
      if (st) st.text = reply.trim();
    }
    st ||= { kind: 'DONE', detail: '', options: [], text: reply.trim() + '\n（沒有回報狀態，先當作完成，由工頭確認整體結果）' };
    let last = reply;
    while (t.notes?.length) {
      const note = t.notes.splice(0).join('\n');
      log(w, 'studio', 'system', `把你的指示交給 ${agentName(t.agent)}，接著調整「${t.title}」。`);
      last = await step(`New instruction from the user (via the leader) for your task "${t.title}":\n${note}\n\nApply it to this task now. End your reply with a short summary (1-3 sentences).\n${STATUS_RULES}`);
      if (t.interrupted) { park(); return; }
      st = parseStatus(last) || { kind: 'DONE', detail: '', options: [], text: last.trim() };
    }
    applyStatus(w, t, st, last);
  } catch (e) {
    if (e.stopUnconfirmed) {
      t.stopUnconfirmed = true; t.status = 'PAUSED'; t.result = 'Agent 尚未確認停止，保留租約';
      if (run.active) pause(w);
      saveRun(w, run.stopped ? 'stopped' : 'paused'); return;
    }
    if (e instanceof Halt && run.paused) { if (t.agent === startAgent) Object.assign(t, { status: 'PAUSED', result: '已暫停', resumed: true, wakeNote: note }); return; } // handed off meanwhile: the card is the new agent's now
    if (e instanceof Halt && run.stopped) { t.status = 'FAILED'; t.result = '已停止'; return; }
    if (e.stuck && !t.convReset) { // the worker's conversation will not stop: start a fresh one (the card brief carries the task)
      delete run.convs[workKey(t)];
      Object.assign(t, { convReset: true, status: 'WAITING', resumed: true, detail: e.message });
      log(w, 'studio', 'system', `${agentName(t.agent)} 的對話卡住停不下來，改開一個新的對話重做「${t.title}」。`, e.message);
      return;
    }
    if (!(e instanceof Halt) && !e.timeout && !e.stuck && !t.hard && JSON.stringify(tierCfg(w, t.agent, true)) !== JSON.stringify(tierCfg(w, t.agent, false))) {
      Object.assign(t, { hard: true, escalated: true, status: 'WAITING', resumed: true, detail: e.message });
      log(w, 'studio', 'system', `「${t.title}」用平常的模型沒做成，自動改用強模型重試一次。`, e.message);
      return;
    }
    t.status = 'FAILED';
    t.result = e.timeout ? '沒有完成：' + e.message.replace(/^逾時：/, '')
      : e.stuck ? '沒有完成：這位 AI 員工的對話卡在上一步（可能在等權限確認），Studio 試著停止但沒有成功。'
      : '這張卡執行時出錯，沒有完成。';
    t.detail = e.message;
    log(w, t.agent, 'worker', t.result + '：' + t.title, e.message);
    wakeWaiters(w, t);
  }
}

function applyStatus(w, t, st, reply) {
  const who = agentName(t.agent);
  t.result = st.text || '(沒有文字回覆)';
  log(w, t.agent, 'worker', t.result);
  if (st.kind === 'DONE') {
    t.status = 'DONE';
    t.doneAt = new Date().toISOString();
    return wakeWaiters(w, t);
  }
  if (st.kind === 'WAITING_EXTERNAL') {
    const pr = findPr(st.detail + '\n' + reply);
    const backendPort = /MiningProcessLockError|(?:backend|後端).{0,30}3018|3018.{0,60}(?:恢復|ready|health|啟動)|(?:恢復|等待).{0,30}3018/i.test(st.detail + '\n' + reply) ? 3018 : 0;
    t.status = 'WAITING_EXTERNAL';
    t.wait = { what: st.detail || '外部結果', pr, manual: !pr && !backendPort, ...(backendPort ? { backendPort, manual: false } : {}) };
    if (pr) {
      log(w, 'studio', 'system', `「${t.title}」在等 PR ${pr} 的 CI：Studio 每分鐘檢查一次，跑完會自動交回 ${who}。`);
      checkExternal(w, t);
    } else if (backendPort) {
      log(w, 'studio', 'system', `「${t.title}」正在檢查 backend 3018 是否能安全自動恢復；listener 必須通過 health 與 application ready 才會繼續。`);
      recoverBackendWait(w, t);
    } else {
      log(w, 'studio', 'system', `「${t.title}」在等「${t.wait.what}」：Studio 無法自動確認，結果好了請按「繼續」。`);
      notify(`${label(w)}：需要你按「繼續」`, `${who} 在等「${t.wait.what}」，Studio 無法自動確認`, 'ask', w.project);
    }
    return;
  }
  if (st.kind === 'WAITING_AGENT') {
    const a = Object.keys(AGENTS).find((id) => st.detail.toLowerCase().includes(id) || st.detail.includes(agentName(id)));
    t.status = 'WAITING_AGENT';
    t.wait = { agent: a || '', what: st.detail.replace(/^[\w-]+\s*[:：]\s*/, '') || '另一位成員的結果' };
    if (!a || a === t.agent) return wake(w, t, `Studio could not tell which other team member you wait for (ids: ${Object.keys(AGENTS).join(', ')}). Continue without waiting, or report NEEDS_USER.`);
    if (!w.tasks.some((x) => x !== t && x.agent === a && OPEN.includes(x.status))) {
      return wake(w, t, `${agentName(a)} has no open card in this job, so nothing will arrive from them. Do what you can without it, or report NEEDS_USER.`);
    }
    log(w, 'studio', 'system', `「${t.title}」在等 ${agentName(a)}：它做完會自動交回 ${who}。`);
    return;
  }
  t.status = 'NEEDS_USER';
  t.ask = { question: st.detail || t.result.slice(-300), options: st.options };
  notify(`${label(w)}：${who} 需要你處理`, t.ask.question.slice(0, 160), 'ask', w.project);
}

// ---------- Work details and progress questions ----------
// Observation only: asking never makes a card, never takes a lease, never interrupts the work.
const STUCK_MS = 8 * 60e3; // no new activity for this long = "可能卡住" (a hint only; nothing is stopped)
const cardStep = new Set(); // conversations a card step is using right now
const askBusy = new Map(); // conversationId -> a progress question being answered between steps
const ASKABLE = ['WORKING', 'WAITING_EXTERNAL', 'WAITING_AGENT', 'NEEDS_USER'];
const ASK_DEFAULT = '目前做到哪裡？現在正在做什麼？有沒有卡住？預計下一步是什麼？';
const askPrompt = (q, title) => `Question from the user (Nana) about your task "${title}". This is only a question, not a new instruction:
"${q}"
Reply now with ONE separate text message that starts with "${ASK_MARK}" and answers briefly in the user's language (2-5 short lines): how far you are, what you are doing right now, whether you are stuck (and why), and your next step. Write it as a visible reply, not only in your thoughts.
Do not change your plan, do not edit files or run commands for this question, and do not add a STATUS line.`;
const convOf = (w, t) => w.run?.convs?.[workKey(t)];
const ASK_MARK = 'PROGRESS ANSWER:';
const isAskAnswer = (m) => String(m.content?.content || '').toUpperCase().includes(ASK_MARK);
const answerText = (x) => String(x || '').replace(/^\s*STATUS:.*$/gim, '').replace(/^[\s*_]*PROGRESS ANSWER:[\s*_]*/i, '').trim();

// Leader / work-memory view of a working card: time, last activity, possibly stuck.
function workInfo(w, t) {
  if (t.status !== 'WORKING' || !t.workingSince) return '';
  const a = convActivity.get(convOf(w, t)), mins = (ms) => Math.max(0, Math.round(ms / 60e3));
  const idle = a ? Date.now() - a.at : 0;
  return ` | working ${mins(Date.now() - Date.parse(t.workingSince))} min, last activity ${mins(idle)} min ago`
    + (a?.confirm ? ', waiting for a tool permission' : a?.tool ? `, running: ${a.tool}` : '')
    + (idle >= STUCK_MS && !a?.tool ? ' (no progress for a while: possibly stuck; long work alone is fine)' : '');
}

async function askAgent(w, id, text) {
  const t = w.tasks.find((x) => x.id === id);
  if (!t) throw new Error('找不到這張工作卡');
  if (!ASKABLE.includes(t.status)) throw new Error('這張卡現在沒有在工作，沒有可以詢問的對象');
  const cid = convOf(w, t);
  if (!cid) throw new Error('這位 AI 員工還沒開始這張卡，等它開始後再問');
  const q = { id: crypto.randomUUID().slice(0, 8), at: nowIso(), text: clip(String(text || '').trim(), 500) || ASK_DEFAULT, state: 'queued', answer: '', agent: t.agent };
  (t.asks ||= []).push(q);
  if (t.asks.length > 20) t.asks.shift();
  const rt = (await api('GET', `/api/conversations/${cid}`).catch(() => ({}))).runtime || {};
  if (t.status === 'WORKING' && cardStep.has(cid) && !askBusy.has(cid) && active.has(cid) && rt.is_processing && rt.supports_midturn_delivery) { // only into this card's own working step
    // The backend takes a message in the middle of a turn: ask now, the work goes on.
    try { Object.assign(q, { state: 'sent', how: 'now', msgId: (await api('POST', `/api/conversations/${cid}/messages`, { content: askPrompt(q.text, t.title) })).msg_id }); return q; }
    catch { /* not taken right now: ask at the next safe point */ }
  }
  q.how = 'later';
  deliverAsk(w, t, cid, q);
  return q;
}

// Between steps: when the conversation is idle, ask in a short turn of its own (a card step waits for it).
async function deliverAsk(w, t, cid, q) {
  const run = w.run;
  for (const t0 = Date.now(); ; await sleep(2000)) {
    if (run.stopped || w.run !== run) return Object.assign(q, { state: 'failed', answer: '工作已停止，問題沒有送出。' });
    if (Date.now() - t0 > HARD_CAP_MS) return Object.assign(q, { state: 'failed', answer: '一直等不到安全的時點，問題沒有送出。' });
    if (!run.paused && !active.has(cid) && !cardStep.has(cid) && !askBusy.has(cid)) break;
  }
  if (!ASKABLE.includes(t.status)) return Object.assign(q, { state: 'closed', answer: '問題送達前這張卡已經結束，沒有再問。它最後的回報：' + clip(t.result, 600) });
  const why = t.agent !== q.agent ? '這張卡已經交給別的 AI 員工，問題沒有送給原本的那位。'
    : convOf(w, t) !== cid ? '這張卡換了新的對話，問題沒有送出，請再問一次。' : '';
  if (why) return Object.assign(q, { state: 'failed', answer: why });
  let done;
  askBusy.set(cid, new Promise((r) => { done = r; }));
  try {
    q.state = 'sent';
    const reply = await turn(t.agent, cid, askPrompt(q.text, t.title), { w, check: true, ask: true, timeout: 5 * 60e3 });
    if (run.stopped || run.paused) Object.assign(q, { state: 'failed', answer: '工作被' + (run.stopped ? '停止' : '暫停') + '，這個問題沒有得到回答。' });
    else Object.assign(q, { state: 'answered', answer: answerText(reply.toUpperCase().includes(ASK_MARK) ? reply.slice(reply.toUpperCase().indexOf(ASK_MARK)) : reply) || '（沒有文字回覆）', answeredAt: nowIso() });
  } catch (e) { Object.assign(q, { state: 'failed', answer: '沒有得到回覆：' + clip(e.message, 200) }); }
  finally { askBusy.delete(cid); done(); }
}

// A question sent in the middle of a turn: its answer is the first AI text after it.
// Only a message carrying the marker counts: the agent's own progress lines are not the answer.
function resolveAsks(t, items) {
  for (const q of t.asks || []) {
    if (q.state !== 'sent' || !q.msgId) continue;
    const i = items.findIndex((m) => m.id === q.msgId);
    const a = i < 0 ? null : items.slice(i + 1).find((m) => m.type === 'text' && m.position === 'left' && String(m.content?.content || '').toUpperCase().includes(ASK_MARK));
    if (!a) continue;
    const x = String(a.content.content);
    Object.assign(q, { state: 'answered', answer: clip(answerText(x.slice(x.toUpperCase().indexOf(ASK_MARK))), 1500), answeredAt: new Date(a.created_at || Date.now()).toISOString() });
  }
}
async function pollAsks() {
  for (const w of S.workspaces) for (const t of w.tasks) {
    const cid = convOf(w, t);
    if (!t.asks?.some((q) => q.state === 'sent' && q.msgId) || !cid) continue;
    const items = (await api('GET', `/api/conversations/${cid}/messages`).catch(() => null))?.items;
    if (!items) continue;
    resolveAsks(t, items);
    // The step ended without an answer (it may have answered only in its thoughts): ask again between steps.
    if (active.has(cid) || cardStep.has(cid)) continue;
    for (const q of t.asks.filter((x) => x.state === 'sent' && x.msgId)) { Object.assign(q, { state: 'queued', how: 'later', msgId: '' }); deliverAsk(w, t, cid, q); }
  }
}

// A tool call reads as its name plus the command it runs (backends put the command in different places).
function toolText(c = {}) {
  const name = String(c.name || ''), cmd = String(c.input?.command || c.args?.CommandLine || c.args?.command || c.input?.file_path || '');
  return cmd && !name.includes(cmd.slice(0, 20)) ? name + '：' + cmd : name;
}
const itemText = (m) => (m.type === 'tool_call' ? toolText(m.content) : typeof m.content?.content === 'string' ? m.content.content : '') || '';
// What one card's agent is doing: plain lines, newest first; the raw conversation only on request.
async function cardDetail(w, id) {
  const t = w.tasks.find((x) => x.id === id);
  if (!t) throw new Error('找不到這張工作卡');
  const cid = convOf(w, t);
  const items = cid ? (await api('GET', `/api/conversations/${cid}/messages`).catch(() => ({}))).items || [] : [];
  resolveAsks(t, items);
  const since = Date.parse(t.firstStartedAt || 0) - 2000; // one conversation may hold several cards of this agent
  const until = t.status === 'WORKING' || !t.stepEndAt ? Infinity : t.stepEndAt + 2000; // the same agent may already work on another card in this conversation
  const mine = items.filter((m) => (m.created_at || 0) >= since && (m.created_at || 0) <= until);
  const say = (m) => m.type === 'text' && m.position === 'left' && answerText(m.content?.content);
  const acts = mine.filter((m) => m.type === 'tool_call' || say(m)).slice(-12).reverse()
    .map((m) => ({ at: m.created_at, kind: m.type === 'tool_call' ? 'tool' : 'say', text: clip(m.type === 'tool_call' ? itemText(m) : answerText(itemText(m)).split('\n')[0], 160), running: m.type === 'tool_call' && m.status !== 'finish' }));
  const last = [...mine].reverse().find(say);
  return { id: t.id, title: t.title, agent: t.agent, status: t.status, workingSince: t.workingSince, firstStartedAt: t.firstStartedAt, wait: t.wait, result: t.result,
    activity: convActivity.get(cid) || null, acts, lastSay: last ? clip(answerText(itemText(last)), 800) : '', asks: t.asks || [],
    log: mine.slice(-50).map((m) => ({ at: m.created_at, who: m.position === 'right' ? 'Studio' : 'AI', kind: m.type, text: clip(itemText(m), 600) })) };
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
    if (working.length) log(w, 'studio', 'system', `已打斷 ${working.map((t) => agentName(t.agent)).join('、')}：等工頭看完你的指示再接著做。`);
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
${w.tasks.map((t) => `- id ${t.id} [${t.status}] ${t.title} (${t.agent})${workInfo(w, t)}`).join('\n')}
Workers you can assign: ${workers.map((x) => `${x} (${agentName(x)})`).join(', ')}

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
      log(w, 'studio', 'system', `已把指示轉給 ${agentName(t.agent)}（「${t.title}」）。`);
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
    const info = await workspaceOf(w.project);
    Object.assign(w, { wsKey: info.key, wsInfo: { path: info.path, branch: info.branch, repo: info.repo } });
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
  const results = w.tasks.map((t) => `- [${t.status}] ${t.title} (${agentName(t.agent)}): ${clip(t.result, 500)}${t.status === 'FAILED' && t.detail ? ` [technical reason: ${clip(t.detail, 200)}]` : ''}`).join('\n');
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
Workers you can assign: ${workers.map((x) => `${x} (${agentName(x)})`).join(', ') || '(none available)'}

Reply with ONLY one JSON object, no markdown fences, one of:
${w.afterDone === 'stop' ? '{"done":true,"report":"<final report to the user, 2-4 sentences, in the user\'s language>"}'
    : '{"done":true,"report":"<final report to the user, 2-4 sentences, in the user\'s language>","next":[{"title":"<short title, user\'s language>","why":"<one sentence why it is worth doing>","request":"<the full request to give the team>"}]}'}
{"done":false,"message":"<one sentence to the user>","subtasks":[${SUBTASK_SHAPE}]}
{"needs_user":"<question to the user, in the user's language>","options":["<choice>","<choice>"]}
Use needs_user only for a real decision about the work itself that the team cannot make.
${deliveryRules(w.delivery, 'check', w.afterDone)}
A FAILED card with a technical reason (timeout, conversation busy, provider error) is a tooling problem, not a problem with the task: never ask the user to read logs or restart Studio. Add a retry card instead (smaller, or for another worker), and give the retry the facts it needs.${w.afterDone === 'stop' ? '' : `
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
  notify(`${label(w)}：${agentName(run.leader)} 需要你處理`, question.slice(0, 160), 'ask', w.project);
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
    if (t.takeover) { // "may Studio write over what was changed meanwhile?"
      Object.assign(t, { takeover: false, ask: null });
      if (/^先不要|暫停/.test(text)) { t.status = 'WAITING'; log(w, 'studio', 'system', '不接手：先暫停，等你處理好再按「繼續」。'); return pause(w); }
      Object.assign(t, { status: 'WAITING', trust: true });
      return pump(w);
    }
    t.trust = true; // the user is here: continue even if files changed while the card waited
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
  markRuntimeStops(w);
  releaseJobLeases(w, 'stopped'); // STOP: the tree is free again; records stay
  log(w, 'studio', 'system', '已停止：這件工作到此為止，未完成的卡標成失敗，不能再「繼續」。要接著做，按「▶ 接著處理」開新的一輪。');
  finish(w, 'stopped');
}

function pause(w) {
  const run = w.run;
  if (!run?.active) throw new Error('目前沒有進行中的工作');
  run.paused = true;
  run.active = false;
  busyConvs(run).forEach(cancelTurn);
  for (const t of w.tasks) if (t.status === 'WORKING') { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; }
  reserveJobLeases(w, 'paused'); // PAUSE: the work still belongs to its owner
  log(w, 'studio', 'system', '已暫停：成員已停下（手上那一步可能做到一半），工作卡和進度都保留，不會自己恢復；關掉 Studio 也沒關係，要你按「繼續」才會接著做。');
  saveRun(w, 'paused');
}

// Can be continued: paused by the user, or "running" in the file but no longer live (Studio was closed mid-job).
const resumable = (r) => r.status === 'paused' || (r.status === 'running' && !S.workspaces.some((w) => w.run?.id === r.id && w.run.active));

function loadRun(w, r) {
  if (!resumable(r)) throw new Error('這件工作已經停止或完成，不能恢復');
  // (goal / refs / context / continues come back too: the work memory survives a restart)
  // Cards that were mid-work when the Studio closed are interrupted; waiting cards keep waiting.
  for (const t of r.tasks) if (t.status === 'WORKING') Object.assign(t, { status: 'INTERRUPTED', result: '已中斷', resumed: true });
  for (const t of r.tasks) Object.assign(t, { hold: false, interrupted: false });
  w.tasks = r.tasks;
  w.activity = r.activity;
  w.run = { id: r.id, startedAt: r.startedAt, project: r.project, leader: r.leader, request: r.request, convs: r.convs || {}, phase: r.phase || 'working', leaderGen: 0, rounds: r.rounds || 0, ask: r.ask || null, notes: r.notes || [], goal: r.goal, refs: r.refs, context: r.context, continues: r.continues, active: false, paused: true, stopped: false, summarizing: false };
  Object.assign(w.run, { treeStamps: r.treeStamps || {}, treeStamp: r.treeStamp, leftAt: r.leftAt, extMod: r.extMod, claimedBy: r.claimedBy });
  for (const [k, cid] of Object.entries(w.run.convs)) convAgent.set(cid, k.split(':')[0]);
}

// w is null when continuing from history: the record's project picks (or opens) the workspace.
async function resume(w, id, opts = {}) {
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
  if (run?.stopped && !run.paused) throw new Error('這件工作已經停止，不能繼續；按「▶ 接著處理」開新的一輪');
  if (!run?.paused) throw new Error('沒有暫停中的工作');
  if (busyConvs(run).length || w.executingSteps?.size) throw new Error('Agent 還在停下中，請幾秒後再按繼續');
  await drainExecution(w); // restart may have left an orphan conversation
  if (!isDir(run.project)) throw new Error('專案資料夾不存在：' + run.project);
  if (!available(w.leader)) throw new Error(`Leader ${agentName(w.leader)} 目前不可用`);
  // Is the tree still this job's? (Somebody else may hold it now: another agent after a handoff, an external session.)
  const holder = await leaseBlocker(w);
  if (holder) throw new Error(`工作區已由${holder.owner.kind === 'external' ? '外部 Agent 接手' : '另一個 Agent 接手'}，本工作保持暫停。（${holderText(holder)}）`);
  if (run.extMod) {
    if (!opts.confirmExternal) throw new Error(`偵測到來源不明的修改（EXTERNAL_MODIFICATION_DETECTED）：${run.extMod.why}。確認要讓 Studio 接手並繼續，請用「確認接手並繼續」。`);
    Object.assign(run, { extMod: null, treeStamp: await treeStamp(w), leftAt: nowIso() });
    for (const l of S.leases) if (l.jobId === run.id) l.flag = '';
    for (const t of w.tasks) {
      t.trust = true;
      const dir = (await workspaceOf(t.workdir || w.project)).path;
      (run.treeStamps ||= {})[treeKey(dir)] = await treeStamp(w, dir);
    }
  }
  if (run.leader !== w.leader) { run.handoffFrom = run.leader; run.leader = w.leader; }
  const reservations = [];
  try {
    const trees = new Map();
    for (const t of w.tasks) {
      if (!isWriter(t) || ['DONE', 'FAILED'].includes(t.status)) continue;
      const info = await workspaceOf(t.workdir || w.project);
      if (!trees.has(info.key)) trees.set(info.key, { info, cards: [] });
      trees.get(info.key).cards.push(t);
    }
    for (const { info, cards } of trees.values()) {
      const current = writerOf(info.key);
      const t = cards.find((t) => current && sameCard(current, w, t)) || cards.find((t) =>
        (t.after || []).every((id) => w.tasks.find((x) => x.id === id)?.status === 'DONE')) || cards[0];
      const got = acquireWrite(w, t, info);
      if (!got.ok) throw new Error('工作區已由另一個 Agent 接手，本工作保持暫停');
      got.lease.status = 'RESERVED'; reservations.push(got); saveLeases();
    }
  } catch (e) {
    for (const got of reservations) if (!got.reused) retire(got.lease, 'resume failed');
    saveLeases(); throw e;
  }
  run.paused = false;
  run.active = true;
  for (const t of w.tasks) { if (t.status === 'PAUSED' || t.status === 'INTERRUPTED') t.status = 'WAITING'; if (t.status === 'WAITING') t.trust = true; } // you pressed 繼續: files changed while paused are expected
  log(w, 'studio', 'system', `繼續工作（Leader：${agentName(run.leader)}）。`);
  if (run.phase === 'planning') planPhase(w);
  else if (run.phase === 'summarizing') { if (!run.ask) summarize(w); } // a pending question waits for the user's answer
  else { run.phase = 'working'; pump(w); watchExternal(); processNotes(w); }
}

async function reassign(w, taskId, agent) {
  const t = w.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這項工作');
  if (w.run?.stopped) throw new Error('這件工作已經停止，不能改派');
  if (w.executingSteps?.has(t.id) || t.status === 'WORKING' || t.stopUnconfirmed) throw new Error('Agent 還在停下中，請先完成暫停');
  if (isWriter(t)) return handoffWriter(w, agent, taskId);
  if (!available(agent)) throw new Error('Agent 目前不可用');
  t.agent = agent; t.status = w.run.paused ? 'PAUSED' : 'WAITING';
  saveRun(w, w.run.paused ? 'paused' : 'running');
  if (w.run.active) pump(w);
}

// Changing the Leader mid-run hands the same job over; Workers keep their cards.
async function setLeader(w, agent) {
  if (!AGENTS[agent]) throw new Error('未知的 Agent');
  if (!available(agent)) throw new Error(`${agentName(agent)} 目前不可用`);
  const old = w.leader;
  if (old === agent) return;
  w.leader = S.leader = agent; // the last pick is also the default for the next opened project
  saveSettings();
  const run = w.run;
  if (!run || (!run.active && !run.paused)) return log(w, 'studio', 'system', `Leader 換成 ${agentName(agent)}`);
  run.handoffFrom = run.leader;
  run.leader = agent;
  run.leaderGen++;
  const n = w.tasks.length;
  log(w, 'studio', 'system', `Leader 交接：${agentName(old)} → ${agentName(agent)}。新 Leader 接手原始需求${n ? `和 ${n} 張工作卡（已完成的結果保留）` : ''}，不需要重新輸入。`);
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
async function refreshRuntimeReadiness() {
  const runtimes = listRuntimes({ rtDir: RT });
  S.runtimes = await Promise.all(runtimes.map(async (runtime) => {
    if (!runtime.port) return { ...runtime, readiness: null };
    const readiness = await checkBackendReadiness({ ...runtime, rtDir: RT }, { isPidAlive });
    return { ...runtime, readiness };
  }));
  return S.runtimes;
}

const recoveryEnv = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
function recoverBackendWait(w, t) {
  if (!w.run?.active || w.run.paused || w.run.stopped || t.hold || t.status !== 'WAITING_EXTERNAL'
      || !t.wait?.backendPort || t.wait.manual || w.recoverySteps?.has(t.id)) return;
  w.recoverySteps ||= new Map();
  const step = recoverBackendWaitStep(w, t);
  w.recoverySteps.set(t.id, step);
  step.finally(() => { if (w.recoverySteps.get(t.id) === step) w.recoverySteps.delete(t.id); }).catch(() => {});
  return step;
}
async function recoverBackendWaitStep(w, t) {
  const run = w.run, generation = t.leaseGeneration || 0, wait = t.wait;
  const current = () => w.run === run && run.active && !run.paused && !run.stopped && !t.hold
    && t.status === 'WAITING_EXTERNAL' && t.wait === wait && (t.leaseGeneration || 0) === generation;
  const canProceed = () => {
    if (!current()) return false;
    loadLeases();
    const holder = writerOf(treeKey(t.workdir || w.project));
    return !!holder && sameCard(holder, w, t) && holder.instance === INSTANCE && !holder.revoked && !holder.jobStopped;
  };
  const block = (reason, manual = true) => {
    if (!current()) return;
    Object.assign(wait, { manual, recoveryReason: `Blocked: ${reason}` });
    saveRun(w, 'running');
  };
  try {
    if (!canProceed()) { block('Workspace ownership 未確認，禁止 backend 寫入'); return; }
    // Latest replacement wins. An old cleaned record must never be restarted again.
    const runtime = listRuntimes({ rtDir: RT }).filter((x) => x.job_id === run.id && x.card_id === t.id && x.port === wait.backendPort).at(-1);
    if (!runtime) {
      const occupant = await checkPortOwnership(wait.backendPort, { desiredJobId: run.id, rtDir: RT });
      block(occupant.reason || `找不到 Studio 建立的 runtime；PID ${occupant.pid || 'unknown'} / command ${occupant.command || 'unknown'} / DATA_DIR owner unknown`);
      return;
    }
    const workspace = canonPath(t.workdir || w.project);
    const dataDir = runtime.data_dir;
    if (!dataDir || runtime.env?.DATA_DIR !== dataDir || !within(workspace, canonPath(dataDir))) {
      block(`PID ${runtime.root_pid} (${runtime.command}): DATA_DIR owner 與 workspace 不符`); return;
    }
    const occupant = await checkPortOwnership(runtime.port, { desiredJobId: run.id, desiredDataDir: dataDir, rtDir: RT });
    if (occupant.owner === 'unknown' || occupant.owner === 'studio' && occupant.runtime?.runtime_id !== runtime.runtime_id) {
      block(occupant.reason || `PID ${occupant.pid}: port ${runtime.port} 有其他 runtime 使用`); return;
    }
    const verified = await verifyRuntimeProcess(runtime);
    if (!verified.ok) { block(verified.reason); return; }
    if (!canProceed()) return;
    const probe = await checkBackendReadiness({ ...runtime, rtDir: RT }, { isPidAlive });
    const smoke = async (replacement) => {
      const response = await fetch(`http://127.0.0.1:${replacement.port}${replacement.smoke_path || '/health'}`, { signal: AbortSignal.timeout(3000) });
      return response.status === 200 ? { ok: true, status: response.status } : { ok: false, reason: `Smoke HTTP ${response.status}` };
    };
    if (probe.status === 'BACKEND_READY') {
      const checked = await smoke(runtime);
      if (!checked.ok) { block(checked.reason, false); return; }
      if (canProceed()) wake(w, t, 'Studio 已確認 backend process、port、/health 與 smoke check 均通過，現在自動繼續。');
      return;
    }
    // Keep checking a replacement still starting. Do not restart it on every timer tick.
    if (wait.replacementId === runtime.runtime_id) { block(probe.reason, false); return; }
    const result = await recoverOwnedRuntime(runtime, {
      workspace, dataDir, canProceed,
      cleanup: (old) => cleanupRuntime(old, { rtDir: RT }),
      restart: async (old) => {
        if (!canProceed()) throw new Error('job is no longer authorized to start a backend');
        const replacement = await spawnManagedProcess({ ...old, studio_pid: process.pid });
        wait.replacementId = replacement.runtime_id;
        saveRun(w, 'running');
        return replacement;
      },
      readiness: async (replacement) => {
        for (let i = 0; i < 20 && canProceed(); i++) {
          const value = await checkBackendReadiness({ ...replacement, rtDir: RT }, { isPidAlive });
          if (value.status === 'BACKEND_READY' || !isPidAlive(replacement.root_pid)) return value;
          await sleep(500);
        }
        return checkBackendReadiness({ ...replacement, rtDir: RT }, { isPidAlive });
      },
      smoke,
      continueJob: async () => { if (canProceed()) wake(w, t, 'Studio 已安全清理並重啟 backend；/health 與 smoke 通過，現在自動繼續。'); }
    });
    if (result.status === 'blocked') block(result.reason, result.manual);
  } catch (error) { block(error.message, false); }
}

async function spawnManagedProcess(options) {
  const { launchArgs, ...persisted } = options;
  const child = spawn(options.executable, launchArgs || options.args, {
    cwd: options.cwd, env: { ...recoveryEnv(), ...options.env }, windowsHide: true, stdio: 'ignore'
  });
  let runtime, exited = false;
  child.on('error', (error) => { if (runtime) updateRuntime(runtime.runtime_id, { status: 'exited', blocked_reason: error.message }, { rtDir: RT }); });
  child.once('exit', () => { exited = true; if (runtime) updateRuntime(runtime.runtime_id, { status: 'exited' }, { rtDir: RT }); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    runtime = registerRuntime({ ...persisted, root_pid: child.pid, process_identity: await getProcessInfo(child.pid),
      child_pids: [], status: exited ? 'exited' : 'running', rtDir: RT });
    return runtime;
  } catch (error) { await killProcessTree(child.pid); throw error; }
}

function watchBackendWaits() {
  for (const w of S.workspaces) if (w.run?.active) for (const t of w.tasks) recoverBackendWait(w, t);
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function startManagedRuntime(body) {
  const w = wsOf(body.ws);
  w.runtimeStarts ||= new Map();
  if (w.runtimeStarts.has(body.cardId)) throw new Error('runtime start already pending for card');
  const step = startManagedRuntimeStep(body);
  w.runtimeStarts.set(body.cardId, step);
  step.finally(() => { if (w.runtimeStarts.get(body.cardId) === step) w.runtimeStarts.delete(body.cardId); }).catch(() => {});
  return step;
}
async function startManagedRuntimeStep(body) {
  const w = wsOf(body.ws), task = w.tasks.find((x) => x.id === body.cardId);
  if (!task || !w.run?.active || w.run.paused || w.run.stopped || task.hold || task.status !== 'WORKING' || !isWriter(task)) throw new Error('runtime 必須綁定持有 write lease 的進行中工作卡');
  const run = w.run, generation = task.leaseGeneration || 0;
  const authorized = () => {
    loadLeases();
    const lease = writerOf(treeKey(task.workdir || w.project));
    return w.run === run && run.active && !run.paused && !run.stopped && !task.hold && task.status === 'WORKING'
      && (task.leaseGeneration || 0) === generation && lease?.instance === INSTANCE && sameCard(lease, w, task) && !lease.revoked && !lease.jobStopped;
  };
  if (!authorized()) throw new Error('Workspace write lease 未確認');
  const workspace = canonPath(task.workdir || w.project);
  const cwd = canonPath(body.cwd || workspace);
  if (!body.dataDir) throw new Error('runtime dataDir 必須明確指定');
  const dataDir = path.resolve(String(body.dataDir));
  const executable = path.resolve(String(body.executable || ''));
  const args = body.args;
  const port = Number(body.port);
  if (!path.isAbsolute(String(body.executable || '')) || !Array.isArray(args) || args.some((x) => typeof x !== 'string')) throw new Error('runtime executable 必須為絕對路徑，args 必須是字串陣列');
  if (!within(workspace, cwd) || !fs.existsSync(dataDir) || !within(workspace, canonPath(dataDir))) throw new Error('runtime cwd 與既有 data_dir 必須位於該卡的工作區內');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !fs.existsSync(executable)) throw new Error('runtime executable 或 port 不合法');
  const occupied = await checkPortOwnership(port, { desiredJobId: run.id, desiredDataDir: dataDir, rtDir: RT });
  if (occupied.status !== 'free') throw new Error(occupied.reason || `port ${port} 已被佔用 (PID ${occupied.pid})`);
  if (!authorized()) throw new Error('runtime start cancelled: workspace ownership changed');
  const appEnv = { DATA_DIR: dataDir, PORT: String(port) };
  const restartSafe = body.noCredentialsConfirmed === true && !args.some((arg) => /--?(?:token|password|secret|api[-_]?key)(?:\s|=|$)/i.test(arg));
  const runtime = await spawnManagedProcess({
    job_id: run.id, card_id: task.id, workspace, purpose: body.purpose || 'dev_backend',
    executable, command: restartSafe ? [executable, ...args].join(' ') : path.basename(executable), args: restartSafe ? args : [], launchArgs: args, cwd, env: appEnv, port, data_dir: dataDir,
    smoke_path: body.smokePath || '/health', restart_safe: restartSafe
  });
  if (!authorized()) { await cleanupRuntime(runtime, { rtDir: RT }); throw new Error('runtime start cancelled: workspace ownership changed'); }
  return { runtime, readiness: await checkBackendReadiness({ ...runtime, rtDir: RT }, { isPidAlive }) };
}

const routes = {
  'POST /api/limits/refresh': async () => { refreshCodexLimits(); await refreshClaudeLimits(); },
  'POST /api/notify': (b) => { S.notify = !!b.on; saveSettings(); },
  'GET /api/state': () => {
    const workspaces = S.workspaces.map((w) => {
      const r = w.run;
      const key = w.wsKey || treeKey(w.project), live = S.leases.filter((l) => l.key === key && l.status !== 'RELEASED' && leaseState(l) !== 'RELEASED');
      const lease = { writer: live.filter((l) => l.mode === 'write').map(leaseView)[0] || null, readers: live.filter((l) => l.mode === 'read').map(leaseView) };
      const wr = lease.writer;
      const readers = (lease.readers || []).map((x) => x.owner).join(', ') || '—';
      const repo = w.wsInfo?.repo || wr?.repo || path.basename(w.project);
      const branch = w.wsInfo?.branch || wr?.branch || '—';
      const writerStr = wr ? `${wr.owner} / ${repo} / ${branch}` : '—';
      const workspace_summary = `Writer: ${writerStr} · Readers: ${readers} · branch: ${branch} · worktree: ${w.wsInfo?.path || w.project} · lease: ${wr?.state || (wr ? 'ACTIVE' : 'FREE')}`;
      const tasks = (w.tasks || []).map((t) => {
        let blocked_reason = '';
        if (t.wait?.recoveryReason) {
          const raw = String(t.wait.recoveryReason).trim();
          blocked_reason = raw.startsWith('Blocked') ? raw.replace(/^Blocked\s*[:：]\s*/i, 'Blocked：') : `Blocked：${raw}`;
        } else if (t.blocked?.owner) {
          blocked_reason = `Blocked：workspace currently owned by ${t.blocked.owner}`;
        } else if (t.blockReason) {
          const raw = String(t.blockReason).trim();
          blocked_reason = raw.startsWith('Blocked') ? raw.replace(/^Blocked\s*[:：]\s*/i, 'Blocked：') : `Blocked：${raw}`;
        } else if (t.wait?.error) {
          const raw = String(t.wait.error).trim();
          blocked_reason = raw.startsWith('Blocked') ? raw.replace(/^Blocked\s*[:：]\s*/i, 'Blocked：') : `Blocked：${raw}`;
        }
        return { ...t, blocked_reason: blocked_reason || null, ...(t.status === 'WORKING' ? { activity: convActivity.get(convOf(w, t)) || null } : {}) };
      });
      return { wsInfo: w.wsInfo, lease, workspace_summary, project: w.project, name: label(w), leader: w.leader, agentCfg: w.agentCfg, workers: w.workers, pstate: w.pstate, afterDone: w.afterDone, autoRounds: w.autoRounds, strategy: w.strategy, delivery: w.delivery, tiers: tiersOf(w), tasks, activity: w.activity, progress: readProjectProgress(w),
        run: r && { extMod: r.extMod, claimedBy: r.claimedBy, id: r.id, active: r.active, stopped: r.stopped, paused: r.paused, phase: r.phase, leader: r.leader, request: r.request, startedAt: r.startedAt, result: r.result, ask: r.ask, continues: r.continues, summarizing: r.summarizing, notes: (r.notes || []).length, noting: !!r.noting } };
    });
    return { ...S, runtimes: S.runtimes, ...teamStats(), agents: Object.values(S.agents), workspaces };
  },
  // Project-scoped calls name their project in `ws` (its folder path).
  'POST /api/pause': (b) => pauseAndDrain(wsOf(b.ws)),
  'POST /api/resume': (b) => resume(b.ws ? wsOf(b.ws) : null, b.id, { confirmExternal: !!b.confirmExternal }),
  // Workspace leases. External programs / other AI sessions use claim / release-claim to say "I am editing this folder now".
  'GET /api/leases': () => S.leases.filter((l) => l.status !== 'RELEASED').map(leaseView),
  'POST /api/workspace/claim': (b) => claimWorkspace(b.path || wsOf(b.ws).project, { label: b.label, pid: b.pid, note: b.note, description: b.description, session: b.session }),
  'POST /api/workspace/release-claim': (b) => releaseClaim(b.path || wsOf(b.ws).project),
  'POST /api/handoff': (b) => handoffWriter(wsOf(b.ws), b.agent, b.taskId),
  'POST /api/card/readonly': (b) => useReadOnly(wsOf(b.ws), b.taskId),
  'POST /api/card/worktree': (b) => useWorktree(wsOf(b.ws), b.taskId),
  'POST /api/lease/release': (b) => { const l = S.leases.find((x) => x.id === b.id); if (!l) throw new Error('找不到這個租約'); if (['ACTIVE', 'EXTERNAL'].includes(leaseState(l))) throw new Error('這個租約的持有者還活著，不能強制釋放；請先暫停或交接'); retire(l, '使用者手動釋放'); saveLeases(); },
  'POST /api/paseo/open': (b) => openInPaseo(wsOf(b.ws)),
  'POST /api/workspace/open': (b) => openWorkspace(b.path),
  'POST /api/workspace/close': (b) => closeWorkspace(wsOf(b.ws)),
  'POST /api/workspace/rename': (b) => renameWorkspace(wsOf(b.ws), b.name),
  'POST /api/notify/test': () => windowsToast('測試通知：Studio 通知正常', '專案完成或需要你處理時會這樣通知你', `http://127.0.0.1:${PORT}/`),
  'POST /api/browse': async () => { const p = await browseFolder(); return p ? openWorkspace(p) : {}; },
  'POST /api/leader': (b) => setLeader(wsOf(b.ws), b.agent),
  'POST /api/start': (b) => { const w = wsOf(b.ws); w.autoRounds = 0; return start(w, String(b.request || ''), !!b.continue); },
  'POST /api/after-done': (b) => setAfterDone(wsOf(b.ws), b.mode),
  'POST /api/delivery': (b) => setDelivery(wsOf(b.ws), b.mode),
  'POST /api/stop': (b) => stopAndDrain(wsOf(b.ws)),
  'POST /api/reassign': (b) => reassign(wsOf(b.ws), b.taskId, b.agent),
  'POST /api/continue': (b) => { const w = wsOf(b.ws); w.autoRounds = 0; return continueProject(w); },
  'POST /api/project-state/refresh': (b) => refreshState(wsOf(b.ws)),
  'POST /api/instruct': (b) => instruct(wsOf(b.ws), b.text, !!b.interrupt),
  'POST /api/strategy': (b) => setStrategy(wsOf(b.ws), b.strategy),
  'POST /api/answer': (b) => answer(wsOf(b.ws), b.taskId, b.text),
  'POST /api/continue-card': (b) => continueCard(wsOf(b.ws), b.taskId),
  'POST /api/card/detail': (b) => cardDetail(wsOf(b.ws), b.taskId),
  'POST /api/card/ask': (b) => askAgent(wsOf(b.ws), b.taskId, b.text),
  'POST /api/check': () => { checkAll().then(refreshClaudeLimits); },
  'POST /api/recent/remove': (b) => removeRecent(b.path),
  'POST /api/agent-config': (b) => setAgentCfg(wsOf(b.ws), b.agent, b.model, b.effort, b.hardModel, b.hardEffort),
  'POST /api/workers': (b) => setWorker(wsOf(b.ws), b.agent, !!b.on),
  'POST /api/external/save': (b) => saveExternal(b),
  'POST /api/external/delete': (b) => deleteExternal(b.id),
  'POST /api/external/models': (b) => extModels(b),
  'POST /api/external/check': (b) => { if (!extOf(b.id)) throw new Error('找不到這個外部模型'); checkAgent(b.id); },
  // One-time login for Studio's separate Codex home, in a visible console window.
  // Claude uses the machine's normal Claude Code login (no separate home).
  'POST /api/claude-login': () => { spawn('cmd', ['/c', 'start', 'Claude login (Studio)', 'cmd', '/k', 'claude', 'auth', 'login'], { detached: true, stdio: 'ignore' }); },
  'POST /api/codex-login': () => { spawn('cmd', ['/c', 'start', 'Codex login (Studio)', 'cmd', '/k', 'codex', 'login'], { env: { ...process.env, CODEX_HOME }, detached: true, stdio: 'ignore' }); },
  'GET /api/history': () => listHistory(),
  'GET /api/runtimes': () => refreshRuntimeReadiness(),
  'POST /api/runtime/start': (b) => startManagedRuntime(b),
  'POST /api/runtime/readiness': async (b) => {
    const runtime = listRuntimes({ rtDir: RT }).find((x) => x.runtime_id === b.runtimeId);
    if (!runtime) throw new Error('找不到這個 Studio runtime');
    return checkBackendReadiness({ ...runtime, rtDir: RT }, { isPidAlive });
  },
  'POST /api/runtime/check-port': (b) => checkPortOwnership(Number(b.port), { desiredJobId: b.jobId, desiredDataDir: b.dataDir, rtDir: RT }),
  'POST /api/runtime/cleanup-stale': () => cleanupStaleRuntimes({ rtDir: RT }),
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

loadLeases(); // restore ownership before any worker can start
await cleanupStaleRuntimes({ rtDir: RT }).catch(() => {});

// Show each open project's latest paused job again after a restart, ready to continue.
for (const w of S.workspaces) {
  const r = historyItems().find((x) => same(x.project, w.project));
  if (r && resumable(r)) loadRun(w, r);
}

await startAion();
watchCatalogs();
pollPaseo();
setInterval(pollPaseo, 10000);
setInterval(watchExternal, 60000); // GitHub PR / CI waits
await refreshRuntimeReadiness();
setInterval(() => refreshRuntimeReadiness().catch(() => {}), 10000);
setInterval(watchBackendWaits, 5000); // owned backend recovery is readiness-gated
setInterval(beatLeases, LEASE_BEAT_MS); // heartbeat of the leases this Studio holds
setInterval(() => pollAsks().catch(() => {}), 10000); // answers to questions sent in the middle of a turn
setInterval(() => checkWorkspaces().catch(() => {}), 15000); // unknown changes to a tree Studio holds
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
