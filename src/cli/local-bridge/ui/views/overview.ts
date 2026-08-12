import { empty, esc, header, status } from '../components';
import type { ConsoleData } from '../types';
export function renderOverview(data: ConsoleData): string {
 const cc=data.commandCenter, ready=cc.readiness??{}, auto=data.automations.summary, work=data.work, plugins=cc.pluginSummary??{}, repos=cc.repositories??[], attention=(cc.handoffs??[]).length+(plugins.needsAttention??0)+auto.needsAttention+(work.waitingForUserCount??0)+(work.needsAttentionCount??0);
 const readyLabel=String(ready.label??ready.headline??'状态未知');
 return header('Overview','Forge 的长期配置和可用性概览。具体工作、结果与通知继续由 ChatGPT 承担。','<a class="btn primary" href="https://chatgpt.com" target="_blank" rel="noreferrer">Open ChatGPT ↗</a>')+
  ((cc.warnings??[]).map(w=>`<div class="notice warning"><strong>Needs attention</strong><span>${esc(w)}</span></div>`).join(''))+
  `<section class="section"><div class="surface">
   <div class="summary-row"><div><strong>System</strong><div class="meta">Controller 与连接状态</div></div>${status(readyLabel,ready.state)}</div>
   <div class="summary-row"><div><strong>Work</strong><div class="meta">持久化的长期目标</div></div><div class="right"><span>${work.activeRequirementCount??0} active · ${work.waitingForUserCount??0} waiting</span><a class="btn" href="#/work">Open</a></div></div>
   <div class="summary-row"><div><strong>Automations</strong><div class="meta">已配置的长期自动工作</div></div><div class="right"><span>${auto.enabled} enabled · ${auto.paused} paused</span><a class="btn" href="#/automations">Manage</a></div></div>
   <div class="summary-row"><div><strong>Capabilities</strong><div class="meta">插件、服务、模型与本地工具</div></div><div class="right"><span>${plugins.ready??0}/${plugins.total??(cc.plugins??[]).length} ready</span><a class="btn" href="#/capabilities">Inspect</a></div></div>
   <div class="summary-row"><div><strong>Repositories</strong><div class="meta">Controller Registry</div></div><div class="right"><span>${repos.length} registered</span><a class="btn" href="#/repositories">Open</a></div></div>
  </div></section>`+
  `<section class="section"><div class="section-title"><h2>Needs attention</h2><span class="meta">${attention}</span></div><div class="surface">${attention?`${(cc.handoffs??[]).slice(0,4).map(h=>`<div class="resource-row"><div><h3>${esc(h.title??'需要处理')}</h3><div class="meta">${esc(h.reason??'需要在 ChatGPT 中确认')}</div></div>${status(String(h.statusLabel??'Waiting'),h.tone)}</div>`).join('')}${(work.waitingForUserCount??0)+(work.needsAttentionCount??0)>0?`<div class="resource-row"><div><h3>Work</h3><div class="meta">${(work.waitingForUserCount??0)+(work.needsAttentionCount??0)} 项长期工作需要关注</div></div><a class="btn" href="#/work">查看</a></div>`:''}${(plugins.needsAttention??0)?`<div class="resource-row"><div><h3>Capabilities</h3><div class="meta">${plugins.needsAttention} 项能力需要配置或检查</div></div><a class="btn" href="#/capabilities">查看</a></div>`:''}`:empty('Nothing needs attention','Forge 当前没有需要你在控制台处理的配置问题。')}</div></section>`;
}
