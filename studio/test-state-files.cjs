const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('State files');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { region } = require('./lifecycle-harness.cjs');

(async () => {
  const { writeJson, claimRuntime } = await import('./state-files.mjs');
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-state-'));
  try {
    const SETTINGS = path.join(rt, 'studio', 'settings.json'), HISTORY = path.join(rt, 'studio', 'history');
    const S = { workspaces: [], leader: 'codex', recent: [], agentCfg: {}, historyRev: 0 };
    const { saveSettings, saveRun } = new Function('S', 'fs', 'path', 'SETTINGS', 'HISTORY', 'writeJson',
      region('function saveSettings()', 'function historyItems()') + '\nreturn { saveSettings, saveRun };')(S, fs, path, SETTINGS, HISTORY, writeJson);
    const w = { run: { id: 'job', request: 'original' }, tasks: [], activity: [] };
    saveSettings(); saveRun(w, 'paused');
    const saved = fs.readFileSync(SETTINGS, 'utf8'), history = fs.readFileSync(path.join(HISTORY, 'job.json'), 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('disk refused replacement'), { code: 'EPERM' }); };
    try {
      S.leader = 'claude'; w.run.request = 'changed';
      assert.throws(saveSettings, /refused/); assert.throws(() => saveRun(w, 'running'), /refused/);
      assert.strictEqual(S.historyRev, 1, 'failed history write never advances revision');
      assert.strictEqual(fs.readFileSync(SETTINGS, 'utf8'), saved);
      assert.strictEqual(fs.readFileSync(path.join(HISTORY, 'job.json'), 'utf8'), history);
    } finally { fs.renameSync = rename; }
    saveSettings(); saveRun(w, 'running');
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).leader, 'claude');
    assert.ok(!fs.readdirSync(path.dirname(SETTINGS)).some((f) => f.endsWith('.tmp')));
    { // history cache: a log line rewrites the file but keeps the list cache; only a listed field advances historyRev
      const H2 = path.join(rt, 'studio', 'history2'), S2 = { historyRev: 0, workspaces: [] };
      const mk = () => new Function('S', 'fs', 'path', 'HISTORY', 'writeJson', 'isDir', 'resumable',
        region('// ponytail: reads the newest 200', 'function listHistory()') + '\nreturn { saveRun, historyItems };')(S2, fs, path, H2, writeJson, (d) => fs.existsSync(d), (r) => r.status === 'paused');
      const h = mk(), job = { run: { id: 'job', request: 'r' }, tasks: [{ status: 'WORKING' }], activity: [] };
      h.saveRun(job, 'running'); const items = h.historyItems(), rev = S2.historyRev;
      job.activity.push({ text: 'log' }); h.saveRun(job, 'running');
      assert.strictEqual(S2.historyRev, rev, 'log-only save keeps historyRev');
      assert.strictEqual(h.historyItems(), items, 'log-only save keeps the cache'); assert.strictEqual(items[0].activity.length, 1, 'cache updated in place');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(H2, 'job.json'), 'utf8')).activity.length, 1, 'every save still reaches disk');
      job.activity.push({ text: 'log2' }); assert.strictEqual(items[0].activity.length, 1, 'cache is a copy, not the live arrays');
      job.tasks[0].status = 'DONE'; h.saveRun(job, 'running'); assert.strictEqual(S2.historyRev, rev + 1, 'listed field change advances historyRev');
      h.saveRun({ run: { id: 'job2', request: 'n' }, tasks: [], activity: [] }, 'paused'); assert.strictEqual(S2.historyRev, rev + 2, 'new record advances historyRev');
      assert.deepEqual(h.historyItems().map((r) => r.id), ['job2', 'job']); S2.historyRev = 99;
      assert.deepEqual(mk().historyItems(), JSON.parse(JSON.stringify(items)), 'cache matches a fresh read of the files');
    }
    const release = await claimRuntime(rt), lock = path.join(rt, 'studio', 'instance.lock');
    await assert.rejects(claimRuntime(rt), /重複啟動/);
    const child = spawnSync(process.execPath, [path.join(__dirname, 'server.mjs')], {
      env: { ...process.env, STUDIO_RUNTIME: rt, STUDIO_NO_OPEN: '1' }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.strictEqual(child.status, 1); assert.match(child.stderr, /重複啟動/);
    assert.ok(!fs.existsSync(path.join(rt, 'studio', 'runtimes.json')), 'duplicate fails before launching AionCore');
    const separate = await claimRuntime(path.join(rt, 'independent')); separate();
    release(); assert.ok(!fs.existsSync(lock));
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, token: 'dead' }));
    const reclaimed = await claimRuntime(rt); reclaimed();
    const { getProcessInfo } = await import('./runtime-registry.mjs'), me = await getProcessInfo(process.pid), reclaimLock = lock + '.reclaim';
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'reused', creationDate: 'old', executable: me.executable }));
    (await claimRuntime(rt))(); // live PID, different creation time: a reused PID is not the old Studio
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, token: 'dead' })); fs.writeFileSync(reclaimLock, JSON.stringify({ pid: 2147483000 }));
    (await claimRuntime(rt))(); assert.deepEqual(JSON.parse(fs.readFileSync(reclaimLock, 'utf8')), { pid: 2147483000 }, 'dead recovery predecessor stays immutable after successor recovery');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, token: 'dead' })); fs.writeFileSync(reclaimLock, JSON.stringify({ pid: process.pid, creationDate: me.creationDate, executable: me.executable }));
    await assert.rejects(claimRuntime(rt), /接手/); fs.unlinkSync(reclaimLock); fs.unlinkSync(lock);
    for (const text of ['{', '{}', '{"pid":null}']) {
      fs.writeFileSync(lock, text); await assert.rejects(claimRuntime(rt)); assert.strictEqual(fs.readFileSync(lock, 'utf8'), text);
    }
    finished();
    console.log('state files: atomic settings/history, failed replacement preserves data, runtime exclusion before startup, dead/unknown owner handling: PASS');
  } finally { fs.rmSync(rt, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
