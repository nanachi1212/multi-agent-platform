const assert = require('node:assert/strict');
const path = require('node:path');
const { region } = require('./lifecycle-harness.cjs');

(async () => {
  const rt = path.resolve('fixture-runtime'), home = path.resolve('fixture-auth-home');
  const homeCode = region('const CODEX_HOME =', 'const sleep =') + '\nreturn CODEX_HOME;';
  const resolveHome = env => new Function('process', 'path', 'RT', homeCode)({ env }, path, rt);
  assert.equal(resolveHome({ CODEX_HOME: 'ambient-home' }), path.join(rt, 'studio', 'codex-home'));
  assert.equal(resolveHome({ STUDIO_CODEX_HOME: home }), home);

  // The first copy is managed; future edits sync only while that copy is unchanged.
  const fs = require('node:fs'), os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rules-')), user = path.join(tmp, 'user'), studio = path.join(tmp, 'studio');
  for (const d of [user, studio]) fs.mkdirSync(d);
  const { syncRulesFile } = await import('./local-maintenance.mjs');
  const sync = new Function('process', 'path', 'RT', 'fs', 'os', 'syncRulesFile', homeCode.replace('return CODEX_HOME;', 'return syncCodexRules;'))({ env: {} }, path, rt, fs, os, syncRulesFile);
  try {
    assert.equal(sync({ CODEX_HOME: user }, studio), false, 'no global AGENTS.md: nothing copied');
    assert.ok(!fs.existsSync(path.join(studio, 'AGENTS.md')));
    fs.writeFileSync(path.join(user, 'AGENTS.md'), 'use pwsh');
    assert.equal(sync({ CODEX_HOME: user }, studio), true);
    fs.writeFileSync(path.join(user, 'AGENTS.md'), 'use pwsh 7');
    sync({ CODEX_HOME: user }, studio);
    assert.equal(fs.readFileSync(path.join(studio, 'AGENTS.md'), 'utf8'), 'use pwsh 7', 'the next start picks up an edit');
    assert.equal(sync({ CODEX_HOME: user }, user), false, 'Studio pointed at the user home itself: no self-copy');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  let status = 'Not logged in', exit = new Error('exit 1'), calls = 0;
  const failureNote = new Function('execFile', 'process', 'CODEX_HOME',
    region('async function codexFailureNote', 'async function checkAgent') + '\nreturn codexFailureNote;')(
    (command, args, options, done) => {
      calls++;
      assert.equal(options.env.CODEX_HOME, home, 'diagnosis must use the same home as the provider and login');
      assert.deepEqual(args, process.platform === 'win32' ? ['/d', '/s', '/c', 'codex login status'] : ['login', 'status']);
      assert.equal(options.timeout, 15000);
      done(exit, '', status);
    }, process, home);
  assert.match(await failureNote('The model provider rejected the request'), /尚未登入.*STUDIO_CODEX_HOME/);
  status = 'Logged in using ChatGPT'; exit = null;
  assert.equal(await failureNote('401 Unauthorized'), '401 Unauthorized', 'do not mislabel a logged-in provider failure');
  status = 'CLI failed'; exit = new Error('timeout');
  assert.equal(await failureNote('The model provider rejected the request'), 'The model provider rejected the request');
  const count = calls;
  assert.equal(await failureNote('Quota exceeded'), 'Quota exceeded');
  assert.equal(calls, count, 'non-auth failures do not trigger login diagnostics');

  let finishDiagnosis;
  const a = {}, S = { agents: { codex: a } };
  const check = new Function('S', 'path', 'RT', 'fs', 'AGENTS', 'createConv', 'turn', 'codexFailureNote',
    region('async function checkAgent', 'const checkAll =') + '\nreturn checkAgent;')(
    S, path, rt, { mkdirSync() {} }, { codex: {} }, async () => 'fixture',
    async () => { throw new Error('The model provider rejected the request'); },
    () => new Promise(resolve => { finishDiagnosis = resolve; }));
  const pending = check('codex');
  await new Promise(resolve => setImmediate(resolve));
  a.checkTok = {}; a.status = 'available'; a.note = '';
  finishDiagnosis('Not logged in'); await pending;
  assert.equal(a.status, 'available', 'an older diagnostic cannot overwrite a newer successful check');
  assert.equal(a.note, '');
  console.log('Codex provider: explicit home, login diagnosis, original failures and concurrent recheck: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
