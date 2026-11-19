const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('// ---------- Notifications:'), html.indexOf('function renderNotifyBtn()'));
const document = new EventTarget();
const S = { notify: true, noticeSeq: 0, notices: [] };
const contexts = [], tones = [];
class AudioContext {
  constructor() { contexts.push(this); this.state = 'suspended'; this.currentTime = 0; }
  async resume() { this.state = 'running'; }
  createOscillator() {
    return { frequency: {}, connect(node) { return node; }, start() { tones.push(this.frequency.value); }, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
}
const handleNotices = vm.runInNewContext(code + '\nhandleNotices;', { document, S, AudioContext });
function click() {
  document.dispatchEvent(new Event('pointerdown'));
  document.dispatchEvent(new Event('click'));
}

handleNotices();
click();
assert.equal(contexts.length, 0, 'ordinary office interactions must not open the audio device');
function notice(kind) {
  S.notices.push({ id: ++S.noticeSeq, kind });
  handleNotices();
}
S.notify = false;
notice('done');
assert.equal(contexts.length, 0);
S.notify = true;
notice('done');
assert.equal(contexts.length, 1);
assert.deepEqual(tones, [660, 880]);
click();
assert.equal(contexts[0].state, 'running', 'a later user gesture can unlock a blocked chime');
notice('ask');
handleNotices();
assert.equal(contexts.length, 1);
assert.deepEqual(tones, [660, 880, 440, 330], 'each new notice plays its original two tones once');
console.log('Notification audio: lazy initialization, activation and both chimes PASS');
