import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  designPreviewProjection,
  disconnectedProjection,
  type ControllerConnectionProjection,
  type ForgeDesktopProjection,
  type ProjectListItemProjection,
  type RuntimeRecoveryProjection,
  type WorkGraphNodeProjection,
  type WorkSemanticState,
} from './runtime-projection';
import {
  continueWork,
  readConnectionStatus,
  readLocalProviderStatus,
  readProjects,
  readProjectWorkspace,
  repairConnection,
  sendLocalConversation,
  cancelLocalConversation,
  tauriRuntimeAvailable,
  type LocalProviderStatusProjection,
} from './runtime-client';
import { LocalConversationSurface, type LocalConversationReply, type LocalConversationThread, type LocalConversationNavItem } from './local-conversation';
import { ForgeIcon } from './ui-icons';
import forgeAppIcon from '../src-tauri/icons/128x128.png';
import { ProjectRecordsView } from './project-records-view';
import { KnowledgeView } from './knowledge-view';
import { SettingsView } from './settings-view';
import { readLocalApiSettings, saveLocalApiSettings, clearLocalApiKey, sendLocalApiConversation, cancelLocalApiConversation, type LocalApiSettings, type LocalProviderChoice } from './local-api';
import {
  performRecoveryAction,
  readRecoveryStatus,
  unavailableRecoveryProjection,
  verifyRecoveryRuntime,
} from './recovery-client';

type AppView = 'assistant' | 'project' | 'requirements' | 'plans' | 'works' | 'knowledge' | 'settings' | 'runtime';

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

function Sidebar({
  projects,
  selectedRepoId,
  activeView,
  runtimeLabel,
  runtimeStatus,
  runtimeDetail,
  onRetryProjects,
  onOpenAssistant,
  onNewThread,
  onOpenProjects,
  onOpenRequirements,
  onOpenPlans,
  onOpenKnowledge,
  onOpenSettings,
  onSelectProject,
  localThreads,
  selectedLocalThreadId,
  onSelectLocalThread,
  onOpenRuntime,
}: {
  projects: ProjectListItemProjection[];
  selectedRepoId?: string;
  activeView: AppView;
  runtimeLabel: string;
  runtimeStatus: string;
  runtimeDetail: string;
  onRetryProjects: () => void;
  onOpenAssistant: () => void;
  onNewThread: () => void;
  onOpenProjects: () => void;
  onOpenRequirements: () => void;
  onOpenPlans: () => void;
  onOpenKnowledge: () => void;
  onOpenSettings: () => void;
  onSelectProject?: (project: ProjectListItemProjection) => void;
  localThreads: LocalConversationNavItem[];
  selectedLocalThreadId?: string;
  onSelectLocalThread: (id: string) => void;
  onOpenRuntime?: () => void;
}) {
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const activeProject = projects.find((project) => project.repoId === selectedRepoId);
  const matchingProjects = projects.filter((project) =>
    (project.name + ' ' + project.repository + ' ' + (project.localRoot ?? ''))
      .toLowerCase().includes(projectQuery.toLowerCase().trim()));
  return (
    <aside className="sidebar">
      <div className="sidebar-main">
        <div className="sidebar-brand" aria-label="Forge">
          <img className="sidebar-brand-icon" src={forgeAppIcon} alt="" />
          <span className="sidebar-app-name">Forge</span>
          <span className="sidebar-app-subtitle">工作空间</span>
        </div>
        <nav className="sidebar-primary" aria-label="工作区导航">
          <button className="nav-row sidebar-new-thread" type="button" onClick={onNewThread}>
            <span className="nav-symbol"><ForgeIcon name="new-thread" /></span><span className="nav-label">新会话</span><span className="sidebar-keyboard">⌘N</span>
          </button>
          <button className={activeView === 'assistant' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenAssistant}>
            <span className="nav-symbol"><ForgeIcon name="conversations" /></span><span className="nav-label">会话</span>
          </button>
          <button className={activeView === 'works' || activeView === 'project' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenProjects}>
            <span className="nav-symbol"><ForgeIcon name="work" /></span><span className="nav-label">Work · 工作</span>
          </button>
          <button className={activeView === 'requirements' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenRequirements}>
            <span className="nav-symbol"><ForgeIcon name="requirement" /></span><span className="nav-label">Requirement · 需求</span>
          </button>
          <button className={activeView === 'plans' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenPlans}>
            <span className="nav-symbol"><ForgeIcon name="plan" /></span><span className="nav-label">Plan · 计划</span>
          </button>
          <button className={activeView === 'knowledge' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenKnowledge}>
            <span className="nav-symbol"><ForgeIcon name="knowledge" /></span><span className="nav-label">记忆与知识</span>
          </button>
        </nav>
        {localThreads.length > 0 && (
          <section className="sidebar-conversations" aria-label="最近会话">
            <div className="sidebar-section-title">最近会话</div>
            {localThreads.slice(0, 10).map((thread) => (
              <button type="button" key={thread.id}
                className={'nav-row sidebar-thread-row' + (activeView === 'assistant' && selectedLocalThreadId === thread.id ? ' active' : '')}
                title={thread.title} onClick={() => onSelectLocalThread(thread.id)}>
                <span className="nav-symbol"><ForgeIcon name={thread.draft ? 'draft' : 'conversation'} /></span>
                <span className="nav-label">{thread.title}</span>
                {thread.draft && <span className="sidebar-draft-indicator">草稿</span>}
              </button>
            ))}
          </section>
        )}
        <div className="sidebar-project-heading">
          <button className="sidebar-project-picker" type="button" aria-expanded={showProjectPicker}
            title={activeProject?.localRoot ?? activeProject?.repository ?? '选择已注册项目'}
            onClick={() => setShowProjectPicker((expanded) => !expanded)}>
            <span className="project-folder"><ForgeIcon name="project" /></span>
            <span className="project-picker-identity">
              <span className="nav-label">{activeProject?.repository.split('/').at(-1) ?? '选择项目'}</span>
              {activeProject?.repository && <small title={activeProject.localRoot ?? activeProject.repository}>
                {activeProject.name} · {activeProject.repository}
              </small>}
            </span>
            <span className={'project-caret' + (showProjectPicker ? ' expanded' : '')}><ForgeIcon name="chevron" size={15} /></span>
          </button>
          <button type="button" title="刷新已注册项目" aria-label="刷新已注册项目" onClick={onRetryProjects}><ForgeIcon name="refresh" size={16} /></button>
        </div>
        {showProjectPicker && (
          <div className="sidebar-project-picker-panel">
            <input aria-label="搜索已注册项目" placeholder={'搜索 ' + projects.length + ' 个项目'}
              value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} />
            <div className="sidebar-list sidebar-projects">
              {projects.length === 0 && (
                <div className="sidebar-project-error" role="status">
                  <strong>{runtimeStatus === 'connected' ? '尚无已注册项目' : '项目目录读取失败'}</strong>
                  <span>{runtimeDetail}</span>
                  <button type="button" className="plain-action" onClick={onRetryProjects}>重新读取</button>
                </div>
              )}
              {matchingProjects.map((project) => (
                <button className={project.repoId === selectedRepoId ? 'nav-row project-row active' : 'nav-row project-row'}
                  key={project.repoId} type="button" title={project.localRoot ?? project.repository}
                  onClick={() => { onSelectProject?.(project); setShowProjectPicker(false); }}>
                  <span className="project-folder"><ForgeIcon name="project" /></span>
                  <span className="project-picker-identity">
                    <span className="nav-label">{project.repository.split('/').at(-1) ?? project.name}</span>
                    <small>{project.name} · {project.repository}</small>
                  </span>
                </button>
              ))}
              {projects.length > 0 && matchingProjects.length === 0 && <p className="sidebar-project-error">未找到匹配项目</p>}
            </div>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className={activeView === 'settings' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenSettings}>
          <span className="nav-symbol"><ForgeIcon name="settings" /></span><span className="nav-label">设置</span>
        </button>
        <button className={activeView === 'runtime' ? 'nav-row active' : 'nav-row'} type="button" onClick={onOpenRuntime}>
          <span className="nav-symbol"><ForgeIcon name="runtime" /></span>
          <span className="nav-label">MCP 服务与运行时</span>
          <span className={`health-dot ${runtimeStatus}`} />
          <span className="runtime-mini-label">{runtimeLabel}</span>
        </button>
      </div>
    </aside>
  );
}

function WorkView({
  projection,
  refreshing,
  refreshError,
  onRefresh,
  onContinue,
  onSelectWork,
  onNavigateRecord,
  onStartAgentForWork,
}: {
  projection: ForgeDesktopProjection;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh?: () => Promise<void>;
  onContinue?: (prompt: string) => Promise<void>;
  onSelectWork?: (workId: string) => void;
  onNavigateRecord?: (mode: 'requirements' | 'plans', id: string) => void;
  onStartAgentForWork?: (repoId: string, workId: string) => void;
}) {
  const work = projection.work;
  // Current and bounded history only: these links are not an exhaustive
  // Requirement/Plan portfolio and must not be presented as one.
  const visibleWorks = [...projection.workGraph.nodes, ...projection.recentWorkHistory];
  const linkedRequirements = Array.from(new Set(visibleWorks
    .map((node) => node.requirementId).filter((id): id is string => Boolean(id))));
  const linkedPlans = Array.from(new Set(visibleWorks
    .map((node) => node.planId).filter((id): id is string => Boolean(id))));
  const relatedWorks = work?.requirementId
    ? visibleWorks.filter((node) => node.requirementId === work.requirementId && node.workId !== work.workId)
    : [];
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
            <p>从左侧选择项目，可查看已登记的 Work、关联需求、计划和验证证据。</p>
          </div>
        </main>
      );
    }
    return (
      <main className="main-pane work-pane">
        <div className="content-column">
          <header className="work-hero mcp-project-hero">
            <div className="breadcrumb">项目 / Repository</div>
            <h1>{project.name}</h1>
            <p>{project.repository}</p>
          </header>

          <div className="mcp-overview-status" aria-label="Forge 工作区状态">
            <div><span className={`health-dot ${projection.runtime.status}`} /><strong>项目工作区</strong></div>
            <div className="mcp-status-actions">
              <span>{projection.runtime.label}</span>
              <button className="plain-action" type="button" disabled={!onRefresh || refreshing} onClick={() => void onRefresh?.()}>
                {refreshing ? '刷新中…' : '刷新'}
              </button>
            </div>
          </div>

          {refreshError && <div className="inline-error mcp-refresh-error">刷新失败：{refreshError}</div>}

          <section className="mcp-summary-grid" aria-label="Forge 工作概览">
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

          <section className="relationship-overview" aria-label="项目需求和计划关联">
            <div className="relationship-heading">
              <strong>需求与工作关联</strong>
              <span>从当前及近期 Work 汇总 · 非完整需求目录</span>
            </div>
            {linkedRequirements.length > 0 ? (
              <div className="relationship-list">
                {linkedRequirements.map((requirementId) => {
                  const members = visibleWorks.filter((node) => node.requirementId === requirementId);
                  return (
                    <div className="relationship-item" key={requirementId}>
                      <div className="relationship-item-head">
                        <span className="relation-type">需求</span>
                        <strong className="mono" title={requirementId}>{requirementId}</strong>
                        <small>{members.length} 个可见 Work</small>
                      </div>
                      <div className="relation-work-links">
                        {members.map((member) => (
                          <button className="relation-work-link" type="button" key={member.workId}
                            onClick={() => onSelectWork?.(member.workId)} disabled={!onSelectWork}
                            title={member.objective}>
                            <span className={'work-state-dot ' + member.state} />
                            <span>{member.objective}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="relationship-empty">当前加载的 Work 未提供 Requirement 关联，不能推断项目没有需求。</p>}
            {linkedPlans.length > 0 && (
              <div className="relationship-plan-summary">
                <span>关联 Plan · {linkedPlans.length}</span>
                <div>{linkedPlans.map((id) => <code key={id} title={id}>{id}</code>)}</div>
              </div>
            )}
          </section>

          <section className="mcp-work-overview" aria-label="Forge Work">
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

  return (
    <main className="main-pane work-pane">
      <div className="content-column">
        <header className="work-hero mcp-work-hero">
          <div className="mcp-work-hero-copy">
            <div className="breadcrumb">项目 / {projection.project?.name ?? '项目'} / {semanticStateLabel(work.semanticState)}</div>
            <h1>{work.title}</h1>
            {work.continuationPrompt && <p>{work.continuationPrompt}</p>}
          </div>
          <div className="work-hero-actions">
            {projection.project && <button type="button" className="work-agent-action"
              onClick={() => onStartAgentForWork?.(projection.project!.repoId, work.workId)}
              disabled={!onStartAgentForWork}>
              在 Agent 中继续
            </button>}
            <button className="plain-action" type="button" disabled={!onRefresh || refreshing} onClick={() => void onRefresh?.()}>
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        </header>

        {refreshError && <div className="inline-error mcp-refresh-error">刷新失败：{refreshError}</div>}

        <div className="work-body-copy">
          <p>{work.objective}</p>
        </div>

        <section className="mcp-summary-grid work-summary-grid" aria-label="Forge Work 操作概览">
          <div className="mcp-summary-card">
            <span>Work</span>
            <strong>{semanticStateLabel(work.semanticState)} · r{work.revision}</strong>
            <small className="mono">{compactId(work.workId)}</small>
          </div>
          <div className="mcp-summary-card">
            <span>Plan</span>
            <strong>{projection.plan ? 'r' + projection.plan.revision : '未绑定'}</strong>
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

        <section id="work-relations" className="work-relations" aria-label="工作关系">
          <div className="relationship-heading"><strong>关联与上下文</strong><span>Forge canonical ID，不推断任务完成率</span></div>
          <div className="work-relation-row">
            <div><span className="relation-type">Requirement</span>
              {work.requirementId ? <button className="record-deep-link" type="button"
                onClick={() => onNavigateRecord?.('requirements', work.requirementId!)}
                title={work.requirementId}>{projection.requirement?.title ?? work.requirementId}</button>
                : <span className="relation-unbound">未绑定</span>}
            </div>
            <div><span className="relation-type">Plan</span>
              {work.planId ? <button className="record-deep-link" type="button"
                onClick={() => onNavigateRecord?.('plans', work.planId!)}
                title={work.planId}>{projection.plan?.goal ?? work.planId}</button>
                : <span className="relation-unbound">未绑定</span>}
            </div>
            <div><span className="relation-type">Work</span><strong>{semanticStateLabel(work.semanticState)} · r{work.revision}</strong></div>
          </div>
          {relatedWorks.length > 0 && (
            <div className="related-work-list">
              <div className="relationship-heading"><strong>相同 Requirement 下的其他 Work</strong><span>{relatedWorks.length} 个可见</span></div>
              {relatedWorks.map((node) => (
                <button className="mcp-work-overview-row" type="button" key={node.workId}
                  disabled={!onSelectWork} onClick={() => onSelectWork?.(node.workId)}>
                  <span className={'work-state-dot ' + node.state} />
                  <span className="mcp-work-overview-copy"><strong>{node.objective}</strong><small>{semanticStateLabel(node.state)}</small></span>
                  <span className="mono mcp-work-id">{compactId(node.workId)}</span>
                </button>
              ))}
            </div>
          )}
          {(work.semanticParentWorkId || work.dependsOnWorkIds.length > 0) && (
            <div className="work-dependencies">
              {work.semanticParentWorkId && <div><span>父 Work</span><code>{work.semanticParentWorkId}</code></div>}
              {work.dependsOnWorkIds.length > 0 && <div><span>依赖 Work</span>
                {work.dependsOnWorkIds.map((id) => <button key={id} type="button"
                  disabled={!onSelectWork || !visibleWorks.some((candidate) => candidate.workId === id)}
                  title={id} onClick={() => onSelectWork?.(id)}>{compactId(id)}</button>)}
              </div>}
            </div>
          )}
          <p className="relation-limit">仅显示本次加载的 Work 和近期历史；未出现不代表没有其他关联记录。</p>
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
          <details id="work-requirement" className="detail-section">
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
          <details id="work-plan" className="detail-section">
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

        <details className="detail-section">
          <summary>结果与证据 {work.resultRefs.length > 0 ? `· ${work.resultRefs.length}` : ''}</summary>
          {work.resultRefs.length > 0 ? (
            <div className="result-list">
              {work.resultRefs.map((resultRef) => <code key={resultRef}>{resultRef}</code>)}
            </div>
          ) : <p className="detail-text">当前还没有结果引用。</p>}
        </details>
      </div>

      <details className="work-service-continuation">
        <summary>通过 Forge 工作流继续此 Work（高级）</summary>
        <p>这是已有 Work 的服务端执行入口，不是本地 Agent 聊天。日常任务建议使用上方“在 Agent 中继续”。</p>
        <div className="composer-wrap">
          <div className="composer">
          <textarea
            aria-label="继续现有 Forge Work"
            placeholder="描述你想推进的工作…"
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
            >{sending ? '提交中…' : '提交到 Forge 工作流'}</button>
          </div>
          </div>
        </div>
      </details>
    </main>
  );
}

function AssistantView({
  projects,
  defaultProjectRepoId,
  newThreadContext,
  onOpenWork,
  onOpenRecord,
  provider,
  providerLoading,
  providerError,
  apiSettings,
  onOpenSettings,
  onOpenProjects,
  onOpenKnowledge,
  newThreadRequested,
  onNewThreadHandled,
  openThreadId,
  onOpenThreadHandled,
  onThreadsChange,
  onRefreshProvider,
  onSendLocal,
  onCancelLocal,
}: {
  projects: ProjectListItemProjection[];
  defaultProjectRepoId?: string;
  newThreadContext?: { repoId: string; workId?: string };
  onOpenWork: (repoId: string, workId: string) => void;
  onOpenRecord: (repoId: string, mode: 'requirements' | 'plans', id: string) => void;
  provider: LocalProviderStatusProjection | null;
  providerLoading: boolean;
  providerError: string | null;
  apiSettings: LocalApiSettings | null;
  onOpenSettings: () => void;
  onOpenProjects: () => void;
  onOpenKnowledge: () => void;
  newThreadRequested: boolean;
  onNewThreadHandled: () => void;
  openThreadId?: string;
  onOpenThreadHandled: () => void;
  onThreadsChange: (items: LocalConversationNavItem[], selectedId?: string, activeRepoId?: string) => void;
  onRefreshProvider: () => Promise<void>;
  onSendLocal: (input: { thread: LocalConversationThread; prompt: string; allowEffects: boolean }) => Promise<LocalConversationReply>;
  onCancelLocal: (thread: LocalConversationThread) => Promise<void>;
}) {
  return (
    <main className="main-pane assistant-pane">
      <div className="content-column assistant-content">
        <LocalConversationSurface
          projects={projects}
          defaultProjectRepoId={defaultProjectRepoId}
          newThreadContext={newThreadContext}
          onOpenWork={onOpenWork}
          onOpenRecord={onOpenRecord}
          provider={provider}
          providerLoading={providerLoading}
          providerError={providerError}
          apiSettings={apiSettings}
          onOpenSettings={onOpenSettings}
          onOpenProjects={onOpenProjects}
          onOpenKnowledge={onOpenKnowledge}
          newThreadRequested={newThreadRequested}
          onNewThreadHandled={onNewThreadHandled}
          openThreadId={openThreadId}
          onOpenThreadHandled={onOpenThreadHandled}
          onThreadsChange={onThreadsChange}
          onRefreshProvider={onRefreshProvider}
          onSend={onSendLocal}
          onCancel={onCancelLocal}
        />
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
            <span className={`health-dot ${connectionError ? 'degraded' : connection?.ready ? 'connected' : connection?.configured ? 'degraded' : 'not_connected'}`} />
            <div>
              <strong>{connectionError ? '连接状态读取失败' : connection?.ready ? '控制器连接已就绪' : connection?.configured ? '控制器连接需要处理' : connectionLoading ? '正在读取连接状态' : '连接尚未配置'}</strong>
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
  const projectLoadRevision = useRef(0);
  const [activeView, setActiveView] = useState<AppView>(preview ? 'project' : 'assistant');
  const [requestedRecord, setRequestedRecord] = useState<{
    mode: 'requirements' | 'plans'; id: string;
  }>();
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
  const [localApiSettings, setLocalApiSettings] = useState<LocalApiSettings | null>(null);
  const [newThreadRequested, setNewThreadRequested] = useState(false);
  const [newThreadContext, setNewThreadContext] = useState<{ repoId: string; workId?: string }>();
  // Read-only sidebar projection; LocalConversationSurface owns the actual threads.
  const [localThreadNav, setLocalThreadNav] = useState<LocalConversationNavItem[]>([]);
  const [selectedLocalThreadId, setSelectedLocalThreadId] = useState<string | undefined>();
  // Read-only projection of the Agent owner's selected thread repository.
  const [activeAgentRepoId, setActiveAgentRepoId] = useState<string | undefined>();
  const [openLocalThreadId, setOpenLocalThreadId] = useState<string | undefined>();
  const [localApiLoading, setLocalApiLoading] = useState(false);
  const [localApiError, setLocalApiError] = useState<string | null>(null);
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

  const refreshLocalApi = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    setLocalApiLoading(true); setLocalApiError(null);
    try { setLocalApiSettings(await readLocalApiSettings()); }
    catch (cause) { setLocalApiError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLocalApiLoading(false); }
  }, [preview]);

  const saveLocalApi = useCallback(async (input: { provider: LocalProviderChoice; endpoint: string; model: string; apiProtocol: 'openai' | 'anthropic'; apiKey?: string }) => {
    setLocalApiSettings(await saveLocalApiSettings(input));
  }, []);

  const clearLocalApi = useCallback(async () => {
    setLocalApiSettings(await clearLocalApiKey());
  }, []);

  const sendLocal = useCallback(async ({ thread, prompt, allowEffects }: { thread: LocalConversationThread; prompt: string; allowEffects: boolean }): Promise<LocalConversationReply> => {
    if (thread.provider === 'api') {
      const messages = thread.messages.filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-40).map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      const reply = await sendLocalApiConversation({
        messages, repoId: thread.projectRepoId, checkoutId: thread.checkoutId, workId: thread.workId,
        conversationId: thread.id, allowEffects,
      });
      return { content: reply.output, toolActivityCount: reply.toolActivityCount, toolEvents: reply.toolEvents };
    }
    const result = await sendLocalConversation({
      conversationId: thread.id,
      providerSessionId: thread.providerSessionId,
      prompt: thread.workId
        ? '[Attached existing Forge Work: ' + thread.workId + '. Retrieve its current Requirement, Plan, and Work state from Forge before deciding actions. Do not create duplicate Work or claim completion without canonical evidence.]\n\n' + prompt
        : prompt,
      repoId: thread.projectRepoId,
    });
    return { content: result.output, providerSessionId: result.providerSessionId, toolActivityCount: result.toolActivityCount };
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
    const revision = ++projectLoadRevision.current;
    setSelectedRepoId(project.repoId);
    setSelectedWorkId(undefined);
    // A stale Work/Requirement from another repository is never displayed
    // while the newly selected project is being fetched.
    setProjection({
      ...disconnectedProjection,
      source: 'runtime',
      projects,
      runtime: {
        status: 'connecting', label: '正在加载项目',
        detail: '正在从 Forge 读取 ' + project.name + ' 的项目记录。',
      },
    });
    try {
      const workspace = await readProjectWorkspace(project, workId);
      if (revision !== projectLoadRevision.current) return;
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前数据来自 Forge Runtime。' },
        projects,
        ...workspace,
      });
    } catch (cause) {
      if (revision !== projectLoadRevision.current) return;
      setProjection({
        ...disconnectedProjection,
        source: 'runtime',
        projects,
        runtime: {
          status: 'degraded', label: '项目详情读取失败',
          detail: project.name + '：' + (cause instanceof Error ? cause.message : String(cause)),
        },
      });
    }
  }, [preview, projects]);

  const bootstrapRuntime = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    const revision = ++projectLoadRevision.current;
    let catalog;
    try {
      catalog = await readProjects();
      if (revision !== projectLoadRevision.current) return;
    } catch (cause) {
      if (revision !== projectLoadRevision.current) return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      setProjection((current) => ({
        ...current,
        runtime: { status: 'degraded', label: '项目目录读取失败', detail },
      }));
      void Promise.all([refreshRecovery(), refreshConnection()]);
      return;
    }
    setProjects(catalog.projects);
    const selectedProject = catalog.projects.find((project) => project.repoId === catalog.preferredRepoId) ?? catalog.projects[0];
    if (!selectedProject) {
      setSelectedRepoId(undefined);
      setSelectedWorkId(undefined);
      setProjection({
        ...disconnectedProjection,
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前没有已注册项目。' },
        projects: [],
      });
      return;
    }
    // The registered catalog has independent authority from the selected Work projection.
    // A single bad/missing checkout must never erase the registered repository list.
    setSelectedRepoId(selectedProject.repoId);
    try {
      const workspace = await readProjectWorkspace(selectedProject);
      if (revision !== projectLoadRevision.current) return;
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前数据来自 Forge Runtime。' },
        projects: catalog.projects,
        ...workspace,
      });
    } catch (cause) {
      if (revision !== projectLoadRevision.current) return;
      setSelectedWorkId(undefined);
      setProjection({
        ...disconnectedProjection,
        source: 'runtime',
        projects: catalog.projects,
        runtime: {
          status: 'degraded',
          label: '项目目录已加载，详情读取失败',
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      });
    }
  }, [preview, refreshConnection, refreshRecovery]);

  useEffect(() => { void bootstrapRuntime(); }, [bootstrapRuntime]);
  useEffect(() => { void refreshLocalProvider(); }, [refreshLocalProvider]);
  useEffect(() => { void refreshLocalApi(); }, [refreshLocalApi]);

  const refreshMcp = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable() || mcpRefreshing) return;
    const revision = ++projectLoadRevision.current;
    setMcpRefreshing(true);
    setMcpRefreshError(null);
    try {
      const catalog = await readProjects();
      if (revision !== projectLoadRevision.current) return;
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
        });
        return;
      }
      const workspace = await readProjectWorkspace(selectedProject, selectedWorkId);
      if (revision !== projectLoadRevision.current) return;
      setSelectedRepoId(selectedProject.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '刚刚从 Forge Runtime 重新读取。' },
        projects: catalog.projects,
        ...workspace,
      });
    } catch (cause) {
      if (revision === projectLoadRevision.current) {
        setMcpRefreshError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setMcpRefreshing(false);
    }
  }, [mcpRefreshing, preview, selectedRepoId, selectedWorkId]);

  const handleSelectProject = useCallback(async (project: ProjectListItemProjection) => {
    setRequestedRecord(undefined);
    // Project selection from any page changes the next Agent context;
    // established transcripts retain their original repository identity.
    if (activeAgentRepoId !== project.repoId) {
      setNewThreadContext({ repoId: project.repoId });
      setNewThreadRequested(true);
    }
    if (activeView === 'project') setActiveView('works');
    await loadProject(project);
  }, [activeView, activeAgentRepoId, loadProject]);

  const handleSelectWork = useCallback(async (workId: string) => {
    const project = projects.find((candidate) => candidate.repoId === selectedRepoId);
    if (!project) return;
    setActiveView('project');
    await loadProject(project, workId);
  }, [loadProject, projects, selectedRepoId]);

  const handleContinue = useCallback(async (prompt: string) => {
    if (!projection.project || !projection.work) return;
    const selectedProject = projects.find((candidate) => candidate.repoId === projection.project?.repoId);
    if (!selectedProject) throw new Error('当前项目已经不在项目列表中，请重新选择项目。');
    await continueWork(projection.project.repoId, projection.work.workId, prompt);
    await loadProject(selectedProject, projection.work.workId);
  }, [loadProject, projection, projects]);

  const handleLocalThreadNavigation = useCallback((
    threads: LocalConversationNavItem[], selectedId?: string, activeRepoId?: string,
  ) => {
    setLocalThreadNav(threads);
    setSelectedLocalThreadId(selectedId);
    setActiveAgentRepoId(activeRepoId);
  }, []);
  const handleSelectLocalThread = useCallback((id: string) => {
    setOpenLocalThreadId(id);
    setActiveView('assistant');
  }, []);
  const handleOpenThreadHandled = useCallback(() => setOpenLocalThreadId(undefined), []);

  const handleOpenAssistant = useCallback(() => {
    setActiveView('assistant');
  }, []);
  const handleNewThread = useCallback(() => {
    // Outside Agent, inherit the browsed project. Inside Agent, inherit the
    // active conversation's repository, not a stale project detail panel.
    const repoId = activeView === 'assistant'
      ? activeAgentRepoId ?? selectedRepoId : selectedRepoId ?? activeAgentRepoId;
    setNewThreadContext(repoId ? { repoId } : undefined);
    setActiveView('assistant');
    setNewThreadRequested(true);
  }, [activeView, activeAgentRepoId, selectedRepoId]);
  const handleNewThreadHandled = useCallback(() => {
    setNewThreadRequested(false);
    setNewThreadContext(undefined);
  }, []);
  const handleStartAgentForWork = useCallback((repoId: string, workId: string) => {
    setNewThreadContext({ repoId, workId });
    setActiveView('assistant');
    setNewThreadRequested(true);
  }, []);

  const openProjectSection = useCallback((section: 'works' | 'requirements' | 'plans' | 'knowledge') => {
    // When leaving Agent for project assets, browse the Agent's actual repo,
    // not a different workspace that happened to be loaded earlier.
    if (activeView === 'assistant' && activeAgentRepoId && activeAgentRepoId !== selectedRepoId) {
      const project = projects.find((entry) => entry.repoId === activeAgentRepoId);
      if (project) void loadProject(project);
    }
    setRequestedRecord(undefined);
    setActiveView(section);
  }, [activeView, activeAgentRepoId, selectedRepoId, projects, loadProject]);
  const handleOpenProjects = useCallback(() => openProjectSection('works'), [openProjectSection]);
  const handleOpenRequirements = useCallback(() => openProjectSection('requirements'), [openProjectSection]);
  const handleOpenPlans = useCallback(() => openProjectSection('plans'), [openProjectSection]);
  const handleNavigateRecord = useCallback((mode: 'requirements' | 'plans', id: string) => {
    setRequestedRecord({ mode, id });
    setActiveView(mode);
  }, []);
  const handleOpenWorkFromAgent = useCallback(async (repoId: string, workId: string) => {
    const project = projects.find((entry) => entry.repoId === repoId);
    if (!project) return;
    await loadProject(project, workId);
    setActiveView('project');
  }, [loadProject, projects]);
  const handleOpenRecordFromAgent = useCallback(async (
    repoId: string, mode: 'requirements' | 'plans', id: string,
  ) => {
    const project = projects.find((entry) => entry.repoId === repoId);
    if (!project) return;
    await loadProject(project);
    setRequestedRecord({ mode, id });
    setActiveView(mode);
  }, [loadProject, projects]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        handleNewThread();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleNewThread]);

  const handleOpenKnowledge = useCallback(() => openProjectSection('knowledge'), [openProjectSection]);
  const handleOpenSettings = useCallback(() => setActiveView('settings'), []);

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
        selectedRepoId={activeView === 'assistant' ? activeAgentRepoId : selectedRepoId}
        activeView={activeView}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        runtimeDetail={projection.runtime.detail}
        onRetryProjects={() => { void bootstrapRuntime(); }}
        onOpenAssistant={handleOpenAssistant}
        onNewThread={handleNewThread}
        onOpenProjects={handleOpenProjects}
        onOpenRequirements={handleOpenRequirements}
        onOpenPlans={handleOpenPlans}
        onOpenKnowledge={handleOpenKnowledge}
        onOpenSettings={handleOpenSettings}
        onSelectProject={preview ? undefined : handleSelectProject}
        localThreads={localThreadNav}
        selectedLocalThreadId={selectedLocalThreadId}
        onSelectLocalThread={handleSelectLocalThread}
        onOpenRuntime={preview ? undefined : handleOpenRuntime}
      />

      <div className="workspace-region">
        <header className="workspace-topbar">
          <div className="workspace-topbar-title" data-tauri-drag-region>
            <strong>{activeView === 'assistant' ? '本地会话'
              : activeView === 'project' ? projection.work?.title ?? 'Work 详情'
              : activeView === 'requirements' ? 'Requirements'
              : activeView === 'plans' ? 'Plans'
              : activeView === 'works' ? 'Works'
              : activeView === 'knowledge' ? '记忆与知识'
              : activeView === 'settings' ? '设置' : '运行时与恢复'}</strong>
            {activeView === 'project' && projection.project?.branch && <span className="workspace-topbar-branch">{projection.project.branch}</span>}
          </div>
          <button className="workspace-topbar-health" type="button" onClick={() => void handleOpenRuntime()} title="查看 Forge Runtime 与连接状态">
            <span className={'health-dot ' + runtimeStatus} aria-hidden="true" />
            <span>{runtimeLabel}</span>
          </button>
        </header>

      {/* Keep the one transcript owner mounted while viewing independent
          Requirement/Plan/Work assets. In-flight Agent replies must not vanish
          when the user navigates away from the conversation. */}
      <div className="agent-view-preserved" hidden={activeView !== 'assistant'}>
        <AssistantView
          projects={projects}
          defaultProjectRepoId={activeAgentRepoId ?? selectedRepoId}
          newThreadContext={newThreadContext}
          onOpenWork={(repoId, workId) => { void handleOpenWorkFromAgent(repoId, workId); }}
          onOpenRecord={(repoId, mode, id) => { void handleOpenRecordFromAgent(repoId, mode, id); }}
          provider={localProvider}
          providerLoading={localProviderLoading}
          providerError={localProviderError}
          apiSettings={localApiSettings}
          onOpenSettings={handleOpenSettings}
          onOpenProjects={handleOpenProjects}
          onOpenKnowledge={handleOpenKnowledge}
          newThreadRequested={newThreadRequested}
          onNewThreadHandled={handleNewThreadHandled}
          openThreadId={openLocalThreadId}
          onOpenThreadHandled={handleOpenThreadHandled}
          onThreadsChange={handleLocalThreadNavigation}
          onRefreshProvider={refreshLocalProvider}
          onSendLocal={sendLocal}
          onCancelLocal={async (thread) => {
            if (thread.provider === 'api') await cancelLocalApiConversation(thread.id);
            else await cancelLocalConversation(thread.id);
          }}
        />
      </div>
      {activeView === 'assistant' ? null : activeView === 'requirements' || activeView === 'plans' || activeView === 'works' ? (
        <ProjectRecordsView key={(selectedRepoId ?? 'none') + ':' + activeView}
          mode={activeView} projection={projection}
          requestedRecordId={requestedRecord?.mode === activeView ? requestedRecord.id : undefined}
          onNavigateRecord={handleNavigateRecord}
          onSelectWork={(workId) => { void handleSelectWork(workId); }}
          onRefresh={refreshMcp} />
      ) : activeView === 'knowledge' ? (
        <KnowledgeView repoId={selectedRepoId ?? projects[0]?.repoId}
          workId={selectedWorkId} projectName={projects.find((project) => project.repoId === (selectedRepoId ?? projects[0]?.repoId))?.name} />
      ) : activeView === 'settings' ? (
        <SettingsView settings={localApiSettings} loading={localApiLoading} error={localApiError}
          onRefresh={refreshLocalApi} onSave={saveLocalApi} onClearKey={clearLocalApi}
          codexStatus={localProvider} codexError={localProviderError} />
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
          refreshing={mcpRefreshing}
          refreshError={mcpRefreshError}
          onRefresh={preview ? undefined : refreshMcp}
          onContinue={preview ? undefined : handleContinue}
          onNavigateRecord={handleNavigateRecord}
          onStartAgentForWork={handleStartAgentForWork}
          onSelectWork={preview ? undefined : (workId) => { void handleSelectWork(workId); }}
        />
      )}
      </div>
    </div>
  );
}
