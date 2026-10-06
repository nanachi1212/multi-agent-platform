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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Agents are just a catalog; any of them can be Leader or Worker.
// Leader sessions use non-writing modes, Worker sessions may edit the project.
const AGENTS = {
  claude: { name: 'Claude Code', create: (ws, lead) => ({ type: 'acp', extra: { backend: 'claude', workspace: ws, session_mode: lead ? 'dontAsk' : 'bypassPermissions' } }) },
  codex: { name: 'Codex', create: (ws, lead) => ({ type: 'acp', extra: { backend: 'codex', workspace: ws, session_mode: lead ? 'read-only' : 'auto' } }) },
  antigravity: { name: 'Antigravity', create: (ws, lead) => ({ type: 'antigravity', extra: { backend: 'antigravity', workspace: ws, session_mode: lead ? 'plan' : 'yolo' } }) },
};

const S = { project: '', leader: 'codex', agents: {}, tasks: [], activity: [], run: null };
for (const [id, a] of Object.entries(AGENTS)) S.agents[id] = { id, name: a.name, status: 'checking', note: '', working: 0 };

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
  const logFile = fs.createWriteStream(path.join(RT, 'studio', 'aioncore.out.txt'));
  const p = spawn(AION, ['--local', '--port', '0', '--data-dir', data, '--work-dir', work, '--managed-resources-mode', 'bundled', '--parent-pid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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

async function createConv(agent, ws, lead) {
  // Right after READY, create can briefly 400 (assistant catalog race seen in P0).
  for (let i = 0; ; i++) {
    try { return (await api('POST', '/api/conversations', AGENTS[agent].create(ws, lead))).id; }
    catch (e) { if (i >= 4) throw e; await sleep(1000); }
  }
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
  if (!check && run?.stopped) throw new Error('已停止');
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

async function conv(agent, lead) {
  const key = agent + (lead ? ':lead' : ':work');
  return (S.run.convs[key] ??= await createConv(agent, S.project, lead));
}

function planPrompt(request, workers) {
  return `You are the LEADER (foreman) of a small AI team in "Multi-Agent Studio".
Project folder: ${S.project}
Workers you can assign: ${workers.map((w) => `${w} (${AGENTS[w].name})`).join(', ')}

User request:
"""
${request}
"""

Rules:
- Do NOT do the work yourself. Do NOT create or modify any files. Only plan and delegate.
- Split the request into 1 to 3 small subtasks. Each subtask goes to exactly one worker id from the list above.
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

async function start(request) {
  if (S.run?.active) throw new Error('團隊正在工作中，請先等待或按 Stop');
  if (!S.project || !fs.existsSync(S.project)) throw new Error('請先選擇存在的專案資料夾');
  if (!request.trim()) throw new Error('請輸入需求');
  const lead = S.leader;
  if (!available(lead)) throw new Error(`Leader ${AGENTS[lead].name} 目前不可用`);
  const workers = Object.keys(AGENTS).filter((id) => id !== lead && available(id));
  if (!workers.length) throw new Error('至少需要一位可用的 Worker');

  S.tasks = [];
  S.activity = [];
  const run = (S.run = { request, convs: {}, active: true, stopped: false, summarizing: false });
  log('user', 'user', request);
  log('studio', 'system', `Leader：${AGENTS[lead].name}；Workers：${workers.map((w) => AGENTS[w].name).join('、')}`);
  (async () => {
    try {
      const reply = await turn(lead, await conv(lead, true), planPrompt(request, workers), { lead: true });
      let plan;
      try { plan = parsePlan(reply, workers); } catch { throw new Error('Leader 回覆無法解析為工作清單：' + reply.slice(0, 500)); }
      if (!plan.subtasks.length) throw new Error('Leader 沒有產生任何工作：' + reply.slice(0, 500));
      log(lead, 'leader', plan.message || `已拆成 ${plan.subtasks.length} 項工作`);
      for (const st of plan.subtasks) {
        S.tasks.push({ id: crypto.randomUUID().slice(0, 8), ...st, status: 'WAITING', result: '' });
        log(lead, 'leader', `派工給 ${AGENTS[st.agent].name}：${st.title}`);
      }
      pump();
    } catch (e) {
      log('studio', 'system', (run.stopped ? '已停止：' : 'Leader 失敗：') + e.message);
      run.active = false;
    }
  })();
}

// Start every WAITING task whose agent is free; when all are finished, the Leader writes the report.
function pump() {
  const run = S.run;
  if (!run || run.stopped) return;
  for (const t of S.tasks) {
    if (t.status === 'WAITING' && !S.tasks.some((x) => x.status === 'WORKING' && x.agent === t.agent)) runTask(t);
  }
  if (run.active && !run.summarizing && S.tasks.length && S.tasks.every((t) => t.status === 'DONE' || t.status === 'FAILED')) summarize(run);
}

async function runTask(t) {
  t.status = 'WORKING';
  log(t.agent, 'worker', `開始工作：${t.title}`);
  try {
    const prompt = `You are a WORKER in "Multi-Agent Studio". Your leader (${AGENTS[S.leader].name}) assigned you this task.
Work only inside the project folder: ${S.project}

Task: ${t.title}
Instructions:
${t.instructions}

When finished, reply with a short summary of what you did (1-3 sentences).`;
    t.result = (await turn(t.agent, await conv(t.agent, false), prompt)) || '(完成，沒有文字回覆)';
    t.status = 'DONE';
    log(t.agent, 'worker', t.result);
  } catch (e) {
    t.status = 'FAILED';
    t.result = e.message;
    log(t.agent, 'worker', '失敗：' + e.message);
  }
  pump();
}

async function summarize(run) {
  run.summarizing = true;
  const lead = S.leader;
  const results = S.tasks.map((t) => `- [${t.status}] ${t.title} (${AGENTS[t.agent].name}): ${t.result}`).join('\n');
  try {
    const txt = await turn(lead, await conv(lead, true), `You are the LEADER. The workers have finished.
Original user request:
"""
${run.request}
"""
Results:
${results}

Do not modify files. Write a short final report to the user (2-4 sentences, in the user's language). Plain text only.`, { lead: true });
    log(lead, 'leader', txt || '(沒有文字回覆)');
  } catch (e) {
    log('studio', 'system', 'Leader 總結失敗：' + e.message);
  }
  run.summarizing = false;
  run.active = false;
}

function stop() {
  const run = S.run;
  if (!run?.active) return;
  run.stopped = true;
  run.active = false;
  for (const [cid, turnId] of active) api('POST', `/api/conversations/${cid}/cancel`, { turn_id: turnId }).catch(() => {});
  for (const t of S.tasks) if (t.status === 'WAITING') { t.status = 'FAILED'; t.result = '已停止'; }
  log('studio', 'system', '已按下 Stop：所有 Agent 停止目前工作。');
}

function reassign(taskId, agent) {
  const t = S.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('找不到這項工作');
  if (t.status === 'WORKING') throw new Error('工作進行中，請先 Stop');
  if (!available(agent)) throw new Error(`${AGENTS[agent]?.name ?? agent} 目前不可用`);
  t.agent = agent;
  t.status = 'WAITING';
  t.result = '';
  log('user', 'user', `重新指派「${t.title}」給 ${AGENTS[agent].name}`);
  Object.assign(S.run, { active: true, stopped: false });
  pump();
}

function setLeader(agent) {
  if (!AGENTS[agent]) throw new Error('未知的 Agent');
  if (!available(agent)) throw new Error(`${AGENTS[agent].name} 目前不可用`);
  if (S.leader !== agent) log('studio', 'system', `Leader 換成 ${AGENTS[agent].name}`);
  S.leader = agent;
}

function setProject(p) {
  p = path.resolve(String(p || '').trim());
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('資料夾不存在：' + p);
  S.project = p;
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

// ---------- HTTP ----------
const routes = {
  'GET /api/state': () => ({ ...S, run: S.run && { active: S.run.active, stopped: S.run.stopped }, agents: Object.values(S.agents), progress: readProjectProgress() }),
  'POST /api/project': (b) => setProject(b.path),
  'POST /api/browse': async () => { const p = await browseFolder(); if (p) setProject(p); return { path: p }; },
  'POST /api/leader': (b) => setLeader(b.agent),
  'POST /api/start': (b) => start(String(b.request || '')),
  'POST /api/stop': () => stop(),
  'POST /api/reassign': (b) => reassign(b.taskId, b.agent),
  'POST /api/check': () => { checkAll(); },
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body ?? {}) : body); };
  // Local-only: reject other hosts (DNS rebinding) and non-JSON POSTs (cross-site form posts).
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'forbidden' });
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, fs.readFileSync(path.join(import.meta.dirname, 'index.html')), 'text/html; charset=utf-8');
  const fn = routes[`${req.method} ${req.url}`];
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

await startAion();
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Multi-Agent Studio 已啟動：${url}  （關閉此視窗即停止）`);
  if (!process.env.STUDIO_NO_OPEN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
});
checkAll();
