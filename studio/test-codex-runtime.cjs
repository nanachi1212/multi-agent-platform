const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const { createCodexRuntimeGuard, processTree } = await import('./codex-runtime.mjs');
  const { listRuntimes } = await import('./runtime-registry.mjs');
  const dirs = [];
  function setup() {
    const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-stop-')); dirs.push(rtDir);
    const p = (pid, parent = 1, when = pid) => ({ pid, parent, creationDate: new Date(when * 1000).toISOString(), executable: 'cmd.exe', command: 'cmd /c codex.cmd app-server' });
    const core = p(1, 0), other = p(10), context = { rows: [core, other], next: 20, restarts: 0, fail: false, orphan: false, queryError: false };
    const snapshot = async () => { if (context.queryError) throw new Error('CIM denied'); return structuredClone(context.rows); };
    const guard = createCodexRuntimeGuard({ rtDir, owner: () => core, snapshot, api: async (method, route) => {
      if (route.endsWith('/restart')) {
        context.restarts++;
        if (context.fail) throw new Error('restart failed');
        context.rows = context.rows.filter((x) => x.pid <= 10 || context.orphan && x.pid === 99);
        context.rows.push(p(++context.next));
      }
    } });
    const create = () => guard.create(async () => { context.rows.push(p(context.next)); return 'c'; });
    return { guard, context, p, other, create, rtDir };
  }
  try {
    const E = setup(); await E.create(); await E.guard.prepare('c');
    E.context.rows.push(E.p(99, 20), E.p(100, 99));
    assert.deepEqual(await Promise.all([E.guard.stop('c'), E.guard.stop('c')]), [true, true]);
    assert.ok(E.context.rows.some((x) => x.pid === E.other.pid), 'another conversation stays alive');
    assert.equal(listRuntimes({ rtDir: E.rtDir }).filter((r) => r.status === 'cleaned')[0].process_tree.length, 3);
    await E.guard.stop('c'); assert.equal(E.context.restarts, 1, 'concurrent/idempotent drain cannot restart the fresh idle session');

    const survivor = setup(); await survivor.create(); await survivor.guard.prepare('c');
    survivor.context.rows.push(survivor.p(99, 20)); survivor.context.orphan = true;
    assert.equal(await survivor.guard.stop('c'), false, 'idle/restart success is not proof of subprocess exit');
    assert.ok(listRuntimes({ rtDir: survivor.rtDir }).some((r) => r.status === 'stopping' && r.process_tree.some((p) => p.pid === 99)));
    assert.ok(listRuntimes({ rtDir: survivor.rtDir }).some((r) => r.child_pids.includes(99)), 'startup cleanup also retains an orphan after its root exits');
    await assert.rejects(survivor.guard.prepare('c'), /have not stopped/);

    const failed = setup(); await failed.create(); await failed.guard.prepare('c'); failed.context.fail = true;
    await assert.rejects(failed.guard.stop('c'), /restart failed/);
    assert.ok(listRuntimes({ rtDir: failed.rtDir }).some((r) => r.status === 'stopping'));
    failed.context.fail = false; assert.equal(await failed.guard.stop('c'), true, 'failed stops can be retried');

    const denied = setup(); await denied.create(); await denied.guard.prepare('c'); denied.context.queryError = true;
    await assert.rejects(denied.guard.stop('c'), /CIM denied/);
    assert.equal(denied.context.restarts, 0, 'unknown process tree is never reported stopped');

    const previousInstance = setup(); await previousInstance.create();
    previousInstance.context.rows.find((p) => p.pid === 20).parent = 9;
    await assert.rejects(previousInstance.guard.prepare('c'), /not owned/, 'a surviving prior instance cannot admit an untracked replacement writer');

    const root = E.p(40, 1, 40), recycled = E.p(41, 40, 2), child = E.p(42, 40, 50);
    assert.deepEqual(processTree([root, recycled, child], root).map((x) => x.pid), [40, 42], 'PID reuse cannot adopt an older unrelated child');
    assert.deepEqual(processTree([E.p(40, 1, 60), child], root), [], 'a reused root PID is not the original tree');
    assert.throws(() => processTree([{ ...root, creationDate: '' }], root), /identity is unconfirmed/, 'missing metadata cannot prove a process exited');

    const ambiguous = setup();
    await assert.rejects(ambiguous.guard.create(async () => { ambiguous.context.rows.push(ambiguous.p(20), ambiguous.p(21)); return 'c'; }), /2 candidates/);
    assert.equal(listRuntimes({ rtDir: ambiguous.rtDir }).length, 0, 'ambiguous session attribution cannot admit a tool turn');
    console.log('Codex runtime: session ownership, native restart, subprocess exit proof, PID reuse, query failure and retry: PASS');
  } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
