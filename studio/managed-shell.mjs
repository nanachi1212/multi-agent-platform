import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { once } from 'node:events';
import batchInvocation from './windows-batch.cjs';

const shellImage = /^(?:pwsh|powershell)\.exe$/i;
function isWindowsAppsShell(file) {
  const names = path.win32.normalize(file).split('\\');
  return shellImage.test(names.at(-1)) && names.some(name => name.toLowerCase() === 'windowsapps');
}

export function isPackagedPowerShell(executable) {
  if (process.platform !== 'win32') return false;
  // Both the Store install directory and its registered per-user execution alias.
  if (isWindowsAppsShell(executable)) return true;
  try { return isWindowsAppsShell(fs.realpathSync.native(executable)); }
  catch {
    if (shellImage.test(path.win32.basename(executable))) throw new Error('無法確認指定 PowerShell 的實際路徑，未啟動 runtime');
    return false;
  }
}

export function managedExecutableExists(executable) {
  if (fs.existsSync(executable)) return true;
  // App execution aliases can be visible to lstat but reject stat/realpath. The
  // native launcher still verifies the actual process and Job before admission.
  return process.platform === 'win32' && isWindowsAppsShell(executable)
    && !!fs.lstatSync(executable, { throwIfNoEntry: false })?.isSymbolicLink();
}

function ticketPath(rtDir, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Windows Job 識別碼不合法');
  return path.join(rtDir, 'studio', 'shell-jobs', id);
}

export function shellJobReceipt(rtDir, runtime) {
  const ticket = ticketPath(rtDir, runtime.shell_job);
  let receipt;
  try { receipt = fs.readFileSync(ticket + '.drained', 'ascii'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const match = /^([1-9]\d*) (\d+) 0$/.exec(receipt);
  if (!match || Number(match[1]) !== runtime.root_pid || Number(match[2]) > 0xffffffff) throw new Error('Windows Job 排空憑證與已登記程序不符');
  return { exit_code: Number(match[2]) };
}

async function removeGeneratedHost(host) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.unlink(host); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export async function stopShellJob(rtDir, runtime) {
  const ticket = ticketPath(rtDir, runtime.shell_job);
  let receipt = shellJobReceipt(rtDir, runtime);
  if (!receipt) {
    fs.writeFileSync(ticket + '.stop', '');
    const until = Date.now() + 8000;
    while (!receipt && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
      receipt = shellJobReceipt(rtDir, runtime);
    }
  }
  if (!receipt) throw new Error('未收到 Windows Job 全部程序已結束的確認，保留工作區待重試');
  await removeGeneratedHost(ticket + '.exe');
  fs.rmSync(ticket + '.stop', { force: true });
  return receipt;
}

export async function launchPackagedPowerShell(executable, args, { cwd, env, rtDir }, record) {
  const system = process.env.SystemRoot;
  const id = randomUUID(), job = 'Local\\StudioManagedShell-' + id;
  const ticket = ticketPath(rtDir, id);
  fs.mkdirSync(path.dirname(ticket), { recursive: true });
  if ([executable, ...args].some(s => s.includes('\0'))) throw new Error('runtime 參數含 NUL，未啟動');
  const command = [executable, ...args].map(batchInvocation.quoteNativeArg).join(' ');
  const environment = Object.entries(env).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0)
    .map(([key, value]) => key + '=' + value);
  // Windows PowerShell 5.1 does not reliably execute commands in a detached process.
  // Build the exact source for this launch; never execute a pre-existing cached binary.
  const compiler = ['Framework64', 'Framework'].map(dir => path.join(system, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe')).find(fs.existsSync);
  if (!compiler) throw new Error('缺少 Windows .NET Framework 編譯器，無法建立 Job');
  const host = ticket + '.exe';
  const helperEnv = { SystemRoot: system, WINDIR: system, PATH: path.join(system, 'System32'), TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    await promisify(execFile)(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Web.Extensions.dll',
      '/out:' + host, path.join(import.meta.dirname, 'ManagedShellJob.cs')], { env: helperEnv, windowsHide: true, timeout: 15000 });
  } catch { await removeGeneratedHost(host); throw new Error('無法建置 Windows Job helper，未啟動 runtime'); }
  const pipe = 'StudioManagedShell-' + randomUUID(), handshake = randomUUID();
  const server = net.createServer();
  server.maxConnections = 1;
  server.listen({ path: '\\\\.\\pipe\\' + pipe });
  try { await once(server, 'listening'); } catch (error) { await removeGeneratedHost(host); throw error; }
  const connected = once(server, 'connection');
  const helper = spawn(host, [], {
    cwd: import.meta.dirname, windowsHide: true, detached: true, stdio: 'ignore',
    env: { ...helperEnv, STUDIO_JOB_PIPE: pipe, STUDIO_JOB_HANDSHAKE: handshake, STUDIO_JOB_PARENT: String(process.pid) },
  });
  const exited = new Promise(resolve => {
    helper.once('error', () => resolve({ failed: true }));
    helper.once('close', (code, signal) => resolve({ failed: code !== 0 || !!signal }));
  }).then(async result => {
    // If Studio exited first, stopShellJob performs the same retirement on reconnect.
    try { await removeGeneratedHost(host); } catch { return { failed: true }; }
    return result;
  });
  let socket, lines;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; socket?.destroy(); helper.kill(); }, 30000);
  async function read() {
    const { done, value } = await lines.next();
    if (done || value.startsWith('ERROR ')) throw new Error('無法確認 Windows Job，未啟動 runtime：'
      + (timedOut ? '建立逾時' : done ? '原生程序已結束' : value.slice(6)));
    return value;
  }
  try {
    const connection = await Promise.race([connected, exited.then(() => null)]);
    if (!connection) throw new Error('Windows Job helper 未能建立通訊');
    [socket] = connection;
    lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
    if (await read() !== handshake) throw new Error('Windows Job helper 無法驗明身分');
    socket.write(JSON.stringify({ exe: executable, command, cwd, environment, job, ticket }) + '\n');
    const ready = /^READY ([1-9]\d*) (\d+) ([A-Za-z0-9+/=]+)$/.exec(await read());
    if (!ready) throw new Error('Windows Job 未回報已確認的程序身分');
    const pid = Number(ready[1]);
    // Same time representation as Win32_Process.CreationDate in Windows PowerShell JSON.
    // Both fields come from the actual process handle before its main thread runs.
    await record(pid, id, { creationDate: '/Date(' + ready[2] + ')/', executable: Buffer.from(ready[3], 'base64').toString('utf8') });
    socket.write('RUN\n');
    if (await read() !== 'RUNNING') throw new Error('Windows Job 未確認 runtime 已開始執行');
    helper.unref();
    return { pid, exited };
  } catch (error) {
    socket?.destroy();
    // EOF before RUN releases the private Job. If the helper is unresponsive,
    // close only the handle of the helper we started, which also releases its Job.
    const fallback = setTimeout(() => helper.kill(), 2000);
    try { await exited; } finally { clearTimeout(fallback); }
    throw error;
  } finally { clearTimeout(deadline); socket?.destroy(); server.close(); }
}
