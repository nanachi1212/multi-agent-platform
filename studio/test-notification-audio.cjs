const assert = require('node:assert/strict');
const finished = require('./test-finish.cjs')('Notification audio');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('// ---------- Notifications:'), html.indexOf('const ws = () =>'));

function openTab() {
  const document = new EventTarget(), notifyButton = {};
  const S = { notify: true, noticeSeq: 0, notices: [] };
  const contexts = [], tones = [];
  class AudioContext {
    constructor() { contexts.push(this); this.state = 'suspended'; this.currentTime = 0; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createOscillator() {
      return { frequency: {}, connect(node) { return node; }, start() { tones.push(this.frequency.value); }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }
  const handleNotices = vm.runInNewContext(code + '\nhandleNotices;', {
    document, S, AudioContext, $: () => notifyButton, post: async () => {}
  });
  handleNotices();
  function click() {
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('click'));
  }
  function notice(kind) {
    S.notices.push({ id: ++S.noticeSeq, kind });
    handleNotices();
  }
  return { S, contexts, tones, click, notice, handleNotices, notifyButton };
}

{
  const { S, contexts, tones, click, notice, handleNotices } = openTab();
  click();
  assert.equal(contexts.length, 0, 'ordinary office interactions must not open the audio device');
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
}

{
  const { S, contexts, tones, click, notice, handleNotices } = openTab();
  notice('done');
  notice('ask');
  const queued = contexts[0];
  assert.equal(queued.state, 'suspended');
  S.notify = false;
  handleNotices(); // another tab muted the shared setting
  click();
  assert.equal(queued.state, 'closed', 'a muted click cannot replay the two queued chimes');
  S.notify = true;
  handleNotices();
  click();
  assert.equal(contexts.length, 1, 'enabling notifications does not revive old tones');
  notice('ask');
  click();
  assert.equal(contexts[1].state, 'running');
  assert.deepEqual(tones, [660, 880, 440, 330, 440, 330]);
}

{
  const { contexts, click, notice, notifyButton } = openTab();
  notice('done');
  // The button handler runs before its click bubbles to document, while the POST is pending.
  notifyButton.onclick();
  click();
  assert.equal(contexts[0].state, 'closed', 'the mute click itself cannot unlock a queued chime');
}
finished();
console.log('Notification audio: lazy initialization, both chimes and mute cancellation PASS');
