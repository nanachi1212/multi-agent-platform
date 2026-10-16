const assert = require('node:assert/strict');
const path = require('node:path');
const { region } = require('./lifecycle-harness.cjs');

(async () => {
  const rt = path.resolve('fixture-runtime'), home = path.resolve('fixture-auth-home');
  const homeCode = region('const CODEX_HOME =', 'const sleep =') + '\nreturn CODEX_HOME;';
  const resolveHome = env => new Function('process', 'path', 'RT', homeCode)({ env }, path, rt);
  assert.equal(resolveHome({ CODEX_HOME: 'ambient-home' }), path.join(rt, 'studio', 'codex-home'));
  assert.equal(resolveHome({ STUDIO_CODEX_HOME: home }), home);

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
