// P0 W10/R16: hash global agent/git/env settings. Prints hashes only, never content.
// usage: node snapshot-global.mjs <out.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const H = homedir();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = [
  '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md',
  '.gemini/settings.json', '.gemini/GEMINI.md', '.gemini/trustedFolders.json',
  '.gemini/config/mcp_config.json', '.gemini/config/config.json',
  '.gemini/antigravity-cli/settings.json', '.gitconfig',
];
const out = {};
for (const f of files) {
  const p = join(H, f);
  out[f] = existsSync(p) ? sha(readFileSync(p)) : 'ABSENT';
}
// ~/.claude.json changes on every Claude run; hash only its mcpServers subtree.
try {
  const j = JSON.parse(readFileSync(join(H, '.claude.json'), 'utf8'));
  out['.claude.json#mcpServers'] = sha(JSON.stringify(j.mcpServers ?? null));
} catch { out['.claude.json#mcpServers'] = 'UNREADABLE'; }
const cmd = (exe, args) => { try { return sha(execFileSync(exe, args, { encoding: 'utf8' })); } catch (e) { return 'ERR:' + (e.status ?? e.code); } };
out['git config --global --list'] = cmd('git', ['config', '--global', '--list']);
out['git config --system --list'] = cmd('git', ['config', '--system', '--list']);
out['reg HKCU\\Environment'] = cmd('reg', ['query', 'HKCU\\Environment']);
out['reg HKLM\\...\\Session Manager\\Environment'] = cmd('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']);
// Per-value hashes of HKCU\Environment (names + sha256 of raw value; values are never stored) so a change can be attributed.
try {
  const ps = "$k=Get-Item 'HKCU:\\Environment'; $o=@{}; foreach($n in $k.GetValueNames()){ $o[$n]=[string]$k.GetValue($n,'',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }; $o | ConvertTo-Json -Compress";
  const vals = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ' + ps], { encoding: 'utf8', windowsHide: true }));
  out['HKCU\\Environment per-value'] = Object.fromEntries(Object.keys(vals).sort().map((k) => [k, sha(String(vals[k])).slice(0, 16)]));
} catch (e) { out['HKCU\\Environment per-value'] = 'ERR'; }
out['cli versions'] = {
  claude: cmd('claude', ['--version']), // hashed to detect upgrade
};
out.at = new Date().toISOString();
writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
