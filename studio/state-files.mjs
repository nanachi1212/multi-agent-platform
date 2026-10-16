import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
export function claimRuntime(rt) {
  const file = path.join(rt, 'studio', 'instance.lock');
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  const owner = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('無法確認 Studio runtime 持有者，保留鎖定'); } };
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (alive(owner()?.pid)) throw new Error('同一 runtime 的 Studio 已在執行，拒絕重複啟動');
    const recovery = fs.openSync(file + '.reclaim', 'wx');
    try {
      if (alive(owner()?.pid)) throw new Error('Studio runtime 已由另一個實例接手');
      fs.unlinkSync(file); fd = fs.openSync(file, 'wx');
    } finally { fs.closeSync(recovery); fs.unlinkSync(file + '.reclaim'); }
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
  finally { fs.closeSync(fd); }
  return () => {
    if (!fs.existsSync(file)) return;
    if (owner()?.token === token) fs.unlinkSync(file);
  };
}
