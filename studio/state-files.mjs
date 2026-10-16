import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getProcessInfo, isPidAlive } from './runtime-registry.mjs';

export function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2);
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', flush: true });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

// One controller owns settings, history and schedules for each runtime directory.
// A lock owner is live only while its PID still has the creation time and executable recorded in the lock (Windows reuses PIDs).
export async function claimRuntime(rt) {
  const file = path.join(rt, 'studio', 'instance.lock');
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const self = await getProcessInfo(process.pid);
  const identity = { pid: process.pid, creationDate: self.creationDate, executable: self.executable };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error('無法確認 Studio runtime 持有者，保留鎖定'); } };
  const alive = async (o) => {
    if (!Number.isInteger(o?.pid) || o.pid <= 0) return true;
    if (!isPidAlive(o.pid)) return false;
    const now = await getProcessInfo(o.pid);
    if (!o.creationDate || !o.executable || !now.creationDate) return true; // identity unknown: keep the lock
    return String(now.creationDate) === String(o.creationDate) && now.executable.toLowerCase() === o.executable.toLowerCase();
  };
  const reclaim = file + '.reclaim';
  const openReclaim = async () => {
    try { return fs.openSync(reclaim, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await alive(read(reclaim))) throw new Error('另一個 Studio 正在接手 runtime，拒絕重複啟動');
      fs.unlinkSync(reclaim); return fs.openSync(reclaim, 'wx'); // the previous reclaimer died
    }
  };
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (await alive(read(file))) throw new Error('同一 runtime 的 Studio 已在執行，拒絕重複啟動');
    const recovery = await openReclaim();
    try {
      fs.writeFileSync(recovery, JSON.stringify(identity));
      if (await alive(read(file))) throw new Error('Studio runtime 已由另一個實例接手');
      fs.unlinkSync(file); fd = fs.openSync(file, 'wx');
    } finally { fs.closeSync(recovery); fs.unlinkSync(reclaim); }
  }
  try { fs.writeFileSync(fd, JSON.stringify({ ...identity, token })); }
  finally { fs.closeSync(fd); }
  return () => {
    if (!fs.existsSync(file)) return;
    if (read(file)?.token === token) fs.unlinkSync(file);
  };
}
