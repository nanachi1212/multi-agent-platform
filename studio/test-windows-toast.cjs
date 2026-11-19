const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { region } = require('./lifecycle-harness.cjs');

if (process.platform !== 'win32') {
  console.log('Windows toast XML SKIP (requires WinRT)');
  return;
}

// Inspect the production WinRT document immediately before delivery, without posting a desktop notification in CI.
function readToastPayload(exe, args, options) {
  const [noProfile, command, script] = args;
  const delivery = script.indexOf('[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(');
  assert.ok(delivery > 0, 'expected the Windows toast delivery call');
  const inspect = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$doc = [xml]$x.GetXml()
$binding = $doc.SelectSingleNode('/toast/visual/binding')
@{
  launch = $doc.DocumentElement.GetAttribute('launch')
  title = $binding.SelectSingleNode('text[1]').InnerText
  body = $binding.SelectSingleNode('text[2]').InnerText
  attribution = $binding.SelectSingleNode('text[@placement="attribution"]').InnerText
} | ConvertTo-Json -Compress`;
  const json = execFileSync(exe, [noProfile, command, script.slice(0, delivery) + inspect], {
    ...options, encoding: 'utf8', timeout: 15000,
  });
  return JSON.parse(json);
}

const windowsToast = new Function('execFile',
  region('function windowsToast(', 'function renameWorkspace(') + 'return windowsToast;');
const title = '測試 <A&B>：今日 API 用量達 80%';
const body = '外部模型工作卡已用 80 / 100 tokens。';
const url = 'http://127.0.0.1:4859/#p=test%20project';
let payload;
const send = windowsToast((...args) => { payload = readToastPayload(...args); });
send(title, body, url);
assert.deepEqual(payload, { title, body, launch: url, attribution: 'Multi-Agent Studio' });
console.log('Windows toast title, body, attribution and project URL PASS');
