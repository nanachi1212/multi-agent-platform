import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { processSnapshot, processTree } from './codex-runtime.mjs';
import { writeJson } from './state-files.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function receiptPath(rtDir, cid) {
  if (typeof cid !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(cid)) throw new Error('無法辨識 Claude 對話 ID');
  return path.join(rtDir, 'studio', 'claude-stops', cid + '.json');
}
function readReceipt(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}
async function sessionAnchor(rtDir, cid) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(rtDir, 'studio', 'data', 'aionui-backend.db'), { readOnly: true });
  try {
    const id = db.prepare('SELECT session_id FROM acp_session WHERE conversation_id = ?').get(cid)?.session_id;
    if (!uuid.test(id)) throw new Error('無法確認 Claude 原始工作階段');
    return id;
  } finally { db.close(); }
}
function nativeSession(rows, owner, anchor) {
  const parent = rows.find(p => p.pid === owner?.pid);
  if (!parent?.creationDate || parent.creationDate !== owner.creationDate || !parent.executable
      || parent.executable.toLowerCase() !== owner.executable?.toLowerCase()) throw new Error('無法確認 AionCore 程序身分');
  const sessionArg = new RegExp('(?:^|\\s)"?--(session-id|resume)"?\\s+"?' + anchor + '"?(?=\\s|$)', 'i');
  const candidates = rows.filter(p => p.parent === parent.pid
    && path.win32.basename(p.executable).toLowerCase() === 'claude.exe' && sessionArg.test(p.command));
  if (candidates.length !== 1) return null;
  const root = candidates[0];
  if (processTree([parent, root], parent).length !== 2) return null;
  return { root, mode: sessionArg.exec(root.command)[1].toLowerCase() };
}
const idle = rt => rt?.state === 'idle' && rt.is_processing === false && rt.has_task === true;
const present = (rows, old) => rows.some(p => p.pid === old.pid && (!p.creationDate || p.creationDate === old.creationDate));

// Invalidate the previous stop before sending. An interrupted/incomplete restart must be retried first.
export function admitClaudeMessage(rtDir, cid) {
  const file = receiptPath(rtDir, cid), receipt = readReceipt(file);
  if (!receipt) return;
  if (receipt.state !== 'drained') throw Object.assign(new Error('Claude 上次停止尚未確認；保留原對話與租約'), { stopUnconfirmed: true });
  fs.unlinkSync(file);
}

const sending = new Map();
export async function sendClaudeMessage(rtDir, cid, owner, send) {
  admitClaudeMessage(rtDir, cid);
  const group = sending.get(cid) || new Set();
  sending.set(cid, group);
  const pending = send().catch(error => {
    if (error.stopUnconfirmed) {
      const file = receiptPath(rtDir, cid), receipt = readReceipt(file) || { state: 'pending', tree: [] };
      receipt.uncertainSender = { pid: owner?.pid, creationDate: owner?.creationDate };
      writeJson(file, receipt);
    }
    throw error;
  });
  group.add(pending);
  try { return await pending; }
  finally { group.delete(pending); if (!group.size) sending.delete(cid); }
}

// Observe the named conversation only. AionCore owns process termination; Studio verifies the old
// process identities and the replacement CLI's --resume anchor before acknowledging the stop.
export async function stopClaudeConversation({ cid, api, owner, rtDir, snapshot = processSnapshot, anchor = sessionAnchor, allowRestart = true }) {
  const file = receiptPath(rtDir, cid), endpoint = '/api/conversations/' + cid;
  await Promise.allSettled(sending.get(cid) || []);
  let receipt = readReceipt(file);
  if (!receipt) {
    receipt = { state: 'pending', tree: [] };
    writeJson(file, receipt);
  }
  const current = await api('GET', endpoint);
  if (receipt?.state === 'drained' && current.runtime?.is_processing === false && !current.runtime.turn_id
      && (current.runtime.state === 'idle' || current.runtime.has_task === false)) return true;
  if (receipt.state === 'drained') {
    receipt = { state: 'pending', tree: [] };
    writeJson(file, receipt);
  }
  const cancel = async () => {
    if (current.runtime?.turn_id) await api('POST', endpoint + '/cancel', { turn_id: current.runtime.turn_id });
  };
  const sender = receipt.uncertainSender, controller = owner();
  const uncertain = sender && (!sender.creationDate || !controller?.creationDate
    || (controller.pid === sender.pid && controller.creationDate === sender.creationDate));
  if (!receipt.tree.length && !uncertain && current.runtime?.has_task === false && current.runtime.is_processing === false) {
    const messages = await api('GET', endpoint + '/messages?limit=1');
    if (Array.isArray(messages?.items) && messages.items.length === 0) {
      writeJson(file, { state: 'drained' });
      return true; // This conversation was created but never ran a turn.
    }
  }
  let id, rows, original;
  try {
    id = await anchor(rtDir, cid);
    if (!uuid.test(id) || (receipt.anchor && receipt.anchor !== id)) { await cancel(); return false; }
    rows = await snapshot();
    original = nativeSession(rows, controller, id);
  } catch {
    await cancel();
    return false;
  }
  receipt.anchor = id;
  if (original && (!receipt.tree.length || present([original.root], receipt.tree[0]))) {
    const observed = processTree(rows, original.root);
    for (const p of observed) if (!receipt.tree.some(old => old.pid === p.pid && old.creationDate === p.creationDate)) receipt.tree.push(p);
    writeJson(file, receipt);
    await cancel();
    if (!allowRestart || uncertain) return false;
    const result = await api('POST', endpoint + '/runtime/restart', {});
    if (!idle(result?.runtime)) return false;
  } else if (!receipt.tree.length || uncertain) {
    await cancel();
    return false;
  } else if (allowRestart && !original && receipt.tree.every(old => !present(rows, old)) && current.runtime?.has_task === false) {
    await api('POST', endpoint + '/runtime/ensure', {});
  }
  // A lost restart response can be retried: inspect the saved identities before touching the replacement.
  for (let attempt = 0; attempt < 6; attempt++) {
    rows = await snapshot();
    const replacement = nativeSession(rows, owner(), id);
    if (replacement?.mode === 'resume' && receipt.tree.every(old => !present(rows, old))
        && idle((await api('GET', endpoint)).runtime)) {
      writeJson(file, { state: 'drained' });
      return true;
    }
    if (attempt < 5) await sleep(200);
  }
  return false;
}
