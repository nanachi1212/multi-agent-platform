// Boot Studio twice on one disposable pre-#87 runtime, stopping before model backends start.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { stageStudio, start } = require('./test-workspace-settings.cjs');

async function testStoppedUpgrade() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stopped-upgrade-')));
  let app;
  try {
    const file = stageStudio(root), rt = path.join(root, 'runtime'), studio = path.join(rt, 'studio');
    const history = path.join(studio, 'history'), leasesFile = path.join(studio, 'leases.json');
    const at = new Date().toISOString(), deadPid = 2147483000;
    fs.mkdirSync(history, { recursive: true });
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const recordFile = record => path.join(history, record.id + '.json');
    function seed(name, status = 'stopped', changes = {}) {
      const project = path.join(root, name);
      fs.mkdirSync(project);
      const key = project.replaceAll('/', '\\');
      const check = { id: 'check', role: 'check', agent: 'codex', title: 'check', status: 'DONE', result: 'PASS',
        verifiedAt: { head: 'a'.repeat(40), tree: 'b'.repeat(40), dir: project } };
      // The old writer was checking its prerequisite. It never started an agent turn.
      const writer = { id: 'write', role: 'build', agent: 'codex', title: 'deliver', writes: true,
        after: ['check'], status: 'WORKING', result: '已暫停', resumed: true, stopUnconfirmed: false, runtimeStopPending: false, ...changes };
      const record = { id: name, project, status, phase: status === 'stopped' ? 'finished' : 'working', startedAt: at, finishedAt: at,
        leader: 'claude', request: name, tasks: [check, writer], activity: [], convs: { 'codex:work:chk': 'check-session' } };
      const lease = { id: name + '-lease', project, path: project, worktree: project, key: process.platform === 'win32' ? key.toLowerCase() : key,
        repo: '', branch: '', mode: 'write', owner: { kind: 'studio', agent: 'codex' }, jobId: name, cardId: writer.id,
        generation: 0, status: 'RESERVED', pid: deadPid, instance: 'old', acquiredAt: at, heartbeatAt: at };
      if (status === 'stopped') Object.assign(lease, { jobStopped: true, fencedAt: at });
      write(recordFile(record), record);
      return { record, lease };
    }

    const old = seed('stopped-job');
    const paused = seed('paused-job', 'paused', { status: 'PAUSED' });
    const live = seed('live-owner'); live.lease.pid = process.pid;
    const pending = seed('stop-pending', 'stopped', { stopUnconfirmed: true });
    const draining = seed('paused-during-turn', 'stopped', { firstStartedAt: at, status: 'FAILED', result: '已停止' });
    draining.lease.reason = 'paused';
    const external = seed('external-claim');
    Object.assign(external.lease, { owner: { kind: 'external', label: 'external editor' }, status: 'EXTERNAL' });
    const protectedJobs = [paused, live, pending, draining, external];
    write(path.join(studio, 'settings.json'), { notify: false, workspaces: [old, paused].map(({ record }) => ({ project: record.project })) });
    write(leasesFile, [old, ...protectedJobs].map(entry => entry.lease));

    app = await start(file, rt);
    const detail = await app.api('history/' + old.record.id), [check, writer] = detail.tasks;
    assert.equal(writer.status, 'FAILED', 'upgrade must finalize the stopped WORKING card');
    assert.equal(detail.status, 'stopped'); assert.deepEqual(check, old.record.tasks[0]);
    assert.deepEqual(detail.convs, old.record.convs); assert.equal(detail.finishedAt, old.record.finishedAt);
    assert.deepEqual(read(recordFile(old.record)), detail, 'the repaired history must be durable');
    const first = read(leasesFile), retired = first.find(lease => lease.id === old.lease.id);
    assert.equal(retired.status, 'RELEASED'); assert.equal(retired.jobStopped, true);
    assert.equal(retired.fencedAt, at, 'retain the original STOP fence');
    const visible = await app.api('leases');
    assert.ok(!visible.some(lease => lease.id === retired.id));
    for (const { record, lease } of protectedJobs) {
      assert.deepEqual(read(recordFile(record)), record, record.id + ' history must remain untouched');
      assert.deepEqual(first.find(l => l.id === lease.id), lease, lease.id + ' must remain untouched');
      assert.equal(visible.find(l => l.id === lease.id)?.state, lease.status, lease.id + ' remains effective');
    }
    await app.stop(); app = null;
    app = await start(file, rt);
    assert.deepEqual(await app.api('history/' + old.record.id), detail, 'restarting twice keeps the original history');
    assert.deepEqual(read(leasesFile), first, 'restarting twice keeps all lease records and timestamps');
    console.log('Stopped job upgrade: failed card and released reservation survive restart; PASS, paused, live, unconfirmed and external owners preserved: PASS');
  } finally {
    try { await app?.stop(); } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}

testStoppedUpgrade().catch(error => { console.error(error); process.exitCode = 1; });
