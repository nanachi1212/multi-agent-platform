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

// S.leader is the default Leader for newly opened projects.
const S = { leader: 'codex', recent: [], historyRev: 0, agentCfg: {}, agents: {}, workspaces: [],
  limits: {}, notify: true, notices: [], noticeSeq: 0 };
// One workspace per project folder: its own Leader, board, team chat and run, so projects work side by side.
// name = optional display name (tabs, cards, notifications); the folder name is used when empty.
// agentCfg = this project's model / effort per agent; workers = agents allowed to work here.
// New projects start from S.agentCfg (the last choices).
const newWs = (project, leader = S.leader, name = '', agentCfg = S.agentCfg, workers = Object.keys(AGENTS)) => ({
  project, leader, name, run: null, tasks: [], activity: [],
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
    .map((x) => newWs(x.project, AGENTS[x.leader] ? x.leader : S.leader, String(x.name || ''), x.agentCfg || S.agentCfg, x.workers || Object.keys(AGENTS)));
  S.recent = (saved.recent || []).filter(isDir);
  if (saved.notify === false) S.notify = false;
} catch { /* first start: defaults */ }

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const workspaces = S.workspaces.map((w) => ({ project: w.project, leader: w.leader, name: w.name, agentCfg: w.agentCfg, workers: w.workers }));
  fs.writeFileSync(SETTINGS, JSON.stringify({ leader: S.leader, workspaces, recent: S.recent, agentCfg: S.agentCfg, notify: S.notify }, null, 2));
}

function saveRun(w, status) {
  const run = w.run;
  if (!run) return;
  fs.mkdirSync(HISTORY, { recursive: true });
  // phase + convs let a paused run continue in the same agent conversations after a Studio restart.
  const rec = { id: run.id, startedAt: run.startedAt, finishedAt: new Date().toISOString(), status, phase: run.phase, project: run.project, leader: run.leader, request: run.request, convs: run.convs, tasks: w.tasks, activity: w.activity };
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
function log(w, who, role, text) {
  w?.activity.push({ time: new Date().toLocaleTimeString('zh-TW', { hour12: false }), who, role, text: String(text) });
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

// Per project; the last choice is also the default for the next opened project.
function setAgentCfg(w, agent, model, effort) {
  const a = S.agents[agent];
  if (!a) throw new Error('未知的 Agent');
  if (model && !a.models.some((m) => m.value === model)) throw new Error(`${a.name} 沒有這個模型：${model}`);
  if (effort && !a.efforts.includes(effort)) throw new Error(`${a.name} 不支援這個推理強度：${effort}`);
  w.agentCfg[agent] = { model: model || '', effort: effort || '' };
  S.agentCfg[agent] = { ...w.agentCfg[agent] };
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

async function conv(w, agent, lead) {
  const key = agent + (lead ? ':lead' : ':work');
  return (w.run.convs[key] ??= await createConv(agent, w.run.project, lead, w.agentCfg[agent]));
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

function finish(w, status) {
  const run = w.run;
  run.active = false;
  run.paused = false;
  run.phase = 'finished';
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
      : failed ? `「${failed.title}」失敗：${failed.result}`.slice(0, 160) : 'Leader 沒有完成派工，打開專案查看原因';
    notify(title, body, status, w.project);
  }
  refreshClaudeLimits();
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

async function start(w, request) {
  if (w.run?.active) throw new Error('這個專案的團隊正在工作中，請先等待、暫停或按 Stop');
  if (!isDir(w.project)) throw new Error('專案資料夾不存在：' + w.project);
  if (!request.trim()) throw new Error('請輸入需求');
  const lead = w.leader;
  if (!available(lead)) throw new Error(`Leader ${AGENTS[lead].name} 目前不可用`);
  if (!workersFor(w, lead).length) throw new Error('這個專案至少需要一位可用的 Worker');

  // A paused run stays in history (status "paused") and can be continued from there later.
  w.tasks = [];
  w.activity = [];
  const now = new Date();
  const id = now.toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomUUID().slice(0, 4);
  w.run = { id, startedAt: now.toISOString(), project: w.project, leader: lead, request, convs: {}, phase: 'planning', leaderGen: 0, active: true, paused: false, stopped: false, summarizing: false };
  log(w, 'user', 'user', request);
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
    const reply = await turn(lead, await conv(w, lead, true), planPrompt(run, workers), { w, lead: true });
    if (run.leaderGen !== gen) return; // a new Leader took over and plans again
    let plan;
    try { plan = parsePlan(reply, workers); } catch { throw new Error('Leader 回覆無法解析為工作清單：' + reply.slice(0, 500)); }
    if (!plan.subtasks.length) throw new Error('Leader 沒有產生任何工作：' + reply.slice(0, 500));
    log(w, lead, 'leader', plan.message || `已拆成 ${plan.subtasks.length} 項工作`);
    for (const st of plan.subtasks) {
      w.tasks.push({ id: crypto.randomUUID().slice(0, 8), ...st, status: 'WAITING', result: '' });
      log(w, lead, 'leader', `派工給 ${AGENTS[st.agent].name}：${st.title}`);
    }
    run.phase = 'working';
    pump(w);
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return; // pause: resume() plans again; stop: stop() already saved
    log(w, 'studio', 'system', 'Leader 失敗：' + e.message);
    finish(w, 'failed');
  }
}

// Start every WAITING task whose agent is free in this project; when all are finished, the Leader writes the report.
// ponytail: an agent can work for two projects at once (separate conversations); add a global per-agent slot if plan limits suffer.
function pump(w) {
  const run = w.run;
  if (!run?.active || run.paused || run.phase !== 'working') return;
  for (const t of w.tasks) {
    if (t.status === 'WAITING' && !w.tasks.some((x) => x.status === 'WORKING' && x.agent === t.agent)) runTask(w, t);
  }
  if (!run.summarizing && w.tasks.length && w.tasks.every((t) => t.status === 'DONE' || t.status === 'FAILED')) summarize(w);
}

async function runTask(w, t) {
  const run = w.run;
  t.status = 'WORKING';
  log(w, t.agent, 'worker', (t.resumed ? '繼續工作：' : '開始工作：') + t.title);
  try {
    const prompt = `You are a WORKER in "Multi-Agent Studio". Your leader (${AGENTS[run.leader].name}) assigned you this task.
Work only inside the project folder: ${run.project}
${t.resumed ? '\nYou were interrupted while doing this task earlier. First check the current state of the project folder, then finish the task without redoing work that is already done.\n' : ''}
Task: ${t.title}
Instructions:
${t.instructions}

When finished, reply with a short summary of what you did (1-3 sentences).`;
    t.result = (await turn(t.agent, await conv(w, t.agent, false), prompt, { w })) || '(完成，沒有文字回覆)';
    t.status = 'DONE';
    t.doneAt = new Date().toISOString();
    log(w, t.agent, 'worker', t.result);
  } catch (e) {
    if (e instanceof Halt && run.paused) { t.status = 'PAUSED'; t.result = '已暫停'; t.resumed = true; return; }
    t.status = 'FAILED';
    t.result = e.message;
    log(w, t.agent, 'worker', '失敗：' + e.message);
  }
  pump(w);
}

async function summarize(w) {
  const run = w.run;
  run.summarizing = true;
  run.phase = 'summarizing';
  const gen = run.leaderGen, lead = run.leader;
  const results = w.tasks.map((t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent].name}): ${t.result}`).join('\n');
  try {
    const txt = await turn(lead, await conv(w, lead, true), `You are the LEADER. The workers have finished.${handoffNote(run)}
Original user request:
"""
${run.request}
"""
Results:
${results}

Do not modify files. Write a short final report to the user (2-4 sentences, in the user's language). Plain text only.`, { w, lead: true });
    if (run.leaderGen !== gen) return;
    log(w, lead, 'leader', txt || '(沒有文字回覆)');
  } catch (e) {
    if (run.leaderGen !== gen || e instanceof Halt) return;
    log(w, 'studio', 'system', 'Leader 總結失敗：' + e.message);
  }
  run.summarizing = false;
  finish(w, w.tasks.every((t) => t.status === 'DONE') ? 'done' : 'failed');
}

function stop(w) {
  const run = w.run;
  if (!run?.active && !run?.paused) return;
  run.stopped = true;
  busyConvs(run).forEach(cancelTurn);
  for (const t of w.tasks) if (['WAITING', 'PAUSED'].includes(t.status)) { t.status = 'FAILED'; t.result = '已停止'; }
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
  // Cards that were mid-work when the Studio closed continue like paused cards.
  for (const t of r.tasks) if (t.status === 'WORKING') Object.assign(t, { status: 'PAUSED', result: '已中斷', resumed: true });
  w.tasks = r.tasks;
  w.activity = r.activity;
  w.run = { id: r.id, startedAt: r.startedAt, project: r.project, leader: r.leader, request: r.request, convs: r.convs || {}, phase: r.phase || 'working', leaderGen: 0, active: false, paused: true, stopped: false, summarizing: false };
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
  for (const t of w.tasks) if (t.status === 'PAUSED') t.status = 'WAITING';
  log(w, 'studio', 'system', `繼續工作（Leader：${AGENTS[run.leader].name}）。`);
  if (run.phase === 'planning') planPhase(w);
  else if (run.phase === 'summarizing') summarize(w);
  else { run.phase = 'working'; pump(w); }
}

function reassign(w, taskId, agent) {
  const run = w.run;
  const t = w.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這項工作');
  if (t.status === 'WORKING') throw new Error('工作進行中，請先暫停或 Stop');
  if (!available(agent)) throw new Error(`${AGENTS[agent]?.name ?? agent} 目前不可用`);
  t.agent = agent;
  t.result = '';
  log(w, 'user', 'user', `重新指派「${t.title}」給 ${AGENTS[agent].name}`);
  if (run.paused) { t.status = 'PAUSED'; saveRun(w, 'paused'); return; } // runs when the user continues
  t.status = 'WAITING';
  Object.assign(run, { active: true, stopped: false, phase: 'working' });
  pump(w);
}

// Changing the Leader mid-run hands the same job over; Workers keep their cards.
function setLeader(w, agent) {
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
  if (run.paused) return saveRun(w, 'paused');
  if (run.phase === 'planning') planPhase(w);
  else if (run.phase === 'summarizing') summarize(w);
}

// Opens a project as its own tab (or returns the open one).
function openWorkspace(p) {
  if (!String(p || '').trim()) throw new Error('請輸入資料夾路徑');
  p = path.resolve(String(p).trim());
  if (!isDir(p)) throw new Error('資料夾不存在：' + p);
  let w = S.workspaces.find((x) => same(x.project, p));
  if (!w) S.workspaces.push((w = newWs(p)));
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
      return { project: w.project, name: label(w), leader: w.leader, agentCfg: w.agentCfg, workers: w.workers, tasks: w.tasks, activity: w.activity, progress: readProjectProgress(w),
        run: r && { id: r.id, active: r.active, stopped: r.stopped, paused: r.paused, phase: r.phase, leader: r.leader, request: r.request, startedAt: r.startedAt } };
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
  'POST /api/start': (b) => start(wsOf(b.ws), String(b.request || '')),
  'POST /api/stop': (b) => stop(wsOf(b.ws)),
  'POST /api/reassign': (b) => reassign(wsOf(b.ws), b.taskId, b.agent),
  'POST /api/check': () => { checkAll().then(refreshClaudeLimits); },
  'POST /api/recent/remove': (b) => removeRecent(b.path),
  'POST /api/agent-config': (b) => setAgentCfg(wsOf(b.ws), b.agent, b.model, b.effort),
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
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Multi-Agent Studio 已啟動：${url}  （關閉此視窗即停止）`);
  if (!process.env.STUDIO_NO_OPEN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
});
refreshCodexLimits();
checkAll().then(refreshClaudeLimits);
