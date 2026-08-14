import { useMemo, useState } from 'react';
import type { AutomationHistoryView, AutomationView, ConsoleData } from '../../types';
import { CommandBar } from '../../shell/CommandBar';
import { Segmented } from '../../components/Segmented';
import { DetailPane, DefinitionList } from '../../components/DetailPane';
import { StatusText } from '../../components/StatusText';
import { Button } from '../../components/Button';
import { formatDate, compact } from '../../lib/format';

type Filter = 'enabled' | 'paused' | 'attention' | 'all';

function statusLabel(status: AutomationView['status']): string {
  if (status === 'enabled') return '运行中';
  if (status === 'paused') return '已暂停';
  if (status === 'attention') return '需要处理';
  return '已停用';
}

function statusTone(status: AutomationView['status']): string {
  if (status === 'enabled') return 'success';
  if (status === 'attention') return 'danger';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function observationLabel(value?: AutomationView['observationStatus']): string | undefined {
  if (value === 'baseline') return '已建立基线';
  if (value === 'unchanged') return '无变化';
  if (value === 'changed') return '检测到变化';
  if (value === 'keepalive') return '登录保持正常';
  if (value === 'auth_required') return '需要重新登录';
  return undefined;
}

function reasoningLabel(value?: string): string {
  if (value === 'high') return '高';
  if (value === 'medium') return '中';
  if (value === 'xhigh') return '超高';
  return value ?? '—';
}

function tabPolicyLabel(value?: string): string {
  if (value === 'auto') return '自动 · 同一 Work 优先复用';
  if (value === 'reuse') return '始终复用已绑定会话';
  if (value === 'new') return '每次新开标签页';
  return value ?? '—';
}

function executionDetails(automation: AutomationView): Array<[string, string]> {
  if (!automation.agentModel) return [];
  return [
    ['执行模型', `${automation.agentModel} · ${reasoningLabel(automation.reasoningLevel)}推理`],
    ['浏览器会话', tabPolicyLabel(automation.tabPolicy)],
  ];
}

function historyTone(tone: AutomationHistoryView['tone']): string {
  if (tone === 'green') return 'success';
  if (tone === 'amber') return 'warning';
  if (tone === 'red') return 'danger';
  if (tone === 'blue') return 'info';
  return 'neutral';
}

function History({ items }: { items: AutomationHistoryView[] }) {
  if (!items.length) return <div className="automation-history-empty">还没有执行记录。</div>;
  return <div className="automation-history">{items.map((item) => <div className="automation-history-row" key={item.id}>
    <div className={`automation-history-mark ${item.tone}`} />
    <div className="automation-history-copy">
      <div className="automation-history-top"><StatusText label={item.result} tone={historyTone(item.tone)} /><time>{formatDate(item.at)}</time></div>
      {item.reason && <p>{item.reason}</p>}
      {item.trigger && <small>{item.trigger}触发</small>}
    </div>
  </div>)}</div>;
}

export function AutomationsView({ data, busy, onRefresh, onAction }: {
  data: ConsoleData;
  busy: boolean;
  onRefresh: () => void;
  onAction: (automation: AutomationView, action: 'run' | 'pause' | 'resume') => Promise<void>;
}) {
  const all = data.automations.automations;
  const [filter, setFilter] = useState<Filter>('enabled');
  const list = useMemo(() => all.filter((automation) => filter === 'all'
    || (filter === 'paused' ? automation.status === 'paused' || automation.status === 'disabled' : automation.status === filter)), [all, filter]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const key = (automation: AutomationView) => `${automation.source}:${automation.repoId}:${automation.id}`;
  const selected = list.find((automation) => key(automation) === selectedKey) ?? list[0];
  const observation = selected ? observationLabel(selected.observationStatus) : undefined;

  return <>
    <CommandBar eyebrow="AUTOMATION" title="Automations" description="查看长期任务如何触发、当前是否正常，以及每一次实际执行发生了什么。" refreshedAt={data.automations.generatedAt} busy={busy} onRefresh={onRefresh} />
    <div className="toolbar automation-toolbar">
      <Segmented value={filter} onChange={setFilter} items={[
        { id: 'enabled', label: '运行中', count: all.filter((item) => item.status === 'enabled').length },
        { id: 'paused', label: '已暂停', count: all.filter((item) => item.status === 'paused' || item.status === 'disabled').length },
        { id: 'attention', label: '需要处理', count: all.filter((item) => item.status === 'attention').length },
        { id: 'all', label: '全部', count: all.length },
      ]} />
    </div>
    <div className="split-workspace automation-layout">
      <div className="table-wrap">
        <table className="data-table automation-table">
          <thead><tr><th>Automation</th><th>触发</th><th>行为</th><th>状态</th><th>最近结果</th></tr></thead>
          <tbody>{list.map((automation) => <tr key={key(automation)} className={selected && key(selected) === key(automation) ? 'selected' : ''} onClick={() => setSelectedKey(key(automation))}>
            <td><strong>{automation.name}</strong><small>{automation.repositoryName} · {automation.modeLabel}</small></td>
            <td><span>{automation.schedule}</span><small>{automation.timezone ?? '本地时区'}</small></td>
            <td><span>{automation.delivery ?? '本地执行'}</span>{automation.targetLabel && <small>{automation.targetLabel}</small>}</td>
            <td><StatusText label={statusLabel(automation.status)} tone={statusTone(automation.status)} />{automation.live !== undefined && <small>{automation.live ? 'Live' : 'Shadow'}</small>}</td>
            <td><span>{compact(automation.lastResult, 26) || '—'}</span><small>{formatDate(automation.lastRunAt)}</small></td>
          </tr>)}</tbody>
        </table>
        {!list.length && <div className="quiet-empty">这个筛选条件下没有 Automation。</div>}
      </div>
      <DetailPane title={selected?.name} subtitle={selected?.summary} empty="选择一个 Automation 查看配置与执行历史">
        {selected && <>
          <div className="automation-detail-status">
            <div><span className="eyebrow">CURRENT STATE</span><StatusText label={statusLabel(selected.status)} tone={statusTone(selected.status)} /></div>
            <div className="automation-result"><strong>{selected.lastResult ?? '尚未执行'}</strong><small>{formatDate(selected.observationAt ?? selected.lastRunAt)}</small></div>
          </div>
          <DefinitionList items={[
            ['类型', selected.modeLabel],
            ['触发计划', `${selected.schedule}${selected.timezone ? ` · ${selected.timezone}` : ''}`],
            ['触发后的行为', selected.delivery ?? '本地执行'],
            ['观察目标', selected.targetLabel ?? '—'],
            ['观察状态', observation ?? '—'],
            ['绑定 Work', selected.boundWorkObjective ? compact(selected.boundWorkObjective, 96) : selected.boundWorkId ?? '—'],
            ['运行模式', selected.live === undefined ? '—' : selected.live ? 'Live · 会产生实际动作' : 'Shadow · 只记录预演'],
            ...executionDetails(selected),
            ['运行策略', selected.policySummary ?? '—'],
          ]} />
          {selected.pausedReason && <div className="detail-callout warning"><strong>暂停原因</strong><p>{selected.pausedReason}</p></div>}
          <div className="detail-button-row">{selected.actions.map((action) => <Button key={action} disabled={busy} className={action === 'pause' ? 'danger-text' : ''} onClick={() => void onAction(selected, action)}>{action === 'run' ? '立即运行' : action === 'pause' ? '暂停任务' : '开启任务'}</Button>)}</div>
          <div className="automation-section-head"><div><span className="eyebrow">EXECUTION HISTORY</span><h3>最近执行</h3></div><span>{selected.history.length} 条</span></div>
          <History items={selected.history} />
          <details className="advanced automation-advanced"><summary>技术信息</summary><pre>{JSON.stringify({ scheduleId: selected.source === 'schedule' ? selected.id : undefined, workId: selected.boundWorkId, source: selected.source, next: selected.nextRunHint, failureCount: selected.failureCount }, null, 2)}</pre></details>
          <p className="detail-note">这里只展示配置、状态与执行摘要；邮件正文、浏览器 Cookie、登录凭据和 continuation prompt 不会复制到控制台。</p>
        </>}
      </DetailPane>
    </div>
  </>;
}
