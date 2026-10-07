// Self-check for Studio's card lifecycle: runs the real code from server.mjs with scripted agent replies.
// Run: node studio/lifecycle-check.cjs   (no agents, no network)
const assert = require('assert');
const nodeCrypto = require('crypto');
const src = require('fs').readFileSync(require('path').join(__dirname, 'server.mjs'), 'utf8').replace(/\r\n/g, '\n');
const region = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('region ' + a); return src.slice(i, j); };
const code = region('function handoffNote(run)', '// ---------- Plan limits') + region('async function planPhase(w)', '// Changing the Leader mid-run');

const storeSource = require('fs').readFileSync(require('path').join(__dirname, 'workspace-lease.mjs'), 'utf8').replace('export function', 'function');
const createWorkspaceLeaseStore = new Function(storeSource + '\nreturn createWorkspaceLeaseStore;')();
const TMP_DIRS = [];
function mkTmp(prefix) { const d = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), prefix)); TMP_DIRS.push(d); return d; }
function makeEnv(script, overrides = {}) {
  const logs = [], notices = [], prompts = [];
  const env = {
    createWorkspaceLeaseStore,
    AGENTS: { claude: { name: 'Claude Code' }, codex: { name: 'Codex' }, antigravity: { name: 'Antigravity' } },
    S: { workspaces: [], leases: [] }, RT: mkTmp('studio-rt-'), api: async () => ({ items: [] }), stopTurn: async () => true, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), crypto: nodeCrypto, logs, notices, prompts,
    log: (w, who, role, text, detail) => logs.push({ who, role, text, detail }),
    notify: (title, body, kind) => notices.push({ title, body, kind }),
    label: () => 'TestProj', refreshClaudeLimits() {}, saveRun() {}, saveSettings() {}, latestJob: () => null, clip: (x, n) => String(x ?? '').slice(0, n), AUTO_MAX: 5, AFTER_DONE: ['stop', 'suggest', 'auto'],
    started: [], start: async (w, request, cont) => { env.started.push({ request, cont }); }, setTimeout: (fn, ms) => (ms === 5000 ? queueMicrotask(fn) : globalThis.setTimeout(fn, ms)), // only the 5 s auto-continue delay is skipped
    Halt: class extends Error {}, active: new Map(), busyConvs: () => [], cancelTurn() {}, convAgent: new Map(),
    available: () => true, workersFor: (w, lead) => w.workers.filter((x) => x !== lead),
    tierCfg: (w, agent, hard) => ({ model: hard ? 'strong' : 'cheap', effort: '' }),
    fs: require('fs'), path: require('path'), refreshState() {},
    workKey: (t) => t.agent + ':work' + (t.hard ? ':hard' : '') + (t.workdir ? '@wt' : ''),
    conv: async (w, agent, lead, hard, workdir) => { const k = agent + (lead ? ':lead' : ':work') + (hard ? ':hard' : '') + (workdir ? '@wt' : ''); return (w.run.convs[k] ??= k); },
    turn: async (agent, cid, text) => { prompts.push({ agent, cid, text }); await new Promise((r) => setTimeout(r, 5)); return script(agent, text); },
    execFile: (cmd, args, opts, cb) => cb(new Error('no git / gh in test'), '', ''), isDir: () => true, readHistory() {}, openWorkspace() {}, wsOf() {},
  };
  env.agentName = (id) => env.AGENTS[id]?.name || id;
  Object.assign(env, overrides);
  const names = Object.keys(env);
  const api = new Function(...names, code + '\nreturn { planPhase, pump, summarize, answer, continueCard, wake, parseStatus, finish, autoNext, instruct, pause, resume, stop, handoffWriter, claimWorkspace, releaseClaim, useWorktree, useReadOnly, checkWorkspaces, acquireWrite, workspaceOf, loadLeases, saveLeases, leaseState, leaseView, writerOf, retire, beatLeases, cleanupWorktree, runTask, treeKey, newLease, flagExternalModification, loadRun, reassign, drainExecution, pauseAndDrain, stopAndDrain, takeWriteSlot, treeStamp, INSTANCE };')(...names.map((k) => env[k])); // test harness: our own code
  return { env, api };
}
const newW = () => ({ project: 'P', leader: 'claude', workers: ['claude', 'codex', 'antigravity'], tasks: [], activity: [],
  run: { id: 'r', project: 'P', leader: 'claude', request: 'Build feature X and get it reviewed', convs: {}, phase: 'planning', leaderGen: 0, rounds: 0, ask: null, active: true, paused: false, stopped: false, summarizing: false } });
const settle = () => new Promise((r) => setTimeout(r, 300));

module.exports = { assert, nodeCrypto, src, region, TMP_DIRS, mkTmp, makeEnv, newW, settle };
