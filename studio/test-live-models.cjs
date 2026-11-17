const assert = require('node:assert/strict');
(async () => {
  const { applyTurnModel, updateModelCatalog } = await import('./live-models.mjs');
  const opts = () => [ { id: 'model/id', category: 'model', current_value: 'old', options: [{ value: 'old' }, { value: 'new', name: 'New' }] }, { id: 'reasoning_effort', category: 'thought_level', current_value: 'low', options: [{ value: 'low' }, { value: 'high' }] } ];
  const a = {}; updateModelCatalog(a, opts()); assert.equal(a.models[1].name, 'New'); assert.deepEqual(a.efforts, ['low', 'high']);
  let calls = [];
  // Match the pinned backend contract: GET config-options is a 404, not a snapshot.
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'POST' && url.endsWith('/runtime/ensure')) return { config_options: opts() };
    if (method === 'PUT' && url.includes('/config-options/')) return { confirmation: 'observed' };
    throw new Error('Route not found: ' + method + ' ' + url);
  };
  await applyTurnModel(api, 'same-conversation', { model: 'new', effort: 'high' }, a);
  assert.equal(calls.length, 3); assert.equal(calls[1].url, '/api/conversations/same-conversation/config-options/model%2Fid');
  assert.deepEqual(calls[0], { method: 'POST', url: '/api/conversations/same-conversation/runtime/ensure', body: {} });
  assert.equal(calls[2].url.endsWith('/reasoning_effort'), true);
  assert.ok(calls.every((c) => !/cancel|messages/.test(c.url)), 'only configuration, no restart or paid model message');
  calls = []; await applyTurnModel(api, 'same-conversation', { model: 'old' }, a); assert.equal(calls.length, 1);
  calls = []; await applyTurnModel(api, 'same-conversation', {}, a); assert.equal(calls.length, 0);
  await assert.rejects(applyTurnModel(api, 'same-conversation', { model: 'invented' }, a), /不支援/);
  calls = []; await assert.rejects(applyTurnModel(api, 'same-conversation', { model: 'new' }, a, () => false), /已停止/); assert.equal(calls.length, 0);
  await assert.rejects(applyTurnModel(async (m) => m === 'POST' ? { config_options: opts() } : { confirmation: 'command_ack' }, 'same', { model: 'new' }, a), /尚未確認/);
  await applyTurnModel(async (m) => m === 'POST' ? { config_options: opts() } : { confirmation: 'pending_next_turn' }, 'same', { model: 'new' }, a);
  let allowed = true;
  await assert.rejects(applyTurnModel(async (m) => { assert.equal(m, 'POST'); allowed = false; return { config_options: opts() }; }, 'same', { model: 'new' }, a, () => allowed), /已停止/);
  const fs = require('node:fs'), vm = require('node:vm');
  // The real turn must not send a model request after Stop crosses the settings await.
  const { region } = require('./lifecycle-harness.cjs');
  let sent = 0;
  const w = { run: { convs: { 'claude:lead': 'cid' } } };
  const env = { AGENTS: { claude: {} }, S: { agents: { claude: {} } },
    tierCfg: () => ({ model: 'new' }), usageOf: async () => null,
    applyTurnModel: async () => { w.run.stopped = true; }, api: () => {},
    sendMessage: async () => { sent++; }, Halt: class extends Error {} };
  const turn = new Function(...Object.keys(env), region('async function turn(agent,', '// ---------- External provider') + ';return turn')(...Object.values(env));
  await assert.rejects(turn('claude', 'cid', 'work', { w }), /已停止/);
  assert.equal(sent, 0, 'no message after stop during model switch');
  // Read-only workers set lead=true for permission handling, not for model tier selection.
  for (const [key, privileged, expectedHard] of [
    ['claude:work:ro', true, false], ['claude:work:ro@123abc', true, false],
    ['claude:work', false, false], ['claude:work:chk', false, false],
    ['claude:work:hard:ro@123abc', true, true], ['claude:work:hard', false, true],
    ['claude:lead', true, true]
  ]) {
    const run = { run: { convs: { [key]: 'cid' } } };
    let observedHard;
    const tierEnv = { ...env, tierCfg: (_w, _agent, hard) => { observedHard = !!hard; return {}; },
      applyTurnModel: async () => { throw new Error('tier probe complete'); } };
    const actualTurn = new Function(...Object.keys(tierEnv), region('async function turn(agent,', '// ---------- External provider') + ';return turn')(...Object.values(tierEnv));
    await assert.rejects(actualTurn('claude', 'cid', 'work', { w: run, lead: privileged }), /tier probe complete/);
    assert.equal(observedHard, expectedHard, key + ' retains its actual conversation model tier');
  }
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  assert.ok(html.includes('下一步生效')); assert.ok(!html.includes('下一次開始工作生效'));
  console.log('PASS live-model catalog, same conversation update, confirmation, cancellation, UI syntax');
})().catch((e) => { console.error(e); process.exitCode = 1; });
