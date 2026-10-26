// A writer card's FILES line versus what the step really changed: Studio records the difference and never acts on it.
// Run: node studio/test-card-files.cjs   (real git in a temp repository, scripted agent replies, no network)
const { assert, makeEnv, mkTmp, newW } = require('./lifecycle-harness.cjs');
const fs = require('node:fs'), path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');

(async () => {
  const root = mkTmp('studio-files-'), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(repo, f), f);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n'); git('add', '.'); git('commit', '-qm', 'base');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  const { env, api } = makeEnv((agent, text) => { // the agent edits during its turn, then reports
    if (text.includes('Every current card has ended')) return '{"done":true,"report":"ok"}';
    if (text.includes('Task: listed')) { write('a.txt', 'A'); write('b.txt', 'B'); write('new.txt', 'n'); fs.unlinkSync(path.join(repo, 'c.txt')); write('out/build.log', 'x'); return `Edited.\nSTATUS: DONE\nFILES: a.txt, ./b.txt, ${repo}\\new.txt, c.txt`; }
    if (text.includes('Task: partial')) { write('a.txt', 'A2'); write('b.txt', 'B2'); return 'Edited.\nSTATUS: DONE\nFILES: a.txt'; }
    if (text.includes('Task: silent')) { write('a.txt', 'A3'); return 'Edited.\nSTATUS: DONE'; }
    if (text.includes('Task: crash')) { write('big.txt', 'line of a large generated file\n'.repeat(20000)); throw new Error('agent crashed mid-step'); }
    if (text.includes('Task: undoable')) { write('b.txt', 'B5'); write('sub/u.txt', 'u'); fs.unlinkSync(path.join(repo, 'new.txt')); return 'Edited.\nSTATUS: DONE\nFILES: b.txt, sub/u.txt, new.txt'; }
    if (text.includes('Task: reader')) { write('a.txt', 'A4'); return 'Read.\nSTATUS: DONE'; }
    return 'Nothing to change.\nSTATUS: DONE';
  }, { execFile, spawn });
  try {
    const cards = {}, wss = {};
    // title, writes, files expected to be flagged as changed-but-unreported
    for (const [title, writes, unreported] of [['listed', true, []], ['partial', true, ['b.txt']], ['silent', true, ['a.txt']], ['none', true, []], ['reader', false, []]]) {
      await new Promise((r) => setTimeout(r, 30)); // the previous card's edits are older than this job
      env.logs.length = 0; env.events.length = 0; env.S.workspaces.length = 0;
      const w = wss[title] = newW(); w.project = repo; w.run.project = repo; w.run.startedAt = new Date().toISOString(); env.S.workspaces.push(w);
      const t = cards[title] = { id: title, title, agent: 'codex', writes, status: 'WAITING', after: [], instructions: 'x' }; w.tasks.push(t);
      await api.runTask(w, t);
      assert.strictEqual(t.status, 'DONE', title + ': ' + t.result);
      const flagged = env.logs.filter((l) => l.text.includes('沒有出現在')), ev = env.events.filter((e) => e.type === 'card.files');
      if (!unreported.length) { assert.deepStrictEqual([flagged.length, ev.length], [0, 0], title + ': nothing to flag'); continue; }
      assert.strictEqual(flagged.length, 1, title);
      for (const f of unreported) assert.ok(flagged[0].text.includes(f), `${title}: names ${f} in ${flagged[0].text}`);
      assert.ok(flagged[0].text.includes('只記錄，不影響這張卡'), title + ': recorded only');
      assert.strictEqual(flagged[0].text.includes('沒有寫 FILES 行'), title === 'silent', title + ': a missing FILES line is said so');
      assert.deepStrictEqual(ev.map((e) => [e.card, e.reported, e.unreported]), [[title, title === 'silent' ? 0 : 1, unreported.length]]);
    }
    assert.ok(!cards.partial.result.includes('FILES:') && cards.partial.result === 'Edited.', 'the FILES line is not part of the card result');
    assert.deepStrictEqual([cards.listed.files.length, cards.listed.files[0], cards.listed.files[1], cards.listed.files[3]], [4, 'a.txt', 'b.txt', 'c.txt'], 'the reported list stays on the card, paths normalised');
    assert.deepStrictEqual([cards.partial.files, cards.silent.files, 'files' in cards.reader], [['a.txt'], [], false], 'no snapshot or list for a read-only card');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'A4', 'nothing in the tree is reverted');
    // Step diffs: a writing step that changed files keeps a before / after tree, read back as a patch; the real index stays as it was.
    assert.deepStrictEqual([cards.listed.steps?.length, cards.none.steps, cards.reader.steps], [1, undefined, undefined], 'only writing steps that changed files');
    const patch = (await api.stepDiff(wss.listed, 'listed', 0)).text;
    for (const s of ['+A', '+++ b/new.txt', '--- a/c.txt']) assert.ok(patch.includes(s), 'step diff has ' + s);
    assert.ok(!patch.includes('build.log'), 'ignored output is not in the step diff');
    assert.strictEqual(git('diff', '--cached', '--name-only'), '', 'snapshots never stage anything');
    // A step that ends in an error still records what it changed; a patch over the limit is cut, not lost.
    await new Promise((r) => setTimeout(r, 30));
    const cw = newW(); cw.project = repo; cw.run.project = repo; cw.run.startedAt = new Date().toISOString(); env.S.workspaces.length = 0; env.S.workspaces.push(cw);
    const crash = { id: 'crash', title: 'crash', agent: 'codex', writes: true, status: 'WAITING', after: [], instructions: 'x' }; cw.tasks.push(crash);
    await api.runTask(cw, crash);
    assert.strictEqual(crash.steps?.length, 1, 'failed step keeps its diff');
    const big = (await api.stepDiff(cw, 'crash', 0)).text;
    assert.ok(big.includes('big.txt') && big.endsWith('k 字元）') && big.length < 401e3, 'large patch is cut at the limit');
    // 復原這一步: the step's files go back (edits, created and deleted files), HEAD and the index stay; the undo is a step too.
    await new Promise((r) => setTimeout(r, 30));
    const uw = newW(); uw.project = repo; uw.run.project = repo; uw.run.startedAt = new Date().toISOString(); env.S.workspaces.length = 0; env.S.workspaces.push(uw);
    const ut = { id: 'undo', title: 'undoable', agent: 'codex', writes: true, status: 'WAITING', after: [], instructions: 'x' }; uw.tasks.push(ut);
    await api.runTask(uw, ut);
    const read = (f) => fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), 'utf8') : null;
    assert.strictEqual(ut.status, 'DONE', 'undoable: ' + ut.result + ' ' + ut.detail);
    const head = git('rev-parse', 'HEAD');
    uw.tasks.push({ id: 'busy', title: 'busy', status: 'WORKING', writes: true });
    await assert.rejects(api.undoStep(uw, 'undo', 0), /正在修改/, 'not while a writer works');
    uw.tasks.pop();
    assert.deepStrictEqual((await api.undoStep(uw, 'undo', 0)).files, 3);
    assert.deepStrictEqual([read('b.txt'), read('sub/u.txt'), read('new.txt'), read('a.txt')], ['B2', null, 'n', 'A4'], 'step undone, other files kept');
    assert.deepStrictEqual([git('rev-parse', 'HEAD'), git('diff', '--cached', '--name-only'), ut.steps.length, ut.steps[1].undo], [head, '', 2, 0], 'HEAD and index untouched, undo recorded');
    await api.undoStep(uw, 'undo', 1);
    assert.deepStrictEqual([read('b.txt'), read('sub/u.txt'), read('new.txt')], ['B5', 'u', null], 'the undo can be undone');
    const before = read('a.txt');
    await assert.rejects(api.undoStep(wss.listed, 'listed', 0), /無法乾淨地復原.*檔案都沒有改動/, 'later edits to the same file: refused');
    assert.deepStrictEqual([read('a.txt'), read('b.txt')], [before, 'B5'], 'a refused undo changes nothing');
    // A worker that can edit the repo config must not get a program run by Studio's own git: snapshots never run filters.
    git('config', 'filter.trap.clean', 'echo ran > FILTER_RAN; cat # x.clean=y'); write('.gitattributes', 'trap.dat filter=trap\n'); write('trap.dat', 'x');
    assert.ok(await api.snapTree(repo), 'snapshot still taken');
    assert.ok(!fs.existsSync(path.join(repo, 'FILTER_RAN')), 'repo-configured clean filter did not run');
    console.log('card files: listed vs changed, absolute and ./ paths, deletions, ignored output, missing FILES line, read-only cards, step diffs, step undo: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
