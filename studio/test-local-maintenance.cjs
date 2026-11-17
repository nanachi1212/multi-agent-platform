const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const { syncRulesFile, ensureVerifiedExecutable, appendRotatingEvent, parseAcpArgs } = await import('./local-maintenance.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-maintenance-'));
  try {
    const source = path.join(root, 'user-rules.md'), target = path.join(root, 'home', 'AGENTS.md');
    fs.writeFileSync(source, 'global v1');
    assert.equal(syncRulesFile(source, target), true);
    fs.writeFileSync(source, 'global v2');
    assert.equal(syncRulesFile(source, target), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'global v2');
    fs.unlinkSync(source);
    syncRulesFile(source, target);
    assert.equal(fs.existsSync(target), false, 'deleted source removes only an unchanged managed copy');
    fs.writeFileSync(source, 'global v3'); syncRulesFile(source, target);
    fs.writeFileSync(target, 'custom rules'); fs.writeFileSync(source, 'global v4');
    assert.equal(syncRulesFile(source, target), false);
    fs.unlinkSync(source); syncRulesFile(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'custom rules', 'custom changes survive source edits and deletion');
    fs.unlinkSync(target + '.studio-sync.json'); fs.writeFileSync(source, 'global v5');
    assert.equal(syncRulesFile(source, target), false, 'legacy/unmarked rules are never adopted or replaced');
    assert.equal(fs.readFileSync(target, 'utf8'), 'custom rules');
    assert.equal(syncRulesFile(source, source), false);
    fs.unlinkSync(target); fs.linkSync(source, target);
    assert.equal(syncRulesFile(source, target), false, 'hard-linked user rules are preserved');
    fs.unlinkSync(target);
    fs.writeFileSync(target, 'custom'); fs.writeFileSync(target + '.studio-sync.json', '{bad');
    assert.equal(syncRulesFile(source, target), false, 'corrupt provenance fails closed');
    console.log('Rules sync: managed update/removal, custom edits, legacy files, hard links and corrupt metadata: PASS');

    const payload = path.join(root, 'payload'); fs.mkdirSync(payload);
    const executable = Buffer.from('verified fixture executable');
    fs.writeFileSync(path.join(payload, 'aioncore.exe'), executable);
    const archive = path.join(root, 'fixture.zip');
    execFileSync('tar', ['-acf', archive, '-C', payload, 'aioncore.exe'], { windowsHide: true });
    const bytes = fs.readFileSync(archive), destination = path.join(root, 'install', 'aioncore.exe');
    const options = { target: destination, url: 'https://example.invalid/fixture.zip', cachedArchive: archive,
      archiveHash: hash(bytes), executableHash: hash(executable) };
    const noNetwork = { download: async () => { throw new Error('unexpected download'); } };
    assert.equal((await ensureVerifiedExecutable(options, noNetwork)).installed, true);
    assert.equal((await ensureVerifiedExecutable(options, noNetwork)).installed, false);
    fs.writeFileSync(destination, 'partial old install');
    await assert.rejects(ensureVerifiedExecutable(options, { ...noNetwork, extract: async () => { throw new Error('interrupted extraction'); } }), /interrupted/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'partial old install');
    await assert.rejects(ensureVerifiedExecutable({ ...options, cachedArchive: null }, { download: async () => Buffer.from('bad zip') }), /SHA-256/);
    await assert.rejects(ensureVerifiedExecutable({ ...options, executableHash: 'wrong' }, noNetwork), /執行檔 SHA-256/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'partial old install');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (a, b) => { if (b === destination) throw new Error('destination is locked'); return rename(a, b); };
      await assert.rejects(ensureVerifiedExecutable(options, noNetwork), /locked/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(destination, 'utf8'), 'partial old install', 'failed atomic publish preserves the old executable');
    const repaired = await ensureVerifiedExecutable(options, noNetwork);
    assert.equal(fs.readFileSync(repaired.backup, 'utf8'), 'partial old install');
    assert.deepEqual(fs.readFileSync(destination), executable);
    assert.ok(!fs.readdirSync(path.dirname(destination)).some(x => x.startsWith('.install-')));
    fs.unlinkSync(destination);
    assert.equal((await ensureVerifiedExecutable({ ...options, cachedArchive: null }, { download: async () => bytes })).installed, true);
    console.log('Installer: real ZIP extraction, offline hash verification, repair backup, interrupted/locked publish and hash rejection: PASS');

    const events = path.join(root, 'events.jsonl');
    for (let n = 0; n < 10; n++) appendRotatingEvent(events, { n, text: '繁體中文' }, { maxBytes: 40, backups: 2 });
    const records = [events + '.2', events + '.1', events].flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse));
    assert.deepEqual(records.map(x => x.n), [7, 8, 9]);
    assert.equal(fs.existsSync(events + '.3'), false);
    console.log('Events: byte-based rotation, retained JSON records and bounded backups: PASS');

    assert.deepEqual(parseAcpArgs('acp -y pkg'), ['acp', '-y', 'pkg']);
    assert.deepEqual(parseAcpArgs(' --config "C:\\My Agent\\config.json" "" --name="a b" '), ['--config', 'C:\\My Agent\\config.json', '', '--name=a b']);
    assert.deepEqual(parseAcpArgs(String.raw`"C:\My Agent\\" "say \"hi\""`), ['C:\\My Agent\\', 'say "hi"']);
    assert.deepEqual(parseAcpArgs('"a""b"'), ['a"b']);
    assert.deepEqual(parseAcpArgs(JSON.stringify(['C:\\Agent Data\\', '', 'x"y'])), ['C:\\Agent Data\\', '', 'x"y']);
    assert.deepEqual(parseAcpArgs(['a b', '']), ['a b', '']);
    assert.deepEqual(parseAcpArgs('& | $HOME'), ['&', '|', '$HOME'], 'shell syntax remains literal argv');
    for (const bad of ['"unclosed', '[1]', '[bad', ['ok', 1], 'a\0b']) assert.throws(() => parseAcpArgs(bad));
    const argv = parseAcpArgs('"a b" "" "C:\\Agent Data\\config.json"');
    const received = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...argv], { windowsHide: true, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(received), argv, 'actual child process receives exact argv including spaces and empty arguments');
    console.log('ACP arguments: quoted paths, backslashes, empty args, JSON arrays, malformed input and real child argv: PASS');

    const src = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const body = src.match(/function pruneConversations\(\) \{[\s\S]*?\n\}/)[0];
    const convAgent = new Map([['paused', 'codex'], ['working', 'claude']]);
    const S = { workspaces: [{ run: { convs: { 'codex:work': 'paused' } } }] }, active = new Map([['working', 'turn']]);
    const prune = new Function('convAgent', 'S', 'active', body + '; return pruneConversations;')(convAgent, S, active);
    for (let i = 0; i < 4000; i++) convAgent.set('probe-' + i, 'codex');
    prune(); assert.equal(convAgent.size, 258);
    assert.ok(convAgent.has('paused') && convAgent.has('working') && convAgent.has('probe-3999'));
    active.clear(); S.workspaces = []; prune(); assert.equal(convAgent.size, 256);
    assert.ok(!convAgent.has('paused') && !convAgent.has('working'));
    console.log('Conversations: bounded retired index, active/paused ownership retained, closed jobs evicted: PASS');

    const registration = [], acpState = { acp: [], workspaces: [] };
    const addCode = src.slice(src.indexOf('async function addAcp('), src.indexOf('async function deleteAcp('));
    const add = new Function('S', 'crypto', 'parseAcpArgs', 'api', 'registerAcp', 'saveSettings', 'checkAgent', addCode + '; return addAcp;')(
      acpState, crypto, parseAcpArgs, async (method, route, body) => { registration.push(body); return { id: 'agent' }; }, () => {}, () => {}, () => {});
    await add({ name: 'custom', command: '"C:\\My Agent\\agent.exe"', args: '--config "C:\\My Agent\\config.json" ""' });
    assert.deepEqual(registration[0], { name: 'custom', command: 'C:\\My Agent\\agent.exe', args: ['--config', 'C:\\My Agent\\config.json', ''] });
    await assert.rejects(add({ name: 'invalid', command: 'agent.exe', args: '"unclosed' }), /雙引號/);
    assert.equal(registration.length, 1, 'invalid argv is rejected before registering an external agent');

    const cacheCode = src.slice(src.indexOf('// ponytail: reads the newest 200'), src.indexOf('function historyItems()'));
    const cache = new Function('S', 'writeJson', 'path', 'HISTORY', 'resumable', cacheCode + '; histCache.rev = S.historyRev; return { saveRun, histCache };')(
      { historyRev: 0 }, () => {}, path, root, () => false);
    for (let i = 0; i < 1000; i++) cache.saveRun({ run: { id: String(i).padStart(4, '0') }, tasks: [], activity: [] }, 'done');
    assert.equal(cache.histCache.items.length, 200); assert.equal(cache.histCache.rows.size, 200);
    assert.equal(cache.histCache.items[0].id, '0999');
    console.log('Integration: custom ACP registration preserves argv; history row index stays bounded with cached records: PASS');

    if (process.argv[2]) { // optional local smoke with the real pinned release; never starts a model or reads credentials
      const pinned = name => src.match(new RegExp('const ' + name + " = '([^']+)'"))[1];
      const official = path.join(root, 'official', 'aioncore.exe');
      await ensureVerifiedExecutable({ target: official, url: pinned('AION_URL'), cachedArchive: path.resolve(process.argv[2]),
        archiveHash: pinned('AION_ZIP_SHA256'), executableHash: pinned('AION_EXE_SHA256') }, noNetwork);
      const version = execFileSync(official, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      assert.match(version, /0\.2\.2/);
      console.log('Official AionCore: pinned ZIP/executable hashes, actual staging install and --version 0.2.2: PASS');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
