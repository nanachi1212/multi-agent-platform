// Batch files are parsed by cmd.exe, then often forward %* to a native CLI.
// Accept only arguments that remain quoted data in both parses. In particular,
// backslash does NOT escape a quote for cmd, and % expands even inside quotes.
module.exports = function batchInvocation(command, args) {
  if ([command, ...args].some(value => /[\0\r\n"%!]/.test(value))) {
    throw new Error('批次檔路徑與參數不支援內嵌雙引號、%、! 或換行；請改用 .exe，或直接用 node.exe 執行 Agent 腳本');
  }
  // Double trailing backslashes so a forwarding wrapper's native CLI receives
  // the original value, including an empty argument or a path ending in \\.
  const quote = value => '"' + value + (value.match(/\\+$/)?.[0] || '') + '"';
  const line = '"' + ['"' + command + '"', ...args.map(quote)].join(' ') + '"';
  if (line.length > 8000) throw new Error('批次檔啟動指令過長，請縮短參數或改用 .exe');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/v:off', '/c', line], windowsVerbatimArguments: true };
};
