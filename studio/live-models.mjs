// AionCore v0.2.2: runtime/ensure returns the config snapshot; the legacy GET
// config-options route was removed. Never restart a conversation or cancel a turn.
export function updateModelCatalog(agent, options = []) {
  if (!agent) return;
  for (const o of options) {
    const values = (o.options || []).filter((x) => typeof x.value === 'string').map((x) => ({ value: x.value, name: x.name || x.value, description: x.description || '' }));
    if (o.category === 'model' && values.length) agent.models = values;
    if (o.category === 'thought_level' && values.length) agent.efforts = values.map((x) => x.value);
  }
}
export async function applyTurnModel(api, cid, cfg, agent, allowed = () => true) {
  if (!cfg.model && !cfg.effort) return;
  if (!allowed()) throw new Error('切換模型期間工作已停止或變更');
  const url = `/api/conversations/${encodeURIComponent(cid)}/config-options`;
  let options = (await api('POST', `/api/conversations/${encodeURIComponent(cid)}/runtime/ensure`, {})).config_options || [];
  updateModelCatalog(agent, options);
  for (const [category, value] of [['model', cfg.model], ['thought_level', cfg.effort]]) {
    if (!value) continue; // Blank deliberately means keep the existing conversation's setting.
    if (!allowed()) throw new Error('切換模型期間工作已停止或變更');
    const option = options.find((o) => o.category === category);
    if (!option || !(option.options || []).some((x) => x.value === value)) throw new Error(`目前對話不支援 ${category}：${value}`);
    if (option.current_value === value) continue;
    const result = await api('PUT', `${url}/${encodeURIComponent(option.id)}`, { value });
    if (!['observed', 'pending_next_turn'].includes(result.confirmation)) throw new Error(`模型設定尚未確認：${value}（未送出下一步）`);
    if (result.config_options) options = result.config_options;
    updateModelCatalog(agent, options);
  }
}
