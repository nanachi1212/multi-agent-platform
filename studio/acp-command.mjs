import path from 'node:path';

// AionCore v0.2.2 splits custom command on whitespace before its ACP probe.
// Keep the executable in argv instead, without involving a shell or changing it.
export function acpBackendCommand(command, args) {
  if (!command || /[\0\r\n"]/.test(command)) throw new Error('啟動指令須為單一執行檔；參數請填在參數欄');
  if (!/\s/.test(command)) return { command, args };
  if (!path.win32.isAbsolute(command) || path.win32.extname(command).toLowerCase() !== '.exe') {
    throw new Error('含空白的啟動指令請填 .exe 的完整路徑；參數請分開填寫（不支援 .cmd／.bat 路徑）');
  }
  return { command: 'node.exe', args: [path.join(import.meta.dirname, 'acp-launcher.cjs'), command, ...args] };
}

// The probe resolves node.exe before applying per-agent env. Use Studio's Node
// installation even when Studio itself was launched by an absolute path.
export function withAcpLauncherPath(env) {
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return { ...env, [key]: [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter) };
}
