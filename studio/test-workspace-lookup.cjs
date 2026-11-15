// workspaceLookup: one git call for a normal repo, the same answers as the step-by-step path for every kind of folder (real git, temp folders).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFile, execFileSync } = require('node:child_process');
const src = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
const from = src.indexOf('async function workspaceLookup'), end = src.slice(from).search(/\r?\n\}\r?\n/);
assert.ok(from > 0 && end > 0, 'found workspaceLookup');
const code = src.slice(from, from + end) + '\n}';
const calls = [];
const git = (cwd, ...args) => new Promise((res) => { calls.push(args); execFile('git', ['-c', 'safe.directory=*', ...args], { cwd, windowsHide: true }, (e, out) => res(e ? { err: 'x' } : { out: String(out) })); });
const canonPath = (p) => path.resolve(p).toLowerCase(), treeKey = canonPath;
const lookup = new Function('git', 'originRepo', 'canonPath', 'treeKey', code + '\nreturn workspaceLookup;')(git, async () => '', canonPath, treeKey);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-lookup-'));
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
(async () => {
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), '1'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'x');
    fs.mkdirSync(path.join(repo, 'sub'));
    calls.length = 0;
    const r = await lookup(path.join(repo, 'sub'));
    assert.deepEqual([r.isGit, r.path, r.branch, r.repo], [true, canonPath(repo), 'main', canonPath(path.join(repo, '.git'))]);
    assert.equal(calls.length, 1, 'a normal repo needs one git call');
    const wt = path.join(root, 'wt'); g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const w = await lookup(wt);
    assert.deepEqual([w.path, w.branch, w.repo], [canonPath(wt), 'feat', canonPath(path.join(repo, '.git'))], 'a worktree shares the main repo identity');
    const unborn = path.join(root, 'unborn'); fs.mkdirSync(unborn); g(unborn, 'init', '-q', '-b', 'main');
    const u = await lookup(unborn);
    assert.deepEqual([u.isGit, u.path, u.branch, u.repo], [true, canonPath(unborn), '', canonPath(path.join(unborn, '.git'))], 'a repo with no commit still counts as git');
    const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
    const p = await lookup(plain);
    assert.deepEqual([p.isGit, p.path, p.branch, p.repo], [false, canonPath(plain), '', '']);
    console.log('workspace lookup: one git call, worktree, repo without commits, plain folder: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
