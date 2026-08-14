import type { ConsoleData, Dict, WorkPortfolioItem } from '../../types';
import { CommandBar } from '../../shell/CommandBar';
import { StatusText } from '../../components/StatusText';
import { SectionHeader } from '../../components/SectionHeader';
import { compact, formatDate } from '../../lib/format';

type RepositoryActivity = {
  repoId: string;
  repositoryName: string;
  activeCount: number;
  attentionCount: number;
  updatedAt: string;
  items: WorkPortfolioItem[];
};

type AttentionItem = {
  key: string;
  repositoryName?: string;
  title: string;
  summary: string;
  statusLabel: string;
  tone: string;
  href: string;
};

function workStatus(item: WorkPortfolioItem): string {
  return item.advanced?.status ?? '';
}

function isOpenWork(item: WorkPortfolioItem): boolean {
  return ['open', 'running', 'ready'].includes(workStatus(item));
}

function isAttentionWork(item: WorkPortfolioItem): boolean {
  return ['blocked', 'failed'].includes(workStatus(item));
}

function attentionKey(item: Dict): string {
  return `${String(item.title ?? '')}:${String(item.reason ?? '')}`;
}

function repositoryActivity(data: ConsoleData): RepositoryActivity[] {
  const groups = new Map<string, RepositoryActivity>();
  const repositoryNames = new Map(data.workPortfolio.repositories.map((repo) => [repo.repoId, repo.repositoryName]));

  for (const item of data.workPortfolio.items) {
    if (!isOpenWork(item) && !isAttentionWork(item)) continue;
    const existing = groups.get(item.repoId) ?? {
      repoId: item.repoId,
      repositoryName: item.repositoryName || repositoryNames.get(item.repoId) || item.repoId,
      activeCount: 0,
      attentionCount: 0,
      updatedAt: item.updatedAt,
      items: [],
    };
    existing.activeCount += 1;
    if (isAttentionWork(item)) existing.attentionCount += 1;
    if (item.updatedAt > existing.updatedAt) existing.updatedAt = item.updatedAt;
    existing.items.push(item);
    groups.set(item.repoId, existing);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((left, right) => {
        const attentionDelta = Number(isAttentionWork(right)) - Number(isAttentionWork(left));
        return attentionDelta || right.updatedAt.localeCompare(left.updatedAt);
      }),
    }))
    .sort((left, right) => {
      const attentionDelta = right.attentionCount - left.attentionCount;
      const activeDelta = right.activeCount - left.activeCount;
      return attentionDelta || activeDelta || right.updatedAt.localeCompare(left.updatedAt);
    });
}

export function OverviewView({ data, busy, onRefresh }: { data: ConsoleData; busy: boolean; onRefresh: () => void }) {
  const cc = data.commandCenter;
  const automations = data.automations.summary;
  const plugins = cc.pluginSummary ?? {};
  const repositories = cc.repositories ?? [];
  const readiness = cc.readiness ?? {};
  const activity = repositoryActivity(data);
  const visibleActivity = activity.slice(0, 8);
  const attentionWork = data.workPortfolio.items.filter(isAttentionWork).slice(0, 4);
  const uniqueHandoffs = [...(cc.handoffs ?? [])].filter((handoff, index, all) => all.findIndex((candidate) => attentionKey(candidate) === attentionKey(handoff)) === index);

  const attention: AttentionItem[] = [
    ...attentionWork.map((item) => ({
      key: `work:${item.id}`,
      repositoryName: item.repositoryName,
      title: item.title,
      summary: compact(item.latestSummary || item.nextAction, 108),
      statusLabel: item.statusLabel,
      tone: item.tone ?? 'warning',
      href: '#/work',
    })),
    ...uniqueHandoffs.slice(0, 2).map((handoff, index) => ({
      key: `handoff:${index}:${attentionKey(handoff)}`,
      title: String(handoff.title ?? 'Needs review'),
      summary: compact(String(handoff.reason ?? handoff.summary ?? 'Review in ChatGPT'), 108),
      statusLabel: String(handoff.statusLabel ?? 'Review'),
      tone: String(handoff.tone ?? 'warning'),
      href: '#/work',
    })),
    ...((plugins.needsAttention ?? 0) > 0 ? [{
      key: 'capabilities',
      title: 'Capabilities need attention',
      summary: `${plugins.needsAttention} configured capabilities need inspection`,
      statusLabel: 'Inspect',
      tone: 'warning',
      href: '#/capabilities',
    }] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index).slice(0, 5);

  const readinessState = String(readiness.state ?? readiness.status ?? 'ready');
  const runtimeNeedsAttention = /error|failed|blocked|unavailable|degraded|warning|attention/i.test(readinessState);
  const runtimeLabel = String(readiness.label ?? readiness.headline ?? (runtimeNeedsAttention ? 'Runtime needs attention' : 'Ready'));
  const capabilityTotal = plugins.total ?? (cc.plugins ?? []).length;

  return <>
    <CommandBar
      eyebrow="FORGE CONTROL PLANE"
      title="Overview"
      description="仓库活动、待处理事项和 Forge 可用性概览。"
      refreshedAt={data.generatedAt}
      busy={busy}
      onRefresh={onRefresh}
    />

    {runtimeNeedsAttention && <a className="overview-runtime-alert" href="#/system">
      <StatusText label={runtimeLabel} tone={readinessState} />
      <span>{compact(String(readiness.explanation ?? readiness.summary ?? 'Inspect Runtime diagnostics.'), 150)}</span>
      <strong>Inspect →</strong>
    </a>}

    <div className="overview-v2-grid">
      <main className="overview-v2-main">
        <section className="page-section overview-activity-section">
          <SectionHeader title="Repository activity" meta={`${repositories.length} repositories`} />
          {visibleActivity.length ? <div className="overview-activity-list">
            {visibleActivity.map((repo) => <a className="repo-activity-row" href="#/work" key={repo.repoId}>
              <div className="repo-activity-copy">
                <div className="repo-activity-title">
                  <strong>{repo.repositoryName}</strong>
                  <span>{repo.activeCount} active</span>
                  {repo.attentionCount > 0 && <span className="repo-attention-count">{repo.attentionCount} attention</span>}
                </div>
                <div className="repo-work-lines">
                  {repo.items.slice(0, 2).map((item) => <div className="repo-work-line" key={item.id}>
                    <span>{compact(item.title, 88)}</span>
                    {isAttentionWork(item) && <StatusText label={item.statusLabel} tone={item.tone ?? 'warning'} />}
                  </div>)}
                </div>
              </div>
              <div className="repo-activity-meta">{formatDate(repo.updatedAt)}</div>
            </a>)}
          </div> : <div className="overview-empty-line">No active repository work.</div>}
          {activity.length > visibleActivity.length && <a className="overview-more-link" href="#/work">View all work →</a>}
        </section>
      </main>

      <aside className="overview-context-rail">
        <section className="overview-context-section">
          <SectionHeader title="Needs attention" meta={attention.length ? String(attention.length) : 'All clear'} />
          {attention.length ? <div className="overview-attention-list">
            {attention.map((item) => <a className="overview-attention-row" href={item.href} key={item.key}>
              <div className="overview-attention-copy">
                {item.repositoryName && <span>{item.repositoryName}</span>}
                <strong>{compact(item.title, 72)}</strong>
                <p>{item.summary}</p>
              </div>
              <StatusText label={item.statusLabel} tone={item.tone} />
            </a>)}
          </div> : <div className="overview-empty-line">No action needed.</div>}
        </section>

        <section className="overview-context-section overview-system-section">
          <SectionHeader title="System" meta="Coarse state" />
          <div className="overview-system-list">
            <a className="overview-system-row" href="#/system"><span>Runtime</span><StatusText label={runtimeLabel} tone={readinessState} /></a>
            <a className="overview-system-row" href="#/automations"><span>Automations</span><strong>{automations.enabled} enabled{automations.paused ? ` · ${automations.paused} paused` : ''}</strong></a>
            <a className="overview-system-row" href="#/capabilities"><span>Capabilities</span><strong>{plugins.ready ?? 0} / {capabilityTotal} ready</strong></a>
            <a className="overview-system-row" href="#/repositories"><span>Repositories</span><strong>{repositories.length}</strong></a>
          </div>
        </section>
      </aside>
    </div>
  </>;
}
