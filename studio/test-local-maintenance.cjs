const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Local maintenance');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const { syncRulesFile, ensureVerifiedExecutable, appendRotatingEvent, parseAcpArgs } = await import('./local-maintenance.mjs');
  const { acpBackendCommand, withAcpLauncherPath } = await import('./acp-command.mjs');
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
    const bytes = fs.readFileSync(archive), destination = path.join(root, '安裝 測試', 'aioncore.exe');
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

    assert.deepEqual(acpBackendCommand('opencode', ['acp']), { command: 'opencode', args: ['acp'] }, 'simple commands retain existing backend handling');
    for (const bad of ['node --acp', 'C:\\Agent Tools\\run.ps1', '"agent.exe" --acp', 'a\0b']) {
      assert.throws(() => acpBackendCommand(bad, []));
    }
    const originalEnv = { Path: 'original-path', KEEP: 'yes' }, launchEnv = withAcpLauncherPath(originalEnv);
    assert.equal(launchEnv.Path, path.dirname(process.execPath) + path.delimiter + 'original-path');
    assert.equal(launchEnv.KEEP, 'yes'); assert.equal(originalEnv.Path, 'original-path');
    assert.equal(Object.keys(launchEnv).filter(key => key.toLowerCase() === 'path').length, 1);
    const launcher = path.join(__dirname, 'acp-launcher.cjs');
    const exactArgs = ['', 'a b', 'say "hi"', 'C:\\Agent Data\\', '& | > %PATH% $HOME'];
    const childCode = `let input=''; process.stdin.on('data', chunk => input+=chunk).on('end', () => {
      process.stdout.write(JSON.stringify({input,args:process.argv.slice(1),cwd:process.cwd(),env:process.env.ACP_TEST}));
      process.stderr.write('fixture stderr'); process.exitCode=23;
    });`;
    const launched = spawnSync(process.execPath, [launcher, process.execPath, '-e', childCode, '--', ...exactArgs],
      { input: 'ACP input\n', encoding: 'utf8', cwd: root, env: { ...process.env, ACP_TEST: 'inherited' }, windowsHide: true, timeout: 10000 });
    assert.ifError(launched.error); assert.equal(launched.status, 23); assert.equal(launched.stderr, 'fixture stderr');
    assert.deepEqual(JSON.parse(launched.stdout), { input: 'ACP input\n', args: exactArgs, cwd: root, env: 'inherited' });
    const missing = spawnSync(process.execPath, [launcher, path.join(root, 'missing agent.exe')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(missing.error); assert.equal(missing.status, 127); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /ENOENT/);
    console.log('ACP launcher: literal argv, stdio, cwd/env, exit status, missing executable and command validation: PASS');

    const batchDir = path.join(root, 'Agent & (Tools) %ACP_TEST% !ACP_TEST!'); fs.mkdirSync(batchDir);
    fs.writeFileSync(path.join(batchDir, 'echo.cjs'), childCode.replace('process.argv.slice(1)', 'process.argv.slice(2)'));
    const batchArgs = ['', 'a b', 'C:\\Agent Data\\', 'tail\\\\', '--config=C:\\My Agent\\config.json', '& echo BAD>injected.txt | < ^ ( )', '中文\t參數',
      'say "hi"', '%ACP_TEST%', '!ACP_TEST!', '%CD%', '%1', '%*', '%', '!', '100%', '{"name":"100% !literal!"}',
      'x"&echo BAD>injected.txt&rem "', '"|echo BAD>injected2.txt &"', '^"&echo BAD>injected3.txt&rem "'];
    for (let n = 0; n < 12; n++) batchArgs.push('a' + '\\'.repeat(n) + '"b', '\\'.repeat(n), 'a"' + '\\'.repeat(n), '"'.repeat(n));
    const batchEnv = { ...process.env, ACP_TEST: 'inherited', ACP_TEST_NODE: process.execPath };
    const pathKey = Object.keys(batchEnv).find(key => key.toLowerCase() === 'path');
    batchEnv[pathKey] = batchDir + path.delimiter + batchEnv[pathKey];
    for (const extension of ['CMD', 'BAT']) {
      const batch = path.join(batchDir, 'agent wrapper.' + extension);
      // Exercise both direct %* forwarding and the compound command used by npm shims.
      const direct = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n"%ACP_TEST_NODE%" "%~dp0echo.cjs" %*\r\nexit /b %errorlevel%\r\n';
      const compound = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nset "dp0=%~dp0"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%ACP_TEST_NODE%" "%dp0%echo.cjs" %*\r\n';
      fs.writeFileSync(batch, extension === 'CMD' ? compound : direct);
      const invocation = acpBackendCommand(batch, batchArgs);
      assert.equal(invocation.command, 'node.exe');
      const result = spawnSync(process.execPath, invocation.args, { input: 'ACP input\n', encoding: 'utf8', cwd: root,
        env: batchEnv, windowsHide: true, timeout: 10000 });
      assert.ifError(result.error); assert.equal(result.status, 23, result.stderr); assert.equal(result.stderr, 'fixture stderr');
      const { cwd: batchCwd, ...received } = JSON.parse(result.stdout);
      assert.equal(batchCwd.toLowerCase(), root.toLowerCase(), 'cmd.exe may canonicalize the Windows directory casing');
      assert.deepEqual(received, { input: 'ACP input\n', args: batchArgs, env: 'inherited' });
      for (const marker of ['injected.txt', 'injected2.txt', 'injected3.txt']) assert.equal(fs.existsSync(path.join(root, marker)), false, 'shell syntax in an argument never runs');
      const invalid = ['line\nbreak', 'line\rbreak'];
      for (const argument of invalid) {
        assert.throws(() => acpBackendCommand(batch, [argument]), /批次檔/);
        const rejected = spawnSync(process.execPath, [launcher, batch, argument], { encoding: 'utf8', cwd: root, windowsHide: true, timeout: 10000 });
        assert.ifError(rejected.error); assert.equal(rejected.status, 127); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /批次檔/);
      }
      assert.throws(() => acpBackendCommand(batch, ['x'.repeat(8001)]), /過長/);
    }
    // A command found on PATH must use the same escaping even without spaces in its name.
    fs.copyFileSync(path.join(batchDir, 'agent wrapper.BAT'), path.join(batchDir, 'agent.cmd'));
    const fromPath = spawnSync(process.execPath, acpBackendCommand('agent.cmd', batchArgs).args,
      { input: 'ACP input\n', encoding: 'utf8', cwd: root, env: batchEnv, windowsHide: true, timeout: 10000 });
    assert.ifError(fromPath.error); assert.equal(fromPath.status, 23, fromPath.stderr);
    assert.deepEqual(JSON.parse(fromPath.stdout).args, batchArgs);
    console.log('ACP batch launcher: .CMD/.BAT and PATH shims, embedded quotes, literal %/!, slash runs, injection resistance, stdio/exit: PASS');

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
    const add = new Function('S', 'crypto', 'parseAcpArgs', 'acpBackendCommand', 'api', 'registerAcp', 'saveSettings', 'checkAgent', addCode + '; return addAcp;')(
      acpState, crypto, parseAcpArgs, acpBackendCommand, async (method, route, body) => { registration.push(body); return { id: 'agent' }; }, () => {}, () => {}, () => {});
    await add({ name: 'custom', command: '"C:\\My Agent\\agent.exe"', args: '--config "C:\\My Agent\\config.json" ""' });
    assert.deepEqual(registration[0], { name: 'custom', command: 'node.exe', args: [path.join(__dirname, 'acp-launcher.cjs'), 'C:\\My Agent\\agent.exe', '--config', 'C:\\My Agent\\config.json', ''] });
    assert.equal(acpState.acp[0].command, 'C:\\My Agent\\agent.exe', 'settings retain the user executable, not the launcher');
    assert.deepEqual(acpState.acp[0].args, ['--config', 'C:\\My Agent\\config.json', '']);
    for (const extension of ['cmd', 'bat']) {
      const command = 'C:\\My Agent\\agent.' + extension;
      const customArgs = ['--config', 'C:\\My Agent\\config.json', '', 'say "hi"', '%ACP_TEST%', '!ACP_TEST!'];
      await add({ name: 'custom batch', command: '"' + command + '"', args: JSON.stringify(customArgs) });
      assert.deepEqual(registration.at(-1), { name: 'custom batch', command: 'node.exe', args: [launcher, command, ...customArgs] });
      assert.equal(acpState.acp.at(-1).command, command);
      assert.deepEqual(acpState.acp.at(-1).args, customArgs);
      await assert.rejects(add({ name: 'invalid batch', command, args: ['line\nbreak'] }), /批次檔/);
    }
    await assert.rejects(add({ name: 'invalid', command: 'agent.exe', args: '"unclosed' }), /雙引號/);
    await assert.rejects(add({ name: 'invalid', command: 'node --acp', args: '' }), /完整路徑/);
    assert.equal(registration.length, 3, 'invalid argv is rejected before registering an external agent');

    const cacheCode = src.slice(src.indexOf('// ponytail: reads the newest 200'), src.indexOf('function historyItems()'));
    const cache = new Function('S', 'writeJson', 'path', 'HISTORY', 'resumable', cacheCode + '; histCache.rev = S.historyRev; return { saveRun, histCache };')(
      { historyRev: 0 }, () => {}, path, root, () => false);
    for (let i = 0; i < 1000; i++) cache.saveRun({ run: { id: String(i).padStart(4, '0') }, tasks: [], activity: [] }, 'done');
    assert.equal(cache.histCache.items.length, 200); assert.equal(cache.histCache.rows.size, 200);
    assert.equal(cache.histCache.items[0].id, '0999');
    console.log('Integration: custom ACP registration preserves argv; history row index stays bounded with cached records: PASS');

    if (process.argv[2]) { // optional local smoke with the real pinned release; never starts a model or reads credentials
      const { AION_RELEASE } = await import('./aion-client.mjs');
      const official = path.join(root, 'official', 'aioncore.exe');
      await ensureVerifiedExecutable({ target: official, ...AION_RELEASE, cachedArchive: path.resolve(process.argv[2]) }, noNetwork);
      const version = execFileSync(official, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      assert.match(version, /0\.2\.2/);
      console.log('Official AionCore: pinned ZIP/executable hashes, actual staging install and --version 0.2.2: PASS');
    }
    finished();
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
