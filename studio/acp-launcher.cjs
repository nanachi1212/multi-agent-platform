// Pass ACP stdio directly to the executable. Never parse argv or invoke a shell.
const { spawn } = require('node:child_process');
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('ACP launcher: missing executable');
  process.exitCode = 127;
} else {
  const child = spawn(command, args, { shell: false, stdio: 'inherit', windowsHide: true });
  child.once('error', error => {
    console.error('ACP launcher: ' + error.message);
    process.exitCode = 127;
  });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
