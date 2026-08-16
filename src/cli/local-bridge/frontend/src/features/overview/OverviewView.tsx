import type { ConsoleData, Dict, WorkPortfolioItem } from '../../types';
import { CommandBar } from '../../shell/CommandBar';
import { StatusText } from '../../components/StatusText';
import { SectionHeader } from '../../components/SectionHeader';
import { compact } from '../../lib/format';

type AttentionItem = {
  key: string;
  source: string;
  title: string;
  summary: string;
  statusLabel: string;
  tone: string;
  href: string;
};

type WorkspaceRow = {
  key: string;
  label: string;
  summary: string;
  href: string;
  statusLabel?: string;
  tone?: string;
};

function workStatus(item: WorkPortfolioItem): string {
  return item.advanced?.status ?? '';
}

function isAttentionWork(item: WorkPortfolioItem): boolean {
  return ['blocked', 'failed'].includes(workStatus(item));
}

function attentionKey(item: Dict): string {
  return `${String(item.title ?? '')}:${String(item.reason ?? '')}`;
}

function repositoryNeedsAttention(repository: NonNullable<ConsoleData['commandCenter']['repositories']>[number]): boolean {
  const state = `${repository.readinessLabel ?? ''} ${repository.statusLabel ?? ''}`;
  return /error|failed|blocked|unavailable|degraded|warning|attention/i.test(state);
}

export function OverviewView({ data, busy, onRefresh }: { data: ConsoleData; busy: boolean; onRefresh: () => void }) {
  const cc = data.commandCenter;
  const portfolio = data.workPortfolio;
  const automations = data.automations.summary;
  const plugins = cc.pluginSummary ?? {};
  const repositories = cc.repositories ?? [];
  const readiness = cc.readiness ?? {};
  const capabilityTotal = plugins.total ?? (cc.plugins ?? []).length;
  const repositoryAttention = repositories.filter(repositoryNeedsAttention).length;
  const readinessState = String(readiness.state ?? readiness.status ?? 'ready');
  const runtimeNeedsAttention = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(readinessState);
  const runtimeLabel = String(readiness.label ?? readiness.headline ?? (runtimeNeedsAttention ? 'Needs attention' : 'Ready'));

  const attentionWork = portfolio.items.filter(isAttentionWork).slice(0, 4);
  const uniqueHandoffs = [...(cc.handoffs ?? [])].filter((handoff, index, all) => all.findIndex((candidate) => attentionKey(candidate) === attentionKey(handoff)) === index);

  const attention: AttentionItem[] = [
    ...(runtimeNeedsAttention ? [{
      key: 'runtime',
      source: 'System',
      title: runtimeLabel,
      summary: compact(String(readiness.explanation ?? readiness.summary ?? 'Inspect Runtime status.'), 112),
      statusLabel: 'Inspect',
      tone: readinessState,
      href: '#/system',
    }] : []),
    ...attentionWork.map((item) => ({
      key: `work:${item.id}`,
      source: `Work · ${item.repositoryName}`,
      title: item.title,
      summary: compact(item.latestSummary || item.nextAction || item.objective, 112),
      statusLabel: item.statusLabel,
      tone: item.tone ?? 'warning',
      href: '#/work',
    })),
    ...uniqueHandoffs.slice(0, 2).map((handoff, index) => ({
      key: `handoff:${index}:${attentionKey(handoff)}`,
      source: 'Decision',
      title: String(handoff.title ?? 'Needs review'),
      summary: compact(String(handoff.reason ?? handoff.summary ?? 'Review in ChatGPT.'), 112),
      statusLabel: String(handoff.statusLabel ?? 'Review'),
      tone: String(handoff.tone ?? 'warning'),
      href: '#/work',
    })),
    ...((automations.needsAttention ?? 0) > 0 ? [{
      key: 'automations',
      source: 'Automations',
      title: `${automations.needsAttention} automation${automations.needsAttention === 1 ? '' : 's'} need attention`,
      summary: 'Inspect configured routines and schedules.',
      statusLabel: 'Inspect',
      tone: 'warning',
      href: '#/automations',
    }] : []),
    ...((plugins.needsAttention ?? 0) > 0 ? [{
      key: 'capabilities',
      source: 'Capabilities',
      title: `${plugins.needsAttention} ${plugins.needsAttention === 1 ? 'capability' : 'capabilities'} need attention`,
      summary: 'Inspect configured capability readiness.',
      statusLabel: 'Inspect',
      tone: 'warning',
      href: '#/capabilities',
    }] : []),
    ...(repositoryAttention > 0 ? [{
      key: 'repositories',
      source: 'Repositories',
      title: `${repositoryAttention} ${repositoryAttention === 1 ? 'repository' : 'repositories'} need attention`,
      summary: 'Inspect repository registration and readiness.',
      statusLabel: 'Inspect',
      tone: 'warning',
      href: '#/repositories',
    }] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index).slice(0, 6);

  const workSummary = portfolio.summary.needsAttention
    ? `${portfolio.summary.open} open · ${portfolio.summary.needsAttention} need attention`
    : `${portfolio.summary.open} open · no attention needed`;
  const automationSummary = automations.needsAttention
    ? `${automations.enabled} 个运行中 · ${automations.needsAttention} 个需要处理`
    : automations.paused
      ? `${automations.enabled} 个运行中 · ${automations.paused} 个已暂停`
      : (automations.completed ?? 0) > 0
        ? `${automations.enabled} 个运行中 · ${automations.completed} 个已完成`
        : `${automations.enabled} 个运行中 · 状态正常`;
  const capabilitySummary = (plugins.needsAttention ?? 0) > 0
    ? `${plugins.ready ?? 0} / ${capabilityTotal} ready · ${plugins.needsAttention} need attention`
    : `${plugins.ready ?? 0} / ${capabilityTotal} ready`;
  const repositorySummary = repositoryAttention
    ? `${repositories.length} registered · ${repositoryAttention} need attention`
    : `${repositories.length} registered`;

  const workspaces: WorkspaceRow[] = [
    { key: 'work', label: 'Work', summary: workSummary, href: '#/work', statusLabel: portfolio.summary.needsAttention ? 'Attention' : undefined, tone: portfolio.summary.needsAttention ? 'warning' : undefined },
    { key: 'automations', label: 'Automations', summary: automationSummary, href: '#/automations', statusLabel: automations.needsAttention ? 'Attention' : undefined, tone: automations.needsAttention ? 'warning' : undefined },
    { key: 'capabilities', label: 'Capabilities', summary: capabilitySummary, href: '#/capabilities', statusLabel: (plugins.needsAttention ?? 0) > 0 ? 'Attention' : undefined, tone: (plugins.needsAttention ?? 0) > 0 ? 'warning' : undefined },
    { key: 'repositories', label: 'Repositories', summary: repositorySummary, href: '#/repositories', statusLabel: repositoryAttention ? 'Attention' : undefined, tone: repositoryAttention ? 'warning' : undefined },
    { key: 'system', label: 'System', summary: runtimeNeedsAttention ? runtimeLabel : 'Runtime ready', href: '#/system', statusLabel: runtimeNeedsAttention ? 'Attention' : 'Ready', tone: runtimeNeedsAttention ? readinessState : 'success' },
  ];

  return <>
    <CommandBar
      eyebrow="FORGE CONTROL PLANE"
      title="Overview"
      description="需要处理的事项，以及 Forge 各工作区当前状态。"
      refreshedAt={data.generatedAt}
      busy={busy}
      onRefresh={onRefresh}
    />

    <div className="overview-home">
      <section className="page-section overview-attention-section">
        <SectionHeader title="Needs attention" meta={attention.length ? `${attention.length} items` : 'All clear'} />
        {attention.length ? <div className="overview-attention-list">
          {attention.map((item) => <a className="overview-attention-row" href={item.href} key={item.key}>
            <div className="overview-attention-source">{item.source}</div>
            <div className="overview-attention-copy">
              <strong>{compact(item.title, 82)}</strong>
              <p>{item.summary}</p>
            </div>
            <StatusText label={item.statusLabel} tone={item.tone} />
            <span className="overview-row-arrow" aria-hidden="true">→</span>
          </a>)}
        </div> : <div className="overview-clear-state">
          <StatusText label="No action needed" tone="success" />
          <span>Forge is operating normally.</span>
        </div>}
      </section>

      <section className="page-section overview-workspace-section">
        <SectionHeader title="Workspace" meta="Current state" />
        <div className="overview-workspace-list">
          {workspaces.map((workspace) => <a className="overview-workspace-row" href={workspace.href} key={workspace.key}>
            <strong>{workspace.label}</strong>
            <span>{workspace.summary}</span>
            {workspace.statusLabel && <StatusText label={workspace.statusLabel} tone={workspace.tone} />}
            <span className="overview-row-arrow" aria-hidden="true">→</span>
          </a>)}
        </div>
      </section>
    </div>
  </>;
}
