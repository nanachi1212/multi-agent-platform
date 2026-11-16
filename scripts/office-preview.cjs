// Generate a static preview from the actual office CSS + roomHtml, with synthetic agent data.
// No Studio server, provider connection, credentials, or model calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../studio/index.html'), 'utf8');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
const ctx = {
  S: {agents: ['Claude Code', 'Codex', 'Antigravity'].map((name, id) => ({id:String(id), name})), workspaces:[]}, esc,
  look: id => ({c:['#dc7858','#009c82','#508be4'][id]}), latestAsk: () => null,
  roomState: a => ({kind:a.id === '2' ? 'wait' : 'work', text:['監督進度中','修正工作中的模型切換','排隊中 2 張'][a.id]})
};
vm.createContext(ctx);
vm.runInContext(source.match(/function roomHtml\(w\) \{[\s\S]*?\n\}/)[0], ctx);
const scene = ctx.roomHtml({leader:'0', workers:['1','2'], name:'CodexProject'});
const css = source.match(/<style>([\s\S]*?)<\/style>/)[1];
const output = path.resolve(process.argv[2] || 'outputs/office-preview.html');
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 辦公室實作預覽</title><style>${css}
body{margin:0}main{padding:18px;width:min(100%,390px)}.scene{margin-top:12px}.scene *,.scene *::before,.scene *::after{animation:none!important}</style><main><div class="room-h">AI 辦公室 <span class="sub">2 位工作中</span></div><div class="scene">${scene}</div></main></html>`);
console.log(output);
