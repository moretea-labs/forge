import { empty, esc, fmtDate, header, status } from '../components';
import type { ConsoleData, TrackedWorkView } from '../types';

const stateLabel: Record<TrackedWorkView['state'], string> = { planned:'Planned', active:'Active', waiting_for_user:'Waiting', done:'Completed', cancelled:'Cancelled' };
function row(item: TrackedWorkView): string {
  const detail=item.requiredUserDecision??item.blocker??item.outcome??'Durable tracked objective';
  return `<div class="resource-row"><div><h3>${esc(item.title)}</h3><div class="meta">${esc(detail)}</div><div class="meta">Updated ${fmtDate(item.updatedAt)}</div></div>${status(stateLabel[item.state]??item.state,item.needsAttention?'attention':item.state)}</div>`;
}
export function renderWork(data: ConsoleData): string {
  const all=data.work.requirements??[];
  const active=all.filter(item=>item.state!=='done'&&item.state!=='cancelled');
  const completed=all.filter(item=>item.state==='done'||item.state==='cancelled');
  return header('Work','全局查看真正持久化的目标。这里只显示可证明的分类状态，不展示 Agent 步骤、Run 流水或推测进度。')+
    `<section class="section"><div class="section-title"><h2>Active</h2><span class="meta">${data.work.activeRequirementCount??active.length} tracked · ${data.work.waitingForUserCount??0} waiting</span></div><div class="surface">${active.length?active.map(row).join(''):empty('No active tracked work','临时 Direct 工作不会被强制持久化；长期目标才会出现在这里。')}</div></section>`+
    (completed.length?`<section class="section"><div class="section-title"><h2>Recent completed</h2></div><div class="surface">${completed.slice(0,6).map(row).join('')}</div></section>`:'');
}
