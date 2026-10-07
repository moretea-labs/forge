import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  designPreviewProjection,
  disconnectedProjection,
  type AutomaticContinuationTaskProjection,
  type ControllerConnectionProjection,
  type ForgeDesktopProjection,
  type ProjectListItemProjection,
  type RuntimeRecoveryProjection,
  type WorkGraphNodeProjection,
  type WorkSemanticState,
} from './runtime-projection';
import {
  continueWork,
  readAutomaticContinuations,
  readConnectionStatus,
  readLocalProviderStatus,
  readProjects,
  readProjectWorkspace,
  repairConnection,
  sendLocalConversation,
  switchAutomaticContinuationConversation,
  tauriRuntimeAvailable,
  type LocalProviderStatusProjection,
} from './runtime-client';
import { LocalConversationSurface, type LocalConversationReply, type LocalConversationThread } from './local-conversation';
import {
  performRecoveryAction,
  readRecoveryStatus,
  unavailableRecoveryProjection,
  verifyRecoveryRuntime,
} from './recovery-client';

type AppView = 'assistant' | 'project' | 'runtime';

function previewEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('preview') === '1';
}

function compactId(value: string): string {
  if (value.length <= 30) return value;
  return `${value.slice(0, 17)}…${value.slice(-8)}`;
}

function formatTimestamp(value?: string): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function semanticStateLabel(state: WorkSemanticState): string {
  if (state === 'completed') return '已完成';
  if (state === 'cancelled') return '已取消';
  return '进行中';
}

function verificationOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    valid_pass: '通过',
    valid_fail: '未通过',
    invalid_check_id: '检查无效',
    infrastructure_failure: '基础设施异常',
    skipped: '已跳过',
    superseded: '已被替代',
  };
  return labels[outcome] ?? outcome;
}

function executionPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    implementation: '实现',
    verification: '验证',
    review: '审查',
    delivery: '交付',
    cleanup: '清理',
  };
  return labels[phase] ?? phase;
}

function phaseEvidenceStateLabel(state: string): string {
  const labels: Record<string, string> = {
    active: '进行中',
    pending: '待处理',
    completed: '已完成',
    passed: '已通过',
    failed: '失败',
    blocked: '阻塞',
    skipped: '已跳过',
  };
  return labels[state] ?? state;
}

function statusTone(status: AutomaticContinuationTaskProjection['status']): string {
  if (status === 'needs_user') return 'attention';
  if (status === 'completed' || status === 'stopped') return 'quiet';
  if (status === 'switching_conversation') return 'switching';
  return 'live';
}

function Sidebar({
  projects,
  workNodes,
  recentWorkNodes,
  selectedRepoId,
  selectedWorkId,
  activeView,
  runtimeLabel,
  runtimeStatus,
  onOpenAssistant,
  onOpenMcp,
  onSelectProject,
  onSelectWork,
  onOpenRuntime,
}: {
  projects: ProjectListItemProjection[];
  workNodes: WorkGraphNodeProjection[];
  recentWorkNodes: WorkGraphNodeProjection[];
  selectedRepoId?: string;
  selectedWorkId?: string;
  activeView: AppView;
  runtimeLabel: string;
  runtimeStatus: string;
  onOpenAssistant: () => void;
  onOpenMcp: () => void;
  onSelectProject?: (project: ProjectListItemProjection) => void;
  onSelectWork?: (workId: string) => void;
  onOpenRuntime?: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-main">
        <div className="mode-switch" role="group" aria-label="Forge 工作模式">
          <button className={activeView === 'assistant' ? 'active' : ''} type="button" onClick={onOpenAssistant}>Local</button>
          <button className={activeView !== 'assistant' ? 'active' : ''} type="button" onClick={onOpenMcp}>MCP</button>
        </div>

        <button className={activeView === 'assistant' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenAssistant}>
          <span className="nav-symbol">✦</span>
          <span>助手</span>
        </button>

        <div className="sidebar-section-title">项目</div>
        <div className="sidebar-list">
          {projects.map((project) => (
            <button
              key={project.repoId}
              className={activeView === 'project' && project.repoId === selectedRepoId ? 'nav-row active' : 'nav-row'}
              type="button"
              title={project.repository}
              onClick={() => onSelectProject?.(project)}
            >
              <span className="project-dot" aria-hidden="true" />
              <span className="nav-label">{project.name}</span>
            </button>
          ))}
        </div>

        {activeView === 'project' && (workNodes.length > 0 || recentWorkNodes.length > 0) && (
          <>
            {workNodes.length > 0 && (
              <>
                <div className="sidebar-section-title work-section-title">工作</div>
                <div className="sidebar-list work-list">
                  {workNodes.map((work) => (
                    <button
                      key={work.workId}
                      className={work.workId === selectedWorkId ? 'work-row active' : 'work-row'}
                      type="button"
                      onClick={() => onSelectWork?.(work.workId)}
                      title={work.objective}
                    >
                      <span className={`work-state-dot ${work.state}`} aria-hidden="true" />
                      <span className="work-row-copy">
                        <strong>{work.objective}</strong>
                        <span>{semanticStateLabel(work.state)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {recentWorkNodes.length > 0 && (
              <details className="sidebar-history">
                <summary>历史 · {recentWorkNodes.length}</summary>
                <div className="sidebar-list history-work-list">
                  {recentWorkNodes.map((work) => (
                    <button
                      key={work.workId}
                      className={work.workId === selectedWorkId ? 'work-row active' : 'work-row'}
                      type="button"
                      onClick={() => onSelectWork?.(work.workId)}
                      title={work.objective}
                    >
                      <span className={`work-state-dot ${work.state}`} aria-hidden="true" />
                      <span className="work-row-copy">
                        <strong>{work.objective}</strong>
                        <span>{semanticStateLabel(work.state)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button className={activeView === 'runtime' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenRuntime}>
          <span className={`health-dot ${runtimeStatus}`} />
          <span className="nav-label">运行时</span>
          <span className="runtime-mini-label">{runtimeLabel}</span>
        </button>
      </div>
    </aside>
  );
}

function AutomaticContinuationRow({
  task,
  preview,
  onSwitch,
}: {
  task: AutomaticContinuationTaskProjection;
  preview: boolean;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
}) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversation = task.conversation;
  const canSwitch = Boolean(conversation) && !['completed', 'stopped', 'switching_conversation'].includes(task.status);

  return (
    <div className="continuation-row">
      <div className="continuation-main">
        <div className="continuation-title-row">
          <span className={`status-dot ${statusTone(task.status)}`} />
          <strong>自动推进</strong>
          <span className="subtle-label">{task.statusLabel}</span>
        </div>
        <p>{task.objective}</p>
        {conversation ? (
          <a className="conversation-link" href={conversation.conversationUrl} target="_blank" rel="noreferrer">
            打开绑定会话
          </a>
        ) : <span className="subtle-label">尚未绑定精确会话</span>}
      </div>
      <div className="continuation-actions">
        <button
          className="plain-action"
          type="button"
          disabled={!canSwitch || switching || (!preview && !onSwitch)}
          onClick={async () => {
            if (preview || !onSwitch) return;
            setError(null);
            setSwitching(true);
            try { await onSwitch(task); }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { setSwitching(false); }
          }}
        >
          {switching ? '切换中…' : '切换到新会话'}
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <details className="compact-details">
        <summary>任务详情</summary>
        <dl>
          <div><dt>任务</dt><dd className="mono">{task.taskId}</dd></div>
          {task.workId && <div><dt>工作</dt><dd className="mono">{task.workId}</dd></div>}
          {task.repoId && <div><dt>项目</dt><dd className="mono">{task.repoId}</dd></div>}
          {task.requirementId && <div><dt>需求</dt><dd className="mono">{task.requirementId}</dd></div>}
          {conversation && <div><dt>会话</dt><dd className="mono">{conversation.conversationId}</dd></div>}
          {task.createdAt && <div><dt>创建</dt><dd>{new Date(task.createdAt).toLocaleString('zh-CN')}</dd></div>}
          <div><dt>状态</dt><dd>{task.detail}</dd></div>
        </dl>
      </details>
    </div>
  );
}

function WorkView({
  projection,
  preview,
  refreshing,
  refreshError,
  onRefresh,
  onSwitch,
  onContinue,
  onSelectWork,
}: {
  projection: ForgeDesktopProjection;
  preview: boolean;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh?: () => Promise<void>;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
  onContinue?: (prompt: string) => Promise<void>;
  onSelectWork?: (workId: string) => void;
}) {
  const work = projection.work;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (!work) {
    const project = projection.project;
    if (!project) {
      return (
        <main className="main-pane empty-main">
          <div className="empty-copy">
            <h1>选择一个项目</h1>
            <p>从左侧项目列表进入 MCP 工作区。</p>
          </div>
        </main>
      );
    }
    return (
      <main className="main-pane work-pane">
        <div className="content-column">
          <header className="work-hero mcp-project-hero">
            <div className="breadcrumb">MCP / Repository</div>
            <h1>{project.name}</h1>
            <p>{project.repository}</p>
          </header>

          <div className="mcp-overview-status" aria-label="MCP 工作区状态">
            <div><span className={`health-dot ${projection.runtime.status}`} /><strong>MCP Workspace</strong></div>
            <div className="mcp-status-actions">
              <span>{projection.runtime.label}</span>
              <button className="plain-action" type="button" disabled={!onRefresh || refreshing} onClick={() => void onRefresh?.()}>
                {refreshing ? '刷新中…' : '刷新 MCP'}
              </button>
            </div>
          </div>

          {refreshError && <div className="inline-error mcp-refresh-error">刷新失败：{refreshError}</div>}

          <section className="mcp-summary-grid" aria-label="MCP 操作概览">
            <div className="mcp-summary-card">
              <span>Repository</span>
              <strong>{project.dirty ? '有未提交修改' : '工作区干净'}</strong>
              <small>{project.branch} · {compactId(project.sourceRevision)}</small>
            </div>
            <div className="mcp-summary-card">
              <span>Work</span>
              <strong>{projection.workGraph.nodes.length} 个当前节点</strong>
              <small>{projection.recentWorkHistory.length > 0 ? projection.recentWorkHistory.length + ' 个近期历史' : '无近期历史'}</small>
            </div>
            <div className="mcp-summary-card">
              <span>Worktree</span>
              <strong>{project.activeCheckoutCount}/{project.checkoutCount} active</strong>
              <small>{project.worktree} · {compactId(project.checkoutId)}</small>
            </div>
            <div className="mcp-summary-card">
              <span>Runtime / MCP</span>
              <strong>{projection.runtime.label}</strong>
              <small>{projection.runtime.status === 'connected' ? 'canonical Runtime projection' : projection.runtime.detail}</small>
            </div>
          </section>

          <section className="mcp-work-overview" aria-label="MCP Work">
            <div className="mcp-work-overview-heading">
              <div><strong>Work</strong><span>canonical rh_work projection</span></div>
              <span>{projection.workGraph.nodes.length} 个当前节点</span>
            </div>
            {projection.workGraph.nodes.length > 0 ? (
              <div className="mcp-work-overview-list">
                {projection.workGraph.nodes.map((node) => (
                  <button className="mcp-work-overview-row" type="button" key={node.workId} disabled={!onSelectWork} onClick={() => onSelectWork?.(node.workId)}>
                    <span className={`work-state-dot ${node.state}`} aria-hidden="true" />
                    <span className="mcp-work-overview-copy"><strong>{node.objective}</strong><small>{semanticStateLabel(node.state)}{node.activity ? ` · ${node.activity}` : ''}</small></span>
                    <span className="mono mcp-work-id">{compactId(node.workId)}</span>
                  </button>
                ))}
              </div>
            ) : <div className="empty-copy inline-empty"><p>这个项目当前没有 canonical Work。Repository 与 Runtime 事实仍可独立查看。</p></div>}
          </section>

          <details className="detail-section" open>
            <summary>Repository / Worktree</summary>
            <div className="detail-grid">
              <div><span>Repository ID</span><strong className="mono">{project.repoId}</strong></div>
              <div><span>Repository</span><strong>{project.repository}</strong></div>
              <div><span>Branch</span><strong>{project.branch}</strong></div>
              <div><span>Checkout</span><strong className="mono">{project.checkoutId}</strong></div>
              <div><span>Checkout type</span><strong>{project.worktree}</strong></div>
              <div><span>Path</span><strong className="mono">{project.checkoutPath}</strong></div>
              <div><span>Source revision</span><strong className="mono">{project.sourceRevision}</strong></div>
              <div><span>Runtime source</span><strong>{projection.runtime.label}</strong></div>
            </div>
          </details>

          <details className="detail-section" open>
            <summary>Active Worktrees · {project.activeCheckoutCount}/{project.checkoutCount}</summary>
            <div className="checkout-list">
              {project.checkouts.map((checkout) => (
                <div className="checkout-row" key={checkout.checkoutId}>
                  <span className={`health-dot ${checkout.active ? 'connected' : 'not_connected'}`} aria-hidden="true" />
                  <div className="checkout-copy">
                    <strong>{checkout.branch ?? 'detached HEAD'}</strong>
                    <span className="mono">{checkout.path}</span>
                  </div>
                  <div className="checkout-meta">
                    <span>{checkout.active ? '当前' : checkout.kind === 'worktree' ? 'worktree' : '主检出'}</span>
                    <span className="mono">{compactId(checkout.checkoutId)}</span>
                  </div>
                </div>
              ))}
            </div>
            {project.checkoutListTruncated && <p className="detail-text">Active checkout 数量超过桌面投影上限；完整 checkout 历史仍由 Repository Registry 持有。</p>}
          </details>
        </div>
      </main>
    );
  }

  const continuations = projection.automaticContinuations.filter((task) => !task.workId || task.workId === work.workId);

  return (
    <main className="main-pane work-pane">
      <div className="content-column">
        <header className="work-hero mcp-work-hero">
          <div className="mcp-work-hero-copy">
            <div className="breadcrumb">MCP / {projection.project?.name ?? '项目'} / {semanticStateLabel(work.semanticState)}</div>
            <h1>{work.title}</h1>
            {work.continuationPrompt && <p>{work.continuationPrompt}</p>}
          </div>
          <button className="plain-action" type="button" disabled={!onRefresh || refreshing} onClick={() => void onRefresh?.()}>
            {refreshing ? '刷新中…' : '刷新 MCP'}
          </button>
        </header>

        {refreshError && <div className="inline-error mcp-refresh-error">刷新失败：{refreshError}</div>}

        {continuations.map((task) => (
          <AutomaticContinuationRow key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
        ))}

        <div className="work-body-copy">
          <p>{work.objective}</p>
        </div>

        <section className="mcp-summary-grid work-summary-grid" aria-label="MCP Work 操作概览">
          <div className="mcp-summary-card">
            <span>Work</span>
            <strong>{semanticStateLabel(work.semanticState)} · r{work.revision}</strong>
            <small className="mono">{compactId(work.workId)}</small>
          </div>
          <div className="mcp-summary-card">
            <span>Plan</span>
            <strong>{projection.plan ? 'r' + projection.plan.revision + ' · ' + projection.plan.status : '未绑定'}</strong>
            <small>{projection.plan ? projection.plan.items.length + ' 个计划项' : 'Work 可独立存在'}</small>
          </div>
          <div className="mcp-summary-card">
            <span>Evidence</span>
            <strong>{work.executionEvidence ? executionPhaseLabel(work.executionEvidence.phase) + ' · ' + work.executionEvidence.evidenceState : '暂无执行证据'}</strong>
            <small>{work.executionEvidence ? work.executionEvidence.verifications.length + ' 条验证 · ' + work.executionEvidence.checks.length + ' 个检查' : 'canonical Work 未提供 evidence projection'}</small>
          </div>
          <div className="mcp-summary-card">
            <span>Repository</span>
            <strong>{projection.project?.dirty ? '有未提交修改' : '工作区干净'}</strong>
            <small>{projection.project?.branch ?? '未知分支'} · {projection.project?.sourceRevision ? compactId(projection.project.sourceRevision) : '未知版本'}</small>
          </div>
        </section>

        {work.nextSafeAction && (
          <div className="next-fact"><span>Forge 下一安全动作</span><p>{work.nextSafeAction}</p></div>
        )}

        {projection.userRequests.length > 0 && (
          <section className="attention-inline" aria-label="需要你处理">
            <div className="attention-heading">需要你处理 · {projection.userRequests.length}</div>
            {projection.userRequests.map((request) => (
              <div className="attention-item" key={request.requestId}>
                <strong>{request.title}</strong>
                <p>{request.summary}</p>
              </div>
            ))}
          </section>
        )}

        <details className="detail-section">
          <summary>工程上下文</summary>
          <div className="detail-grid">
            <div><span>工作</span><strong className="mono">{compactId(work.workId)}</strong></div>
            <div><span>工作修订</span><strong>r{work.revision}</strong></div>
            <div><span>父工作</span><strong className="mono">{work.semanticParentWorkId ? compactId(work.semanticParentWorkId) : '无'}</strong></div>
            <div><span>依赖</span><strong>{work.dependsOnWorkIds.length > 0 ? `${work.dependsOnWorkIds.length} 个` : '无'}</strong></div>
            <div><span>需求</span><strong className="mono">{work.requirementId ? compactId(work.requirementId) : '未绑定'}</strong></div>
            <div><span>计划</span><strong className="mono">{work.planId ? compactId(work.planId) : '未绑定'}</strong></div>
            <div><span>Repository 当前检出</span><strong>{projection.project ? `${projection.project.worktree} · ${compactId(projection.project.checkoutId)}` : '未知'}</strong></div>
            <div><span>更新时间</span><strong>{work.updatedAt ? new Date(work.updatedAt).toLocaleString('zh-CN') : '未知'}</strong></div>
          </div>
          {work.dependsOnWorkIds.length > 0 && <p className="detail-text">依赖：{work.dependsOnWorkIds.map(compactId).join('、')}</p>}
        </details>

        {projection.requirement && (
          <details className="detail-section">
            <summary>需求 · {projection.requirement.title}</summary>
            <div className="detail-grid">
              <div><span>状态</span><strong>{projection.requirement.state === 'open' ? '进行中' : projection.requirement.state}</strong></div>
              <div><span>修订</span><strong>r{projection.requirement.revision}</strong></div>
            </div>
            <p className="detail-text">{projection.requirement.outcomeStatement}</p>
            {projection.requirement.acceptanceCriteria.length > 0 && (
              <ul className="fact-list">{projection.requirement.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
            )}
          </details>
        )}

        {projection.plan && (
          <details className="detail-section" open>
            <summary>计划 · r{projection.plan.revision}</summary>
            <p className="detail-text">{projection.plan.goal}</p>
            {projection.plan.items.length > 0 && (
              <ul className="fact-list">{projection.plan.items.map((item) => <li key={item.id}>{item.objective}</li>)}</ul>
            )}
          </details>
        )}

        {work.executionEvidence && (
          <details className="detail-section" open>
            <summary>执行与验证 · {executionPhaseLabel(work.executionEvidence.phase)} · {work.executionEvidence.checks.length} 个检查 / {work.executionEvidence.verifications.length} 条验证</summary>
            <div className="detail-grid">
              <div><span>阶段</span><strong>{executionPhaseLabel(work.executionEvidence.phase)}</strong></div>
              <div><span>调度</span><strong className="mono">{work.executionEvidence.dispatchState}</strong></div>
              <div><span>证据</span><strong className="mono">{work.executionEvidence.evidenceState}</strong></div>
              <div><span>类型</span><strong className="mono">{work.executionEvidence.workKind}</strong></div>
              <div><span>完成结果</span><strong className="mono">{work.executionEvidence.completionOutcome ?? '未记录'}</strong></div>
              <div><span>证据引用</span><strong>{work.executionEvidence.evidenceRefs.length}</strong></div>
            </div>

            {work.executionEvidence.checks.length > 0 && (
              <section className="evidence-subsection" aria-label="声明检查">
                <div className="evidence-subheading">声明检查</div>
                <div className="check-chip-list">
                  {work.executionEvidence.checks.map((checkId) => <code key={checkId}>{checkId}</code>)}
                </div>
              </section>
            )}

            {work.executionEvidence.phaseEvidence.length > 0 && (
              <section className="evidence-subsection" aria-label="阶段证据">
                <div className="evidence-subheading">阶段证据</div>
                <div className="phase-evidence-list">
                  {work.executionEvidence.phaseEvidence.map((phaseEvidence, index) => (
                    <div className="phase-evidence-item" key={`${phaseEvidence.phase}-${phaseEvidence.recordedAt}-${index}`}>
                      <div className="phase-evidence-heading">
                        <strong>{executionPhaseLabel(phaseEvidence.phase)}</strong>
                        <span>{phaseEvidenceStateLabel(phaseEvidence.state)}</span>
                        {phaseEvidence.source && <span>{phaseEvidence.source}</span>}
                        <span>{formatTimestamp(phaseEvidence.recordedAt)}</span>
                      </div>
                      <p>{phaseEvidence.summary}</p>
                      <div className="phase-evidence-meta">
                        {phaseEvidence.receiptId && <span className="mono">receipt {compactId(phaseEvidence.receiptId)}</span>}
                        {phaseEvidence.evidenceRefs.length > 0 && <span>证据 {phaseEvidence.evidenceRefs.length}</span>}
                      </div>
                      {phaseEvidence.evidenceRefs.length > 0 && (
                        <div className="nested-evidence-list" aria-label="阶段证据引用">
                          {phaseEvidence.evidenceRefs.map((evidence, evidenceIndex) => (
                            <div className="nested-evidence-item" key={`${evidence.evidenceId ?? evidence.artifactId ?? evidence.title}-${evidenceIndex}`}>
                              <strong>{evidence.title}</strong>
                              {evidence.summary && <span>{evidence.summary}</span>}
                              <small className="mono">{evidence.evidenceId ?? evidence.artifactId ?? evidence.detailLevel}</small>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {work.executionEvidence.verifications.length > 0 && (
              <section className="evidence-subsection" aria-label="验证记录">
                <div className="evidence-subheading">验证记录</div>
                <div className="verification-list">
                  {work.executionEvidence.verifications.map((verification, index) => (
                    <div className="verification-item" key={`${verification.checkId}-${verification.recordedAt}-${index}`}>
                      <div className="verification-heading">
                        <strong className="mono">{verification.checkId}</strong>
                        <span>{verificationOutcomeLabel(verification.outcome)}</span>
                        <span>{formatTimestamp(verification.recordedAt)}</span>
                      </div>
                      <p>{verification.summary}</p>
                      <div className="verification-meta">
                        {verification.sourceRevision && <span className="mono">版本 {compactId(verification.sourceRevision)}</span>}
                        {verification.startedAt && <span>开始 {formatTimestamp(verification.startedAt)}</span>}
                        {verification.completedAt && <span>完成 {formatTimestamp(verification.completedAt)}</span>}
                        {verification.receipt && <span className="mono">receipt {compactId(verification.receipt.receiptId)}</span>}
                      </div>
                      {verification.staleReason && <div className="verification-warning">证据已陈旧：{verification.staleReason}</div>}
                      {verification.receipt && (
                        <div className="verification-receipt">
                          <span>执行 {verification.receipt.status}</span>
                          <span>Runtime {verification.receipt.runtimeStatus}</span>
                          <span>{verification.receipt.reusedExecution ? '复用已有执行' : '本次执行'}</span>
                          <span>{formatTimestamp(verification.receipt.startedAt)} → {formatTimestamp(verification.receipt.finishedAt)}</span>
                        </div>
                      )}
                      {verification.evidenceRef && (
                        <div className="nested-evidence-item verification-evidence">
                          <strong>{verification.evidenceRef.title}</strong>
                          {verification.evidenceRef.summary && <span>{verification.evidenceRef.summary}</span>}
                          <small className="mono">{verification.evidenceRef.evidenceId ?? verification.evidenceRef.artifactId ?? verification.evidenceRef.detailLevel}</small>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {work.executionEvidence.evidenceRefs.length > 0 && (
              <section className="evidence-subsection" aria-label="证据引用">
                <div className="evidence-subheading">证据引用</div>
                <div className="evidence-ref-list">
                  {work.executionEvidence.evidenceRefs.map((evidence, index) => (
                    <div key={`${evidence.evidenceId ?? evidence.artifactId ?? evidence.title}-${index}`}>
                      <strong>{evidence.title}</strong>
                      {evidence.summary && <span>{evidence.summary}</span>}
                      <small className="mono">{evidence.evidenceId ?? evidence.artifactId ?? evidence.detailLevel}</small>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </details>
        )}

        {(work.revisionHistory.length > 0 || (projection.plan?.revisionHistory.length ?? 0) > 0) && (
          <details className="detail-section">
            <summary>修订历史 · Work {work.revisionHistory.length} / Plan {projection.plan?.revisionHistory.length ?? 0}</summary>
            <div className="history-groups">
              {work.revisionHistory.length > 0 && (
                <section className="history-group" aria-label="Work 修订历史">
                  <div className="history-heading">Work</div>
                  <ol className="history-list">
                    {work.revisionHistory.map((revision) => (
                      <li key={`work-${revision.revision}`}>
                        <div className="history-meta"><strong>r{revision.revision}</strong><span>{semanticStateLabel(revision.state)}</span><span>{revision.recordedAt ? new Date(revision.recordedAt).toLocaleString('zh-CN') : '时间未知'}</span></div>
                        <p>{revision.objective}</p>
                        {revision.resultRefs.length > 0 && <span className="history-count">结果引用 {revision.resultRefs.length}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {(projection.plan?.revisionHistory.length ?? 0) > 0 && (
                <section className="history-group" aria-label="Plan 修订历史">
                  <div className="history-heading">Plan</div>
                  <ol className="history-list">
                    {projection.plan?.revisionHistory.map((revision) => (
                      <li key={`plan-${revision.revision}`}>
                        <div className="history-meta"><strong>r{revision.revision}</strong><span>{revision.status}</span><span>{revision.recordedAt ? new Date(revision.recordedAt).toLocaleString('zh-CN') : '时间未知'}</span></div>
                        <p>{revision.goal}</p>
                        {revision.items.length > 0 && <span className="history-count">计划项 {revision.items.length}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </details>
        )}

        <details className="detail-section">
          <summary>结果与证据 {work.resultRefs.length > 0 ? `· ${work.resultRefs.length}` : ''}</summary>
          {work.resultRefs.length > 0 ? (
            <div className="result-list">
              {work.resultRefs.map((resultRef) => <code key={resultRef}>{resultRef}</code>)}
            </div>
          ) : <p className="detail-text">当前还没有结果引用。</p>}
        </details>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="向当前工作发送指令"
            placeholder="告诉 ChatGPT 接下来要做什么…"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!onContinue}
          />
          {sendError && <div className="composer-error">发送失败：{sendError}</div>}
          <div className="composer-footer">
            <span>{projection.project?.name ?? '项目'} · {compactId(work.workId)}</span>
            <button
              type="button"
              disabled={!onContinue || !draft.trim() || sending}
              onClick={async () => {
                if (!onContinue || !draft.trim()) return;
                setSendError(null);
                setSending(true);
                try {
                  await onContinue(draft.trim());
                  setDraft('');
                } catch (cause) {
                  setSendError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setSending(false);
                }
              }}
            >{sending ? '发送中…' : '继续'}</button>
          </div>
        </div>
      </div>
    </main>
  );
}

function AssistantView({
  tasks,
  projects,
  provider,
  providerLoading,
  providerError,
  preview,
  onSwitch,
  onRefreshProvider,
  onSendLocal,
}: {
  tasks: AutomaticContinuationTaskProjection[];
  projects: ProjectListItemProjection[];
  provider: LocalProviderStatusProjection | null;
  providerLoading: boolean;
  providerError: string | null;
  preview: boolean;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
  onRefreshProvider: () => Promise<void>;
  onSendLocal: (input: { thread: LocalConversationThread; prompt: string }) => Promise<LocalConversationReply>;
}) {
  return (
    <main className="main-pane assistant-pane">
      <div className="content-column assistant-content">
        <header className="work-hero assistant-hero">
          <div className="breadcrumb">Forge</div>
          <h1>助手</h1>
          <p>本地会话属于桌面客户端；需要长期执行的工作仍由 Forge 的 canonical Work 与 Controller authority 承担。</p>
        </header>
        <LocalConversationSurface
          projects={projects}
          provider={provider}
          providerLoading={providerLoading}
          providerError={providerError}
          onRefreshProvider={onRefreshProvider}
          onSend={onSendLocal}
        />
        <section className="assistant-automation" aria-label="自动推进">
          <div className="assistant-section-heading"><strong>自动推进</strong><span>canonical Workflow Supervisor</span></div>
          {tasks.length > 0 ? tasks.map((task) => (
            <AutomaticContinuationRow key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
          )) : (
            <div className="empty-copy inline-empty"><p>当前没有活动的自动推进任务。</p></div>
          )}
        </section>
      </div>
    </main>
  );
}

function RuntimeView({
  projection,
  loading,
  error,
  action,
  connection,
  connectionLoading,
  connectionError,
  connectionAction,
  onRefresh,
  onDiagnose,
  onRestart,
  onRecover,
  onRefreshConnection,
  onRepairConnection,
}: {
  projection: RuntimeRecoveryProjection | null;
  loading: boolean;
  error: string | null;
  action: 'diagnose' | 'restart' | 'recover' | null;
  connection: ControllerConnectionProjection | null;
  connectionLoading: boolean;
  connectionError: string | null;
  connectionAction: 'repair' | null;
  onRefresh: () => Promise<void>;
  onDiagnose: () => Promise<void>;
  onRestart: () => Promise<void>;
  onRecover: () => Promise<void>;
  onRefreshConnection: () => Promise<void>;
  onRepairConnection: () => Promise<void>;
}) {
  const disabled = loading || action !== null || !projection?.recovery.available;
  const runtimeRunning = projection?.runtime.running === true;
  const runtimeReady = projection?.runtime.ready === true;
  const restartLabel = runtimeRunning ? '重启运行时' : '启动运行时';
  const restartPendingLabel = runtimeRunning ? '重启中…' : '启动中…';
  return (
    <main className="main-pane runtime-pane">
      <div className="content-column narrow-column">
        <header className="work-hero">
          <div className="breadcrumb">系统</div>
          <h1>运行时与恢复</h1>
          <p>状态来自独立恢复服务；客户端不接管运行时生命周期。</p>
        </header>

        {error && <div className="inline-error standalone-error">{error}</div>}

        <section className="runtime-summary">
          <div className="runtime-primary-row">
            <span className={`health-dot ${projection?.runtime.ready ? 'connected' : projection?.recovery.available ? 'degraded' : 'not_connected'}`} />
            <div>
              <strong>{projection?.runtime.label ?? (loading ? '正在读取状态' : '状态未知')}</strong>
              <p>{projection?.runtime.detail ?? '等待独立恢复返回状态。'}</p>
            </div>
          </div>
          <div className="runtime-actions">
            <button className="plain-action" type="button" disabled={loading || action !== null} onClick={() => void onRefresh()}>刷新</button>
            <button className="plain-action" type="button" disabled={disabled} onClick={() => void onDiagnose()}>{action === 'diagnose' ? '诊断中…' : '诊断'}</button>
            <button className="plain-action" type="button" disabled={disabled} onClick={() => void onRestart()}>{action === 'restart' ? restartPendingLabel : restartLabel}</button>
            {!runtimeReady && projection?.recovery.available && (
              <button className="plain-action" type="button" disabled={disabled} onClick={() => void onRecover()}>{action === 'recover' ? '恢复中…' : '深度恢复'}</button>
            )}
          </div>
        </section>

        {connectionError && <div className="inline-error standalone-error">连接读取失败：{connectionError}</div>}

        <section className="runtime-summary" aria-label="Forge 连接">
          <div className="runtime-primary-row">
            <span className={`health-dot ${connection?.ready ? 'connected' : connection?.configured ? 'degraded' : 'not_connected'}`} />
            <div>
              <strong>{connection?.ready ? '控制器连接已就绪' : connection?.configured ? '控制器连接需要处理' : connectionLoading ? '正在读取连接状态' : '连接尚未配置'}</strong>
              <p>{connection?.controller.detail ?? '连接状态来自 Forge setup authority；客户端不保存配置副本。'}</p>
            </div>
          </div>
          <div className="runtime-actions">
            <button className="plain-action" type="button" disabled={connectionLoading || connectionAction !== null} onClick={() => void onRefreshConnection()}>刷新连接</button>
            {connection?.repair.available && (
              <button className="plain-action" type="button" disabled={connectionLoading || connectionAction !== null} onClick={() => void onRepairConnection()}>
                {connectionAction === 'repair' ? '修复中…' : connection.repair.label}
              </button>
            )}
          </div>
        </section>

        {connection && (
          <details className="detail-section" open>
            <summary>连接详情</summary>
            <div className="detail-grid">
              <div><span>主控制器</span><strong>{connection.profile?.primaryController ?? '未配置'}</strong></div>
              <div><span>控制器</span><strong>{connection.profile?.controllers.join('、') || '未配置'}</strong></div>
              <div><span>远程传输</span><strong>{connection.tunnel.provider}</strong></div>
              <div><span>总体状态</span><strong>{connection.ready ? '已就绪' : '需要处理'}</strong></div>
            </div>
            <div className="diagnostic-list simple-diagnostics">
              <div className="diagnostic-item">
                <span>{connection.controller.title}</span>
                <strong className={connection.controller.ready ? 'diagnostic-state pass' : 'diagnostic-state fail'}>{connection.controller.ready ? '就绪' : '需处理'}</strong>
              </div>
              <div className="diagnostic-item">
                <span>{connection.tunnel.title}</span>
                <strong className={connection.tunnel.ready ? 'diagnostic-state pass' : 'diagnostic-state fail'}>{connection.tunnel.ready ? '就绪' : '需处理'}</strong>
              </div>
            </div>
            {!connection.ready && <p className="detail-text">{connection.controller.ready ? connection.tunnel.detail : connection.controller.detail}</p>}
          </details>
        )}

        <details className="detail-section" open>
          <summary>状态详情</summary>
          <div className="detail-grid">
            <div><span>进程 ID</span><strong>{projection?.runtime.pid ?? '未知'}</strong></div>
            <div><span>发布版本</span><strong className="mono">{projection?.runtime.releaseId ? compactId(projection.runtime.releaseId) : '未知'}</strong></div>
            <div><span>独立恢复</span><strong>{projection?.recovery.label ?? '未知'}</strong></div>
            <div><span>最近观察</span><strong>{formatTimestamp(projection?.runtime.observedAt)}</strong></div>
          </div>
        </details>

        {projection && projection.history.length > 0 && (
          <details className="detail-section">
            <summary>最近恢复记录 · {projection.history.length}</summary>
            <ol className="history-list">
              {projection.history.map((entry, index) => (
                <li key={`${entry.at}-${entry.event}-${index}`}>
                  <div className="history-meta">
                    <strong>{entry.label}</strong>
                    <span>{formatTimestamp(entry.at)}</span>
                    {entry.ok !== undefined && <span>{entry.ok ? '正常' : '异常'}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </details>
        )}

        {projection?.diagnostics && (
          <details className="detail-section" open>
            <summary>诊断 · {projection.diagnostics.passed} 通过 / {projection.diagnostics.failed} 异常</summary>
            <div className="diagnostic-list simple-diagnostics">
              {projection.diagnostics.probes.map((probe) => (
                <div className="diagnostic-item" key={probe.id}>
                  <span>{probe.label}</span>
                  <strong className={probe.ok ? 'diagnostic-state pass' : 'diagnostic-state fail'}>{probe.ok ? '通过' : '异常'}</strong>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </main>
  );
}

export function App() {
  const preview = useMemo(previewEnabled, []);
  const [projection, setProjection] = useState<ForgeDesktopProjection>(preview ? designPreviewProjection : disconnectedProjection);
  const [projects, setProjects] = useState<ProjectListItemProjection[]>(preview ? [...designPreviewProjection.projects] : []);
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(preview ? designPreviewProjection.project?.repoId : undefined);
  const [selectedWorkId, setSelectedWorkId] = useState<string | undefined>(preview ? designPreviewProjection.work?.workId : undefined);
  const [activeView, setActiveView] = useState<AppView>('project');
  const [recoveryProjection, setRecoveryProjection] = useState<RuntimeRecoveryProjection | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<'diagnose' | 'restart' | 'recover' | null>(null);
  const [connectionProjection, setConnectionProjection] = useState<ControllerConnectionProjection | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionAction, setConnectionAction] = useState<'repair' | null>(null);
  const [localProvider, setLocalProvider] = useState<LocalProviderStatusProjection | null>(null);
  const [localProviderLoading, setLocalProviderLoading] = useState(false);
  const [localProviderError, setLocalProviderError] = useState<string | null>(null);
  const [mcpRefreshing, setMcpRefreshing] = useState(false);
  const [mcpRefreshError, setMcpRefreshError] = useState<string | null>(null);

  const refreshRecovery = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      setRecoveryProjection(await readRecoveryStatus());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setRecoveryProjection(unavailableRecoveryProjection(message));
      setRecoveryError(message);
    } finally {
      setRecoveryLoading(false);
    }
  }, [preview]);

  const refreshLocalProvider = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    setLocalProviderLoading(true);
    setLocalProviderError(null);
    try {
      setLocalProvider(await readLocalProviderStatus());
    } catch (cause) {
      setLocalProvider(null);
      setLocalProviderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLocalProviderLoading(false);
    }
  }, [preview]);

  const sendLocal = useCallback(async ({ thread, prompt }: { thread: LocalConversationThread; prompt: string }): Promise<LocalConversationReply> => {
    const result = await sendLocalConversation({
      conversationId: thread.id,
      providerSessionId: thread.providerSessionId,
      prompt,
      repoId: thread.projectRepoId,
    });
    return { content: result.output, providerSessionId: result.providerSessionId };
  }, []);

  const refreshConnection = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      setConnectionProjection(await readConnectionStatus());
    } catch (cause) {
      setConnectionProjection(null);
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnectionLoading(false);
    }
  }, [preview]);

  const loadProject = useCallback(async (project: ProjectListItemProjection, workId?: string) => {
    if (preview || !tauriRuntimeAvailable()) return;
    try {
      const [workspace, automaticContinuations] = await Promise.all([
        readProjectWorkspace(project, workId),
        readAutomaticContinuations(),
      ]);
      setSelectedRepoId(project.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前数据来自 Forge Runtime。' },
        projects,
        ...workspace,
        automaticContinuations,
      });
    } catch (cause) {
      setProjection((current) => ({
        ...current,
        runtime: { status: 'degraded', label: '运行时读取异常', detail: cause instanceof Error ? cause.message : String(cause) },
      }));
    }
  }, [preview, projects]);

  const bootstrapRuntime = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    try {
      const [catalog, automaticContinuations] = await Promise.all([readProjects(), readAutomaticContinuations()]);
      setProjects(catalog.projects);
      const selectedProject = catalog.projects.find((project) => project.repoId === catalog.preferredRepoId) ?? catalog.projects[0];
      if (!selectedProject) {
        setProjection({
          ...disconnectedProjection,
          source: 'runtime',
          runtime: { status: 'connected', label: '运行时已连接', detail: '当前没有已注册项目。' },
          projects: [],
          automaticContinuations,
        });
        setActiveView('assistant');
        return;
      }
      const workspace = await readProjectWorkspace(selectedProject);
      setSelectedRepoId(selectedProject.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前数据来自 Forge Runtime。' },
        projects: catalog.projects,
        ...workspace,
        automaticContinuations,
      });
    } catch (cause) {
      setProjection({
        ...disconnectedProjection,
        runtime: { status: 'degraded', label: '运行时不可用', detail: cause instanceof Error ? cause.message : String(cause) },
      });
      setActiveView('runtime');
      void Promise.all([refreshRecovery(), refreshConnection()]);
    }
  }, [preview, refreshConnection, refreshRecovery]);

  useEffect(() => { void bootstrapRuntime(); }, [bootstrapRuntime]);
  useEffect(() => { void refreshLocalProvider(); }, [refreshLocalProvider]);

  const refreshMcp = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable() || mcpRefreshing) return;
    setMcpRefreshing(true);
    setMcpRefreshError(null);
    try {
      const [catalog, automaticContinuations] = await Promise.all([readProjects(), readAutomaticContinuations()]);
      setProjects(catalog.projects);
      const selectedProject = catalog.projects.find((project) => project.repoId === selectedRepoId)
        ?? catalog.projects.find((project) => project.repoId === catalog.preferredRepoId)
        ?? catalog.projects[0];
      if (!selectedProject) {
        setSelectedRepoId(undefined);
        setSelectedWorkId(undefined);
        setProjection({
          ...disconnectedProjection,
          source: 'runtime',
          runtime: { status: 'connected', label: '运行时已连接', detail: '当前没有已注册项目。' },
          projects: [],
          automaticContinuations,
        });
        return;
      }
      const workspace = await readProjectWorkspace(selectedProject, selectedWorkId);
      setSelectedRepoId(selectedProject.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '刚刚从 Forge Runtime 重新读取。' },
        projects: catalog.projects,
        ...workspace,
        automaticContinuations,
      });
    } catch (cause) {
      setMcpRefreshError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMcpRefreshing(false);
    }
  }, [mcpRefreshing, preview, selectedRepoId, selectedWorkId]);

  const handleSelectProject = useCallback(async (project: ProjectListItemProjection) => {
    setActiveView('project');
    setSelectedWorkId(undefined);
    await loadProject(project);
  }, [loadProject]);

  const handleSelectWork = useCallback(async (workId: string) => {
    const project = projects.find((candidate) => candidate.repoId === selectedRepoId);
    if (!project) return;
    setActiveView('project');
    await loadProject(project, workId);
  }, [loadProject, projects, selectedRepoId]);

  const handleSwitch = useCallback(async (task: AutomaticContinuationTaskProjection) => {
    await switchAutomaticContinuationConversation(task);
    const project = projects.find((candidate) => candidate.repoId === selectedRepoId);
    if (project) await loadProject(project, selectedWorkId);
  }, [loadProject, projects, selectedRepoId, selectedWorkId]);

  const handleContinue = useCallback(async (prompt: string) => {
    if (!projection.project || !projection.work) return;
    const selectedProject = projects.find((candidate) => candidate.repoId === projection.project?.repoId);
    if (!selectedProject) throw new Error('当前项目已经不在项目列表中，请重新选择项目。');
    await continueWork(projection.project.repoId, projection.work.workId, prompt);
    await loadProject(selectedProject, projection.work.workId);
  }, [loadProject, projection, projects]);

  const handleOpenAssistant = useCallback(() => {
    setActiveView('assistant');
  }, []);

  const handleOpenMcp = useCallback(() => {
    setActiveView('project');
  }, []);

  const handleOpenRuntime = useCallback(async () => {
    setActiveView('runtime');
    await Promise.all([refreshRecovery(), refreshConnection()]);
  }, [refreshConnection, refreshRecovery]);

  const handleRepairConnection = useCallback(async () => {
    setConnectionAction('repair');
    setConnectionError(null);
    try {
      setConnectionProjection(await repairConnection());
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause));
      await refreshConnection();
    } finally {
      setConnectionAction(null);
    }
  }, [refreshConnection]);

  const handleDiagnose = useCallback(async () => {
    setRecoveryAction('diagnose');
    setRecoveryError(null);
    try {
      const current = recoveryProjection ?? await readRecoveryStatus();
      setRecoveryProjection(await verifyRecoveryRuntime(current));
    } catch (cause) {
      setRecoveryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRecoveryAction(null);
    }
  }, [recoveryProjection]);

  const handleRestartRuntime = useCallback(async () => {
    const starting = recoveryProjection?.runtime.running !== true;
    const confirmed = window.confirm(starting
      ? '将通过独立恢复服务启动主运行时，并在启动后执行完整运行时验证。是否继续？'
      : '将通过独立恢复服务重启主运行时，现有运行时连接会短暂中断。是否继续？');
    if (!confirmed) return;
    setRecoveryAction('restart');
    setRecoveryError(null);
    try {
      await performRecoveryAction('restart_runtime');
      setRecoveryProjection(await readRecoveryStatus());
    } catch (cause) {
      setRecoveryError(cause instanceof Error ? cause.message : String(cause));
      await refreshRecovery();
    } finally {
      setRecoveryAction(null);
    }
  }, [recoveryProjection?.runtime.running, refreshRecovery]);

  const handleRecoverRuntime = useCallback(async () => {
    const confirmed = window.confirm('深度恢复可能进入 Runtime release 恢复或回滚事务。仅当普通启动/重启无法恢复主运行时时继续。是否执行？');
    if (!confirmed) return;
    setRecoveryAction('recover');
    setRecoveryError(null);
    try {
      await performRecoveryAction('recover_runtime');
      setRecoveryProjection(await readRecoveryStatus());
    } catch (cause) {
      setRecoveryError(cause instanceof Error ? cause.message : String(cause));
      await refreshRecovery();
    } finally {
      setRecoveryAction(null);
    }
  }, [refreshRecovery]);

  const runtimeStatus = activeView === 'runtime'
    ? recoveryProjection?.runtime.ready ? 'connected' : recoveryProjection?.recovery.available ? 'degraded' : 'not_connected'
    : projection.runtime.status;
  const runtimeLabel = activeView === 'runtime'
    ? recoveryProjection?.runtime.label ?? (recoveryLoading ? '读取中' : '状态未知')
    : projection.runtime.label;

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        workNodes={activeView === 'project' ? projection.workGraph.nodes : []}
        recentWorkNodes={activeView === 'project' ? projection.recentWorkHistory : []}
        selectedRepoId={selectedRepoId}
        selectedWorkId={selectedWorkId}
        activeView={activeView}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        onOpenAssistant={handleOpenAssistant}
        onOpenMcp={handleOpenMcp}
        onSelectProject={preview ? undefined : handleSelectProject}
        onSelectWork={preview ? undefined : handleSelectWork}
        onOpenRuntime={preview ? undefined : handleOpenRuntime}
      />

      {activeView === 'assistant' ? (
        <AssistantView
          tasks={projection.automaticContinuations}
          projects={projects}
          provider={localProvider}
          providerLoading={localProviderLoading}
          providerError={localProviderError}
          preview={preview}
          onSwitch={preview ? undefined : handleSwitch}
          onRefreshProvider={refreshLocalProvider}
          onSendLocal={sendLocal}
        />
      ) : activeView === 'runtime' ? (
        <RuntimeView
          projection={recoveryProjection}
          loading={recoveryLoading}
          error={recoveryError}
          action={recoveryAction}
          connection={connectionProjection}
          connectionLoading={connectionLoading}
          connectionError={connectionError}
          connectionAction={connectionAction}
          onRefresh={refreshRecovery}
          onDiagnose={handleDiagnose}
          onRestart={handleRestartRuntime}
          onRecover={handleRecoverRuntime}
          onRefreshConnection={refreshConnection}
          onRepairConnection={handleRepairConnection}
        />
      ) : (
        <WorkView
          projection={projection}
          preview={preview}
          refreshing={mcpRefreshing}
          refreshError={mcpRefreshError}
          onRefresh={preview ? undefined : refreshMcp}
          onSwitch={preview ? undefined : handleSwitch}
          onContinue={preview ? undefined : handleContinue}
          onSelectWork={preview ? undefined : (workId) => { void handleSelectWork(workId); }}
        />
      )}
    </div>
  );
}
