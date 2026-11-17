import path from 'node:path';
import batchInvocation from './windows-batch.cjs';

// AionCore v0.2.2 splits custom command on whitespace before its ACP probe.
// Keep the executable in argv instead. Only batch files use a validated shell.
export function acpBackendCommand(command, args) {
  if (!command || /[\0\r\n"]/.test(command)) throw new Error('啟動指令須為單一執行檔；參數請填在參數欄');
  if (!/\s/.test(command)) return { command, args };
  if (!path.win32.isAbsolute(command) || !/\.(exe|cmd|bat)$/i.test(command)) {
    throw new Error('含空白的啟動指令請填 .exe／.cmd／.bat 的完整路徑；參數請分開填寫');
  }
  if (/\.(cmd|bat)$/i.test(command)) batchInvocation(command, args); // reject unsafe input before AionCore's probe
  return { command: 'node.exe', args: [path.join(import.meta.dirname, 'acp-launcher.cjs'), command, ...args] };
}

// The probe resolves node.exe before applying per-agent env. Use Studio's Node
// installation even when Studio itself was launched by an absolute path.
export function withAcpLauncherPath(env) {
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return { ...env, [key]: [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter) };
}
