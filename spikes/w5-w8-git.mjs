// W5 long path, W6 file lock, W7 junction containment, W8 encoding. Disposable sandbox repo only; no commits.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ROOT, log, sleep, sha256 } from './lib.mjs';

const L = (o) => log('w5-w8.log', o);
const REPO = join(ROOT, 'p0-sandbox', 'repo 測試 A');
const git = (cwd, args, opts = {}) => spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'buffer', windowsHide: true, ...opts });
const addWt = (name) => { const p = join(ROOT, 'p0-sandbox', 'wt', name); if (!existsSync(p)) execFileSync('git', ['-C', REPO, '-c', 'core.longpaths=true', 'worktree', 'add', '-q', '-b', `p0/${name}`, p, 'HEAD']); return p; };
const globalBefore = execFileSync('git', ['config', '--global', '--list'], { encoding: 'utf8' });

// ---- W5 long path
{
  const wt = addWt('w5-long');
  let rel = 'deep'; while (join(wt, rel).length < 300) rel = join(rel, 'segment_' + 'x'.repeat(20));
  const file = join(wt, rel, 'long-file.txt');
  mkdirSync(join(wt, rel), { recursive: true }); writeFileSync(file, 'long\n');
  const st = git(wt, ['status', '--porcelain=v2', '-z', '-uall']);
  const add = git(wt, ['add', '--', rel]);
  const diff = git(wt, ['diff', '--cached', '--name-only', '-z']);
  const listed = diff.stdout.toString('utf8').split('\0').filter(Boolean);
  // undo: unstage + delete, then remove worktree without --force
  git(wt, ['reset', '-q', '--', rel]); rmSync(join(wt, 'deep'), { recursive: true, force: true });
  const rm = git(REPO, ['worktree', 'remove', wt]);
  L({ gate: 'W5', fullPathLen: file.length, statusOk: st.status === 0 && st.stdout.toString().includes('long-file.txt'), addStatus: add.status, cachedListed: listed.length === 1 && listed[0].endsWith('long-file.txt'),
    removeStatus: rm.status, removed: !existsSync(wt), verdict: st.status === 0 && add.status === 0 && listed.length === 1 && rm.status === 0 && !existsSync(wt) ? 'PASS' : 'FAIL', stderr: rm.stderr.toString().slice(0, 200) });
}

// ---- W6 file lock: hold an exclusive handle, attempt remove with bounded retry, never --force
{
  const wt = addWt('w6-lock');
  const locked = join(wt, 'README.md');
  const holder = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[IO.File]::Open('${locked.replace(/'/g, "''")}','Open','Read','None'); 'locked'; Start-Sleep -Seconds 60; $f.Close()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => holder.stdout.once('data', r));
  const attempts = [];
  for (let i = 0; i < 3; i++) { const r = git(REPO, ['worktree', 'remove', wt]); attempts.push({ status: r.status, err: r.stderr.toString().trim().slice(0, 160) }); if (r.status === 0) break; await sleep(1000 * 2 ** i); }
  const preserved = existsSync(wt) && existsSync(join(wt, 'src', 'add.mjs'));
  holder.kill(); await sleep(1500);
  const after = git(REPO, ['worktree', 'remove', wt]);
  L({ gate: 'W6', attempts, blockedAndPreserved: attempts.every((a) => a.status !== 0) && preserved, removeAfterUnlock: after.status, removedAfterUnlock: !existsSync(wt),
    note: 'no --force used', verdict: attempts.every((a) => a.status !== 0) && preserved && after.status === 0 ? 'PASS' : 'FAIL' });
}

// ---- W7 junction containment
{
  const wt = addWt('w7-junction');
  const outside = join(ROOT, 'p0-sandbox', 'outside-target'); mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, 'target.txt'), 'outside\n');
  const link = join(wt, 'link');
  if (!existsSync(link)) execFileSync('cmd', ['/d', '/c', 'mklink', '/J', link, outside], { windowsHide: true });
  // Conductor-side containment rule from V1 §7.4: final path (reparse points resolved) + case-insensitive prefix.
  const inside = (p) => { const root = realpathSync.native(wt).toLowerCase() + sep; let fin; try { fin = realpathSync.native(p); } catch { fin = resolve(p); } return (fin.toLowerCase() + sep).startsWith(root); };
  const naive = (p) => resolve(p).toLowerCase().startsWith(resolve(wt).toLowerCase() + sep);
  const viaLink = join(link, 'target.txt'), normal = join(wt, 'src', 'add.mjs'), upper = join(wt.toUpperCase(), 'SRC', 'ADD.MJS');
  const st = git(wt, ['status', '--porcelain=v2', '-z', '-uall']).stdout.toString('utf8');
  L({ gate: 'W7', viaLink: { naivePrefixSaysInside: naive(viaLink), finalPathInside: inside(viaLink), finalPath: realpathSync.native(viaLink) },
    normalInside: inside(normal), caseInsensitiveInside: inside(upper), gitSeesJunctionAs: st.split('\0').filter(Boolean).map((x) => x.slice(0, 80)),
    verdict: naive(viaLink) && !inside(viaLink) && inside(normal) && inside(upper) ? 'PASS' : 'FAIL' });
  execFileSync('cmd', ['/d', '/c', 'rmdir', link], { windowsHide: true }); // removes the junction only, not the target
  const rm = git(REPO, ['worktree', 'remove', wt]); L({ gate: 'W7-cleanup', junctionRemoved: !existsSync(link), targetIntact: existsSync(join(outside, 'target.txt')), removeStatus: rm.status });
}

// ---- W8 encoding: CJK filename via porcelain -z, and UTF-8 output from a verify command through job-runner
{
  const wt = addWt('w8-encoding');
  const name = '測試 檔案 ①.txt';
  writeFileSync(join(wt, name), '內容\n');
  const st = git(wt, ['status', '--porcelain=v2', '-z', '-uall']);
  const entries = st.stdout.toString('utf8').split('\0').filter(Boolean);
  const nameOk = entries.some((e) => e.endsWith(name));
  const argv = Buffer.from(JSON.stringify(['pwsh', '-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '驗證輸出 ✓ 中文'"])).toString('base64');
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'spikes', 'job-runner.ps1'), '-ArgvB64', argv], { encoding: 'buffer', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  const out = r.stdout.toString('utf8').trim();
  rmSync(join(wt, name));
  const rm = git(REPO, ['worktree', 'remove', wt]);
  L({ gate: 'W8', porcelainEntries: entries, cjkNameDecoded: nameOk, verifyExit: r.status, verifyStdout: out, verifyStdoutSha: sha256(r.stdout).slice(0, 16), stdoutOk: out === '驗證輸出 ✓ 中文', removeStatus: rm.status,
    verdict: nameOk && out === '驗證輸出 ✓ 中文' && r.status === 0 ? 'PASS' : 'FAIL' });
}
const globalAfter = execFileSync('git', ['config', '--global', '--list'], { encoding: 'utf8' });
L({ gitGlobalConfigUnchanged: globalBefore === globalAfter });
