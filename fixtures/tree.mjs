// Process-tree fixture for W1/W2. Writes {role,pid,ppid} lines to $P0_TREE_PIDS.
// root -> (sleeper child) + (mid, detached) ; mid -> (leaf, detached) then mid exits => leaf is orphaned.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const role = process.argv[2] ?? 'root';
const out = process.argv[3] ?? process.env.P0_TREE_PIDS;
// A sandbox may deny this write; W1 then finds the tree via CIM by the unique path in argv.
try { appendFileSync(out, JSON.stringify({ role, pid: process.pid, ppid: process.ppid, t: Date.now() }) + '\n'); } catch {}
const me = process.argv[1];
const kid = (r, detached) => spawn(process.execPath, [me, r, out], { detached, stdio: 'ignore', windowsHide: true });
if (role === 'root') { kid('sleeper', false); kid('mid', true).unref(); }
if (role === 'mid') { kid('leaf', true).unref(); setTimeout(() => process.exit(0), 300); }
if (role !== 'mid') setInterval(() => {}, 1 << 30);
