import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeJson } from './state-files.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const optional = (read) => { try { return read(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Only an unchanged copy with our provenance record is ours to update/remove.
// Existing unmarked files, user edits, symlinks and hard links are user-owned.
export function syncRulesFile(source, target) {
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) return false;
  const marker = target + '.studio-sync.json';
  const stat = optional(() => fs.lstatSync(target));
  if (stat && (!stat.isFile() || stat.nlink > 1)) return false;
  const current = stat ? fs.readFileSync(target) : null;
  let managed;
  try { managed = JSON.parse(fs.readFileSync(marker, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') return false; }
  const owned = managed?.source === path.resolve(source) && managed?.sha256 === (current && digest(current));
  if (current && !owned) return false;
  const incoming = optional(() => fs.readFileSync(source));
  if (!incoming) {
    if (current && owned) fs.unlinkSync(target);
    if (managed) fs.unlinkSync(marker);
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (current) {
    const temp = target + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, incoming, { flag: 'wx', flush: true }); fs.renameSync(temp, target); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  } else fs.writeFileSync(target, incoming, { flag: 'wx', flush: true });
  writeJson(marker, { source: path.resolve(source), sha256: digest(incoming) });
  return true;
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  try { for await (const chunk of fs.createReadStream(file)) hash.update(chunk); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return hash.digest('hex');
}

export async function ensureVerifiedExecutable({ target, url, archiveHash, executableHash, cachedArchive }, {
  download = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`AionCore 下載失敗：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  extract = (zip, dir) => new Promise((resolve, reject) => execFile('tar', ['-xf', path.basename(zip)],
    { cwd: dir, windowsHide: true, timeout: 120000 }, error => error ? reject(error) : resolve()))
} = {}) {
  if (await fileHash(target) === executableHash) return { installed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Same volume as the destination: only a complete verified executable is published.
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.install-'));
  try {
    // Windows tar can lose Unicode paths in argv. Use a fixed archive name in its working directory.
    const zip = path.join(stage, 'aioncore.zip');
    if (cachedArchive) {
      try { fs.copyFileSync(cachedArchive, zip); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (await fileHash(zip) !== archiveHash) {
      const bytes = await download();
      if (digest(bytes) !== archiveHash) throw new Error('AionCore 下載檔 SHA-256 不符，已中止');
      fs.writeFileSync(zip, bytes, { flush: true });
    }
    await extract(zip, stage);
    const executable = path.join(stage, path.basename(target));
    if (await fileHash(executable) !== executableHash) throw new Error('AionCore 執行檔 SHA-256 不符，已中止');
    if (await fileHash(target) === executableHash) return { installed: false }; // another Studio completed installation
    let backup = null;
    if (fs.existsSync(target)) {
      backup = target + '.unverified-' + crypto.randomUUID() + '.bak';
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(executable, target); // a running/locked executable fails without removing the old one
    return { installed: true, backup };
  } finally { fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

export function appendRotatingEvent(file, record, { maxBytes = 5 << 20, backups = 5 } = {}) {
  const line = JSON.stringify(record) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = optional(() => fs.statSync(file))?.size || 0;
  if (size && size + Buffer.byteLength(line) > maxBytes) {
    for (let i = backups; i >= 1; i--) {
      const older = file + '.' + i;
      if (i === backups) optional(() => fs.unlinkSync(older));
      else optional(() => fs.renameSync(older, file + '.' + (i + 1)));
    }
    fs.renameSync(file, file + '.1');
  }
  fs.appendFileSync(file, line);
}

// Windows CRT double-quote/backslash rules, without invoking a shell. JSON arrays
// also accept exact argv values. See Microsoft's "Parsing C command-line arguments".
export function parseAcpArgs(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (Array.isArray(input) || text.startsWith('[')) {
    let args;
    try { args = Array.isArray(input) ? input : JSON.parse(text); }
    catch { throw new Error('參數 JSON 必須是字串陣列'); }
    if (!Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('參數 JSON 必須是字串陣列且不可含 NUL');
    return [...args];
  }
  if (input != null && typeof input !== 'string') throw new Error('參數必須是文字或字串陣列');
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\0') throw new Error('參數不可含 NUL');
    if (/\s/.test(c) && !quoted) {
      if (started) args.push(value);
      value = ''; started = false; continue;
    }
    started = true;
    if (c === '\\') {
      let count = 1;
      while (text[i + 1] === '\\') { count++; i++; }
      if (text[i + 1] !== '"') { value += '\\'.repeat(count); continue; }
      value += '\\'.repeat(Math.floor(count / 2));
      if (count % 2) { value += '"'; i++; continue; }
      i++; // an even count leaves the following quote as a delimiter
    } else if (c !== '"') { value += c; continue; }
    if (quoted && text[i + 1] === '"') { value += '"'; i++; }
    else quoted = !quoted;
  }
  if (quoted) throw new Error('參數的雙引號未關閉');
  if (started) args.push(value);
  return args;
}
