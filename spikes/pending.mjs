// Operator helper: list undecided pending approvals with the running tool call args (from REST messages).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
const P = join(ROOT, 'runtime', 'approvals', 'pending'), D = join(ROOT, 'runtime', 'approvals', 'decide');
for (const f of readdirSync(P)) {
  if (existsSync(join(D, f))) continue;
  const cf = JSON.parse(readFileSync(join(P, f), 'utf8'));
  let running = [];
  if (cf.base && cf.convId) {
    try { const j = await (await fetch(`${cf.base}/api/conversations/${cf.convId}/messages`)).json();
      running = (j.data.items ?? j.data).filter((m) => m.type === 'tool_call' && m.content?.status !== 'completed').map((m) => JSON.stringify(m.content.args ?? m.content.input ?? m.content).slice(0, 500)); } catch (e) { running = ['ERR ' + e]; }
  }
  console.log(JSON.stringify({ file: f, title: cf.title, description: cf.description, running }));
}
