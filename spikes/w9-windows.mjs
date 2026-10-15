// W9: sample AionCore descendants for visible top-level windows (MainWindowHandle != 0) for N seconds.
// usage: node w9-windows.mjs <serverTag> <seconds> <label>
import { log, sleep, ROOT } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [tag, secs = '120', label = 'w9'] = process.argv.slice(2);
const { pid: root } = JSON.parse(readFileSync(join(ROOT, 'runtime', `${tag}.endpoint`), 'utf8'));
const PS = `$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='C';e={$_.CreationDate.ToFileTimeUtc()}};
$w=@{}; Get-Process | ? { $_.MainWindowHandle -ne 0 } | % { $w[[string]$_.Id]=$_.MainWindowTitle };
[pscustomobject]@{procs=$p; win=$w} | ConvertTo-Json -Depth 4 -Compress`;
const seen = new Map(), windowed = new Map(); const end = Date.now() + Number(secs) * 1000; let samples = 0, errors = 0, lastErr = null;
while (Date.now() < end) {
  try {
    const j = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 }));
    const by = new Map(j.procs.map((p) => [p.ProcessId, p])); const s = new Set([root]); let g = true;
    while (g) { g = false; for (const p of j.procs) { const par = by.get(p.ParentProcessId); if (s.has(p.ParentProcessId) && !s.has(p.ProcessId) && par && p.C >= par.C) { s.add(p.ProcessId); g = true; } } }
    for (const pid of s) if (pid !== root && by.has(pid)) seen.set(pid, by.get(pid).Name);
    for (const [pid, title] of Object.entries(j.win ?? {})) if (s.has(Number(pid)) && Number(pid) !== root) windowed.set(Number(pid), { name: by.get(Number(pid))?.Name, title });
    samples++;
  } catch (e) { errors++; lastErr = String(e).slice(0, 200); }
  await sleep(300);
}
log('w9.log', { label, samples, errors, lastErr, descendantsSeen: seen.size, names: [...new Set(seen.values())], visibleWindows: [...windowed.entries()].map(([pid, v]) => ({ pid, ...v })), verdict: samples === 0 ? 'INVALID' : windowed.size ? 'FAIL' : 'PASS' });
