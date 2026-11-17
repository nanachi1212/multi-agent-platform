// Pass ACP stdio directly through; only .cmd/.bat need a validated cmd.exe call.
const { spawn } = require('node:child_process');
const batchInvocation = require('./windows-batch.cjs');
const [command, ...args] = process.argv.slice(2);
const fail = error => {
  console.error('ACP launcher: ' + error.message);
  process.exitCode = 127;
};
try {
  if (!command) throw new Error('missing executable');
  const invocation = /\.(cmd|bat)$/i.test(command) ? batchInvocation(command, args) : { command, args };
  const child = spawn(invocation.command, invocation.args, { shell: false, stdio: 'inherit', windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  child.once('error', fail);
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { fail(error); }
