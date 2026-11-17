// Minimal test agent, based on ACP v1 initialization/session/config-options wire contracts:
// https://agentclientprotocol.com/protocol/v1/session-config-options
// No models, network, subprocesses or project writes. Audit only to the test-owned path.
const fs = require('node:fs');
const readline = require('node:readline');
const audit = process.argv[2];
const options = [
  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'contract-small',
    options: [{ value: 'contract-small', name: 'Small' }, { value: 'contract-large', name: 'Large' }] },
  { id: 'reasoning_effort', category: 'thought_level', name: 'Effort', type: 'select', currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
let sessionId;
setTimeout(() => process.exit(3), 180000).unref(); // bounded fixture lifetime even if the runner dies
readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(audit, JSON.stringify({ pid: process.pid, parentPid: process.ppid, method: request.method, configId: request.params?.configId,
    ...(request.method === 'initialize' ? { executable: process.execPath, args: process.argv.slice(3) } : {}) }) + '\n');
  if (request.id == null) return;
  let result, error;
  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'studio-contract', version: '1' } };
  else if (request.method === 'session/new') {
    sessionId = 'contract-' + process.pid;
    result = { sessionId, configOptions: options };
  } else if (request.method === 'session/set_config_option' && request.params.sessionId === sessionId) {
    const option = options.find(x => x.id === request.params.configId);
    if (option?.options.some(x => x.value === request.params.value)) {
      option.currentValue = request.params.value;
      result = { configOptions: options };
    } else error = { code: -32602, message: 'Invalid fixture config option' };
  } else error = { code: -32601, message: 'Unsupported fixture method: ' + request.method };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n');
});
