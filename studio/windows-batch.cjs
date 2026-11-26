// cmd.exe parses the invocation, then a batch wrapper forwards %* to a native CLI.
// Quote for the native CLI first, then protect that text through BOTH shell parses.
const escapeCmd = value => value.replace(/[()\[\]%!^"`<>&|;, *?]/g, '^$&');
function quoteNativeArg(value) {
  // Match whole runs (linear time): all backslashes before a quote or the closing
  // quote must double. Escaping only the last slash corrupts e.g. two slashes + ".
  const escaped = value.replace(/\\+|"/g, (part, offset) => {
    if (part === '"') return '\\"';
    const end = offset + part.length;
    return end === value.length || value[end] === '"' ? part + part : part;
  });
  return '"' + escaped + '"';
}
module.exports = function batchInvocation(command, args) {
  if (command.includes('"') || [command, ...args].some(value => /[\0\r\n]/.test(value))) {
    throw new Error('批次檔路徑不可包含雙引號；路徑與參數不支援 NUL 或換行，請改用 .exe');
  }
  // The executable is consumed once; arguments survive the invocation and %*.
  const line = '"' + [escapeCmd(command), ...args.map(value => escapeCmd(escapeCmd(quoteNativeArg(value))))].join(' ') + '"';
  if (line.length > 8000) throw new Error('批次檔啟動指令過長，請縮短參數或改用 .exe');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/v:off', '/c', line], windowsVerbatimArguments: true };
};
module.exports.quoteNativeArg = quoteNativeArg;
