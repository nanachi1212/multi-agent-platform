// Optional progress files cannot take down /api/state. No providers, network, or file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
const code = source.match(/function readProjectProgress\(w\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(code);
let failure = null, content = '# Progress\n完成', reads = 0;
const context = { path, fs: { existsSync: () => failure?.code !== 'ENOENT', readFileSync(file, encoding) {
  reads++; assert.equal(encoding, 'utf8'); assert.ok(file.endsWith(path.join('.ai-workspace', 'progress.md')));
  if (failure) throw failure;
  return content;
} } };
vm.createContext(context); vm.runInContext(code, context);
const read = () => context.readProjectProgress({ project: path.resolve('example-project') });
const success = read();
assert.equal(success.exists, true); assert.equal(success.text, content); assert.equal(success.error, undefined);
content = ''; assert.equal(read().exists, true, 'empty file still exists');
failure = Object.assign(new Error('do not expose this private message'), { code: 'ENOENT' });
const missing = read();
assert.equal(missing.exists, false); assert.equal(missing.text, ''); assert.equal(missing.error, undefined);
for (const errno of ['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EIO', 'EMFILE', 'ELOOP']) {
  failure = Object.assign(new Error('PRIVATE_CONTENT secret-token'), { code: errno });
  const result = read();
  assert.equal(result.exists, false); assert.equal(result.text, '');
  assert.ok(result.error.includes(errno), 'I/O problem is visible, not mistaken for absence');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CONTENT') && !JSON.stringify(result).includes('secret-token'));
}
failure = Object.assign(new Error('SECRET_MESSAGE'), { code: 'SECRET_CODE' });
assert.equal(read().error, '無法讀取專案進度（IO_ERROR）', 'unknown exceptions do not expose raw messages or codes');
failure = null; content = 'Recovered'; assert.equal(read().text, 'Recovered', 'next poll retries and recovers');
assert.equal(reads, 12);

// Exercise the production progress-panel rendering statements directly.
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const panelCode = html.match(/  const showProgress = [\s\S]*?\$\('progress'\)\.textContent = [^\n]+;/)?.[0];
assert.ok(panelCode);
const elements = { progressBox: { parentElement: { style: {} } }, progressTitle: {}, progress: {} };
function render(progress) {
  vm.runInNewContext(panelCode, { w: { progress }, $: (id) => elements[id] });
}
render(success); assert.equal(elements.progressBox.hidden, false); assert.equal(elements.progress.textContent, success.text);
render(missing); assert.equal(elements.progressBox.hidden, true); assert.equal(elements.progressBox.parentElement.style.gridTemplateColumns, '1fr');
render({ exists: false, text: '', error: '無法讀取專案進度（EACCES）', file: success.file });
assert.equal(elements.progressBox.hidden, false); assert.equal(elements.progress.textContent, '無法讀取專案進度（EACCES）');
assert.equal(elements.progressTitle.title, success.file);
render(undefined); assert.equal(elements.progressBox.hidden, true);
console.log('Progress read isolation and error display: PASS');
