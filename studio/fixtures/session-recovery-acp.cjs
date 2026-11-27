// A local ACP agent with per-session history. Its only writes are under the test's temporary directory.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');

const data = process.argv[2];
let sessionId, pending;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const history = () => path.join(data, sessionId + '.json');
const log = method => fs.appendFileSync(path.join(data, 'audit.jsonl'), JSON.stringify({ pid: process.pid, sessionId, method }) + '\n');
createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const { method, id, params } = JSON.parse(line);
  if (method === 'initialize') {
    return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  }
  if (method === 'session/new') {
    sessionId = randomUUID();
    fs.writeFileSync(history(), 'null', { flag: 'wx' });
    log(method);
    return reply(id, { sessionId });
  }
  if (method === 'session/load' && /^[a-f\d-]{36}$/.test(params.sessionId)) {
    sessionId = params.sessionId;
    JSON.parse(fs.readFileSync(history(), 'utf8')); // Unknown sessions must not silently start fresh.
    log(method);
    return reply(id, {});
  }
  if (method === 'session/cancel' && params.sessionId === sessionId && pending != null) {
    log(method);
    reply(pending, { stopReason: 'cancelled' });
    pending = undefined;
    return;
  }
  if (method === 'session/prompt' && params.sessionId === sessionId) {
    const text = params.prompt.filter(x => x.type === 'text').map(x => x.text).join('\n');
    let answer;
    const store = text.match(/remember ([a-f\d-]{36})/);
    if (store) {
      fs.writeFileSync(history(), JSON.stringify(store[1]));
      answer = 'Saved';
    } else if (text.includes('recall the saved value')) {
      answer = JSON.parse(fs.readFileSync(history(), 'utf8'));
    } else if (text.includes('hold this turn')) {
      pending = id;
      log('hold');
      return;
    }
    if (typeof answer === 'string') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } });
      return reply(id, { stopReason: 'end_turn' });
    }
  }
  if (id != null) send({ id, error: { code: -32601, message: 'Unexpected recovery fixture request' } });
});
