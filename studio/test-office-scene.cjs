// Office markup regressions. No server, model, or provider process is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const ctx = {
  S: { agents: [], workspaces: [] }, esc, ASK_PENDING: ['queued', 'sent'],
  look: () => ({ c: '#008877' }), latestAsk: () => null,
  roomState: a => ({ kind: a.kind, text: a.text, task: a.task, ws: 'C:\\A&B' })
};
vm.createContext(ctx);
vm.runInContext(html.match(/function roomHtml\(w\) \{[\s\S]*?\n\}/)[0], ctx);
assert.match(ctx.roomHtml(null), /還沒有 AI 員工/);
ctx.S.agents = ['work', 'wait', 'need', 'sleep', 'coffee', 'phone', 'off'].map((kind, i) => ({id: String(i), kind, name: '<agent>', text: '<status>', task: i === 0 ? {id:'t1'} : null}));
const result = ctx.roomHtml({leader:'0', workers:['1','2','3','4','5','6'], name:'<project>'});
for (const a of ctx.S.agents) assert.match(result, new RegExp(`class="desk ${a.kind}`));
assert.equal((result.match(/class="chair" aria-hidden="true"/g) || []).length, 7);
assert.equal((result.match(/class="cup" aria-hidden="true"/g) || []).length, 7);
assert.match(result, /data-detail="t1" data-ws="C:\\A&amp;B"/);
assert.ok(!result.includes('<agent>') && !result.includes('<status>') && !result.includes('<project>'));
assert.equal((result.match(/class="crown"/g) || []).length, 1);
ctx.latestAsk = () => ({q:{state:'queued', text:'<question>'}, t:{id:'t2'}, ws:'C:\\A&B'});
const asked = ctx.roomHtml({leader:'0',workers:[],name:'A'});
assert.match(asked, /class="ask-bubble wait"/);
assert.match(asked, /data-detail="t2"/);
assert.ok(asked.includes('&lt;question&gt;'));
assert.match(html, /prefers-reduced-motion: reduce/);
assert.match(html, /\.scene \*, \.scene \*::before, \.scene \*::after \{ animation:none !important/);
console.log('Office scene markup regressions: PASS');
