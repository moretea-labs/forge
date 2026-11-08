import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  designPreviewProjection,
  disconnectedProjection,
  type ControllerConnectionProjection,
  type ForgeDesktopProjection,
  type ProjectListItemProjection,
  type RuntimeRecoveryProjection,
} from './runtime-projection';
import {
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
import { desktopThemeStyle } from './design-tokens';
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

type AppView = 'assistant' | 'project' | 'requirements' | 'plans' | 'knowledge' | 'settings' | 'runtime';

export function sidebarToggleShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && event.key.toLowerCase() === 'b';
}

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

export function Sidebar({
  projects,
  selectedRepoId,
  activeView,
  runtimeLabel,
  runtimeStatus,
  runtimeDetail,
  onRetryProjects,
  onOpenAssistant,
  onNewThread,
  onNewProjectThread,
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
  onNewProjectThread: (repoId: string) => void;
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
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  // Accessibility and keyboard routing do not necessarily emit outside pointer
  // events; dismiss the project selector when leaving the current view.
  useEffect(() => {
    setShowProjectPicker(false);
    setProjectQuery('');
  }, [activeView]);
  const shownThreads = conversationSearchOpen
    ? localThreads.filter((thread) => {
      const project = projects.find((entry) => entry.repoId === thread.projectRepoId);
      return (thread.title + ' ' + (project?.repository ?? '') + ' ' + (project?.name ?? ''))
        .toLocaleLowerCase().includes(conversationQuery.trim().toLocaleLowerCase());
    })
    : localThreads;
  // One read-only grouping of the existing conversation index. The repository
  // and repository context remain owned by Forge and each individual Agent thread.
  const conversationGroups = new Map<string, LocalConversationNavItem[]>();
  for (const thread of shownThreads) {
    const repoId = thread.projectRepoId ?? '';
    const group = conversationGroups.get(repoId) ?? [];
    group.push(thread);
    conversationGroups.set(repoId, group);
  }

  useEffect(() => {
    if (conversationSearchOpen) conversationSearchRef.current?.focus();
  }, [conversationSearchOpen]);
  useEffect(() => {
    const onSearchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
        && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setConversationSearchOpen(true);
      } else if (event.key === 'Escape' && conversationSearchOpen
        && event.target instanceof Element && event.target.closest('.sidebar-conversations')) {
        event.preventDefault();
        setConversationSearchOpen(false);
        setConversationQuery('');
      }
    };
    window.addEventListener('keydown', onSearchShortcut);
    return () => window.removeEventListener('keydown', onSearchShortcut);
  }, [conversationSearchOpen]);
  const activeProject = projects.find((project) => project.repoId === selectedRepoId);
  const matchingProjects = projects.filter((project) =>
    (project.name + ' ' + project.repository + ' ' + (project.localRoot ?? ''))
      .toLowerCase().includes(projectQuery.toLowerCase().trim()));
  return (
    <aside id="forge-sidebar" className="sidebar">
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
          <button className={activeView === 'assistant' ? 'nav-row active' : 'nav-row'} type="button"
            aria-current={activeView === 'assistant' ? 'page' : undefined} onClick={onOpenAssistant}>
            <span className="nav-symbol"><ForgeIcon name="conversations" /></span><span className="nav-label">会话</span>
          </button>
          <button className={activeView === 'project' ? 'nav-row active' : 'nav-row'} type="button"
            aria-current={activeView === 'project' ? 'page' : undefined} onClick={onOpenProjects}>
            <span className="nav-symbol"><ForgeIcon name="project" /></span><span className="nav-label">Project · 项目</span>
          </button>
          <button className={activeView === 'requirements' ? 'nav-row active' : 'nav-row'} type="button"
            aria-current={activeView === 'requirements' ? 'page' : undefined} onClick={onOpenRequirements}>
            <span className="nav-symbol"><ForgeIcon name="requirement" /></span><span className="nav-label">Requirement · 需求</span>
          </button>
          <button className={activeView === 'plans' ? 'nav-row active' : 'nav-row'} type="button"
            aria-current={activeView === 'plans' ? 'page' : undefined} onClick={onOpenPlans}>
            <span className="nav-symbol"><ForgeIcon name="plan" /></span><span className="nav-label">Plan · 计划</span>
          </button>
          <button className={activeView === 'knowledge' ? 'nav-row active' : 'nav-row'} type="button"
            aria-current={activeView === 'knowledge' ? 'page' : undefined} onClick={onOpenKnowledge}>
            <span className="nav-symbol"><ForgeIcon name="knowledge" /></span><span className="nav-label">记忆与知识</span>
          </button>
        </nav>
        {(localThreads.length > 0 || conversationSearchOpen) && (
          <section className="sidebar-conversations" aria-label="最近会话">
            <div className="sidebar-conversation-heading">
              <div className="sidebar-section-title">最近会话</div>
              <button type="button" className="sidebar-search-toggle"
                aria-label={conversationSearchOpen ? '关闭会话搜索' : '搜索会话'}
                aria-expanded={conversationSearchOpen} aria-keyshortcuts="Meta+K Control+K"
                title="搜索会话 (⌘K)"
                onClick={() => {
                  setConversationSearchOpen((open) => !open);
                  if (conversationSearchOpen) setConversationQuery('');
                }}>
                <ForgeIcon name={conversationSearchOpen ? 'close' : 'search'} size={15} />
              </button>
            </div>
            {conversationSearchOpen && (
              <input ref={conversationSearchRef} className="sidebar-conversation-search"
                type="search" aria-label="搜索会话标题" placeholder="搜索全部会话…"
                value={conversationQuery} onChange={(event) => setConversationQuery(event.target.value)} />
            )}
            {[...conversationGroups].map(([repoId, items]) => {
              const project = projects.find((entry) => entry.repoId === repoId);
              const projectName = project?.repository.split('/').at(-1) ?? (repoId ? '历史项目' : '独立会话');
              return <div className="sidebar-project-conversations" key={repoId || 'unbound'}>
                <div className="sidebar-thread-project-heading">
                  <span title={project?.repository ?? (repoId || '未绑定仓库')}>
                    <ForgeIcon name={repoId ? 'project' : 'conversation'} size={13} />
                    {projectName}
                  </span>
                  {repoId && project && <button type="button"
                    aria-label={`在 ${projectName} 中新建会话`}
                    title={`在 ${projectName} 中新建会话`}
                    onClick={() => onNewProjectThread(repoId)}>
                    <ForgeIcon name="plus" size={14} />
                  </button>}
                </div>
                {items.map((thread) => (
                  <button type="button" key={thread.id}
                    className={'nav-row sidebar-thread-row'
                      + (activeView === 'assistant' && selectedLocalThreadId === thread.id ? ' active' : '')}
                    aria-current={activeView === 'assistant' && selectedLocalThreadId === thread.id ? 'page' : undefined}
                    title={thread.title + ' · ' + (thread.provider === 'api' ? '兼容 API' : 'Codex CLI')} onClick={() => {
                      onSelectLocalThread(thread.id);
                      setConversationSearchOpen(false);
                      setConversationQuery('');
                    }}>
                    <span className="nav-symbol"><ForgeIcon name={thread.draft ? 'draft' : 'conversation'} /></span>
                    <span className="nav-label">{thread.title}</span>
                    {thread.running && <span className="sidebar-turn-running" role="status" title="Agent 运行中" />}
                    {thread.provider === 'api' && <span className="sidebar-thread-provider" title="兼容 API 会话">API</span>}
                    {thread.draft && <span className="sidebar-draft-indicator">草稿</span>}
                  </button>
                ))}
              </div>;
            })}
            {conversationSearchOpen && shownThreads.length === 0 && (
              <p className="sidebar-search-empty" role="status">没有匹配的会话</p>
            )}
          </section>
        )}
        <div className="sidebar-project-popover">
          <Popover.Root open={showProjectPicker} onOpenChange={(open) => {
            setShowProjectPicker(open);
            if (!open) setProjectQuery('');
          }}>
            <div className="sidebar-project-heading">
              <Popover.Trigger asChild>
                <button className="sidebar-project-picker" type="button"
                  title={activeProject?.localRoot ?? activeProject?.repository ?? '选择已注册项目'}>
                  <span className="project-folder"><ForgeIcon name="project" /></span>
                  <span className="project-picker-identity">
                    <span className="nav-label">{activeProject?.repository.split('/').at(-1) ?? '选择项目'}</span>
                    {activeProject?.repository && <small title={activeProject.localRoot ?? activeProject.repository}>
                      {activeProject.name} · {activeProject.repository}
                    </small>}
                  </span>
                  <span className={'project-caret' + (showProjectPicker ? ' expanded' : '')}><ForgeIcon name="chevron" size={15} /></span>
                </button>
              </Popover.Trigger>
              <button type="button" title="刷新已注册项目" aria-label="刷新已注册项目" onClick={onRetryProjects}><ForgeIcon name="refresh" size={16} /></button>
            </div>
            <Popover.Portal>
              <Popover.Content className="sidebar-project-picker-panel" style={desktopThemeStyle} aria-label="选择项目"
                side="top" align="start" sideOffset={8} collisionPadding={12}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  projectSearchRef.current?.focus({ preventScroll: true });
                }}>
                <input ref={projectSearchRef} aria-label="搜索已注册项目" placeholder={'搜索 ' + projects.length + ' 个项目'}
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
                    <div className="sidebar-picker-project-row" key={project.repoId}>
                      <button className={project.repoId === selectedRepoId ? 'nav-row project-row active' : 'nav-row project-row'}
                        type="button" title={project.localRoot ?? project.repository}
                        onClick={() => {
                          onSelectProject?.(project);
                          setShowProjectPicker(false);
                          setProjectQuery('');
                        }}>
                        <span className="project-folder"><ForgeIcon name="project" /></span>
                        <span className="project-picker-identity">
                          <span className="nav-label">{project.repository.split('/').at(-1) ?? project.name}</span>
                          <small>{project.name} · {project.repository}</small>
                        </span>
                      </button>
                      <button className="sidebar-picker-project-agent" type="button"
                        aria-label={`在 ${project.repository} 中新建 Agent 会话`}
                        title="新建此项目的 Agent 会话"
                        onClick={() => {
                          onNewProjectThread(project.repoId);
                          setShowProjectPicker(false);
                          setProjectQuery('');
                        }}>
                        <ForgeIcon name="plus" size={16} />
                      </button>
                    </div>
                  ))}
                  {projects.length > 0 && matchingProjects.length === 0 && <p className="sidebar-project-error">未找到匹配项目</p>}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>

      <div className="sidebar-footer">
        <button className={activeView === 'settings' ? 'nav-row active' : 'nav-row'} type="button"
          aria-current={activeView === 'settings' ? 'page' : undefined} onClick={onOpenSettings}>
          <span className="nav-symbol"><ForgeIcon name="settings" /></span><span className="nav-label">设置</span>
        </button>
        <button className={activeView === 'runtime' ? 'nav-row active' : 'nav-row'} type="button"
          aria-current={activeView === 'runtime' ? 'page' : undefined} onClick={onOpenRuntime}>
          <span className="nav-symbol"><ForgeIcon name="runtime" /></span>
          <span className="nav-label">MCP 服务与运行时</span>
          <span className={`health-dot ${runtimeStatus}`} />
          <span className="runtime-mini-label">{runtimeLabel}</span>
        </button>
      </div>
    </aside>
  );
}

function ProjectView({
  projection,
  refreshing,
  refreshError,
  onRefresh,
  onOpenRequirements,
  onOpenPlans,
}: {
  projection: ForgeDesktopProjection;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh?: () => Promise<void>;
  onOpenRequirements: () => void;
  onOpenPlans: () => void;
}) {
  const project = projection.project;
  return (
    <main className="main-pane mcp-detail-pane">
      <div className="content-column">
        <header className="mcp-detail-header">
          <div>
            <div className="breadcrumb">Forge / Project</div>
            <h1>{project?.name ?? '项目'}</h1>
            <p>{project?.repository ?? projection.runtime.detail}</p>
          </div>
          {onRefresh && <button className="plain-action" type="button" disabled={refreshing}
            onClick={() => void onRefresh()}>{refreshing ? '刷新中…' : '刷新'}</button>}
        </header>
        {refreshError && <p role="alert" className="inline-error">{refreshError}</p>}
        {!project ? (
          <div className="records-empty" role="status">
            {projection.runtime.status === 'connecting' || projection.runtime.status === 'degraded'
              ? projection.runtime.detail : '从左侧选择已注册项目。'}
          </div>
        ) : (
          <>
            <section className="mcp-summary-grid" aria-label="项目摘要">
              <div className="mcp-summary-card">
                <span>Repository</span><strong>{project.repository}</strong><small>{project.branch}</small>
              </div>
              <div className="mcp-summary-card">
                <span>Checkout</span><strong>{project.worktree}</strong><small className="mono">{compactId(project.checkoutId)}</small>
              </div>
              <div className="mcp-summary-card">
                <span>Source</span><strong>{project.dirty ? '有未提交变更' : '工作区干净'}</strong>
                <small className="mono">{compactId(project.sourceRevision)}</small>
              </div>
              <div className="mcp-summary-card">
                <span>UserRequest</span><strong>{projection.userRequests.length}</strong><small>待用户处理</small>
              </div>
            </section>
            <section className="detail-section project-record-entry">
              <h2>语义记录</h2>
              <p>Requirement 记录目标与验收；Plan 记录可替换的实施方案。执行结果由 Git、Run、Job、Process 与 Check 各自持有。</p>
              <div className="record-related-plans">
                <button type="button" className="record-work-link" onClick={onOpenRequirements}>
                  <span className="record-plan-icon"><ForgeIcon name="requirement" size={16} /></span>
                  <span>Requirements</span><small>验收语义</small>
                </button>
                <button type="button" className="record-work-link" onClick={onOpenPlans}>
                  <span className="record-plan-icon"><ForgeIcon name="plan" size={16} /></span>
                  <span>Plans</span><small>实施方案</small>
                </button>
              </div>
            </section>
            <details className="detail-section" open>
              <summary>Git Checkout · {project.activeCheckoutCount}/{project.checkoutCount} active</summary>
              <div className="relation-grid">
                {project.checkouts.map((entry) => (
                  <div key={entry.checkoutId}>
                    <span>{entry.active ? '当前' : entry.kind === 'worktree' ? 'Worktree' : 'Checkout'}</span>
                    <strong>{entry.branch ?? 'Detached HEAD'}</strong>
                    <small className="mono">{compactId(entry.checkoutId)}</small>
                  </div>
                ))}
              </div>
            </details>
            {projection.userRequests.length > 0 && (
              <section className="detail-section">
                <h2>需要用户处理</h2>
                <div className="handoff-list">
                  {projection.userRequests.map((request) => (
                    <article key={request.requestId} className="handoff-card">
                      <div><strong>{request.title}</strong><p>{request.summary}</p></div>
                      <small>{formatTimestamp(request.updatedAt)}</small>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function AssistantView({
  projects,
  defaultProjectRepoId,
  newThreadContext,
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
  newThreadContext?: { repoId: string };
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

export function RuntimeView({
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
  onOpenSettings,
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
  onOpenSettings: () => void;
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
          <div className="breadcrumb">Forge / 连接</div>
          <h1>MCP 服务与连接</h1>
          <p>外部 ChatGPT/MCP 服务使用 Forge 的现有控制器连接；本地 Codex 或 API 模型独立配置。</p>
        </header>
        <div className="runtime-mode-note">
          <ForgeIcon name="runtime" size={18} />
          <span>这是服务状态与连接管理，不是第二个 Agent 或项目执行环境。</span>
          <button type="button" className="plain-action" onClick={onOpenSettings}>Agent 设置</button>
        </div>

        {error && <div className="inline-error standalone-error">{error}</div>}

        <div className="runtime-connectivity">
        <section className="runtime-summary runtime-connection-card">
          <div className="runtime-card-kicker"><ForgeIcon name="terminal" size={16} /> 本地运行时</div>
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
          </div>
          <details className="runtime-advanced-actions">
            <summary>高级维护操作</summary>
            <p>可能中断当前 Agent 会话或改变运行时状态，仅在明确需要时操作。</p>
            <button className="plain-action" type="button" disabled={disabled} onClick={() => void onRestart()}>
              {action === 'restart' ? restartPendingLabel : restartLabel}
            </button>
            {!runtimeReady && projection?.recovery.available && (
              <button className="plain-action" type="button" disabled={disabled} onClick={() => void onRecover()}>
                {action === 'recover' ? '恢复中…' : '深度恢复'}
              </button>
            )}
          </details>
        </section>

        {connectionError && <div className="inline-error standalone-error">连接读取失败：{connectionError}</div>}

        <section className="runtime-summary runtime-connection-card" aria-label="Forge 连接">
          <div className="runtime-card-kicker"><ForgeIcon name="runtime" size={16} /> MCP / 控制器连接</div>
          <div className="runtime-primary-row">
            <span className={`health-dot ${connectionError ? 'degraded' : connection?.ready ? 'connected' : connection?.configured ? 'degraded' : 'not_connected'}`} />
            <div>
              <strong>{connectionError ? '连接状态读取失败' : connection?.ready ? 'MCP 连接已就绪' : connection?.configured
                ? connection.controller.ready ? '远程传输需要处理' : '控制器配置需要处理'
                : connectionLoading ? '正在读取连接状态' : '连接尚未配置'}</strong>
              <p>{connection && !connection.controller.ready ? connection.controller.detail
                : connection && !connection.tunnel.ready ? connection.tunnel.detail
                : connection?.controller.detail ?? '连接状态来自 Forge setup authority；客户端不保存配置副本。'}</p>
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
        </div>

        {connection && (
          <details className="detail-section">
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

        <details className="detail-section">
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
          <details className="detail-section">
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

/** Only context for the model, never repository or checkout authorization.
 * Forge tools remain the authority for exact target verification and effects. */
export function codexBoundPrompt(thread: LocalConversationThread, prompt: string): string {
  const notes: string[] = [];
  if (thread.projectRepoId) {
    notes.push('[Forge Desktop conversation context: selected repo_id='
      + thread.projectRepoId + '; selected checkout_id=' + (thread.checkoutId ?? 'unbound')
      + '. Codex runs in an isolated temporary directory, not this checkout. '
      + 'Use Forge MCP capabilities to inspect the registered repository and its checkout. '
      + 'Before any effect verify that the exact repo_id AND checkout_id are supported by the chosen tool. '
      + 'If a tool cannot target the selected checkout, do not mutate or run a repository command. '
      + 'Never treat the temporary process directory as this project.]');
  }
  return notes.length ? notes.join('\n') + '\n\n' + prompt : prompt;
}

export function App() {
  const preview = useMemo(previewEnabled, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('forge.desktop.sidebar-collapsed.v1') === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('forge.desktop.sidebar-collapsed.v1', String(sidebarCollapsed)); }
    catch { /* Browser preview may not permit storage; the toggle still works. */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!sidebarToggleShortcut(event)) return;
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const [projection, setProjection] = useState<ForgeDesktopProjection>(preview ? designPreviewProjection : disconnectedProjection);
  const [projects, setProjects] = useState<ProjectListItemProjection[]>(preview ? [...designPreviewProjection.projects] : []);
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(preview ? designPreviewProjection.project?.repoId : undefined);
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
  const [newThreadContext, setNewThreadContext] = useState<{ repoId: string }>();
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

  const saveLocalApi = useCallback(async (input: { provider: LocalProviderChoice; endpoint: string; model: string; apiProtocol: 'openai' | 'anthropic'; apiKey?: string; joyCodeModel?: string }) => {
    setLocalApiSettings(await saveLocalApiSettings(input));
  }, []);

  const clearLocalApi = useCallback(async () => {
    setLocalApiSettings(await clearLocalApiKey());
  }, []);

  const sendLocal = useCallback(async ({ thread, prompt, allowEffects }: { thread: LocalConversationThread; prompt: string; allowEffects: boolean }): Promise<LocalConversationReply> => {
    if (thread.provider === 'api' || thread.provider === 'joycode') {
      const messages = thread.messages.filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-40).map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      const reply = await sendLocalApiConversation({
        messages, repoId: thread.projectRepoId, checkoutId: thread.checkoutId,
        conversationId: thread.id, provider: thread.provider, allowEffects,
      });
      return { content: reply.output, toolActivityCount: reply.toolActivityCount, toolEvents: reply.toolEvents };
    }
    const result = await sendLocalConversation({
      conversationId: thread.id,
      providerSessionId: thread.providerSessionId,
      prompt: codexBoundPrompt(thread, prompt),
      repoId: thread.projectRepoId,
      checkoutId: thread.checkoutId,
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

  const loadProject = useCallback(async (project: ProjectListItemProjection) => {
    if (preview || !tauriRuntimeAvailable()) return;
    const revision = ++projectLoadRevision.current;
    setSelectedRepoId(project.repoId);
    setProjection({
      ...disconnectedProjection,
      source: 'runtime',
      projects,
      runtime: {
        status: 'connecting', label: '正在加载项目',
        detail: '正在从 Forge 读取 ' + project.name + ' 的项目事实。',
      },
    });
    try {
      const workspace = await readProjectWorkspace(project);
      if (revision !== projectLoadRevision.current) return;
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
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '当前数据来自 Forge Runtime。' },
        projects: catalog.projects,
        ...workspace,
      });
    } catch (cause) {
      if (revision !== projectLoadRevision.current) return;
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
        setProjection({
          ...disconnectedProjection,
          source: 'runtime',
          runtime: { status: 'connected', label: '运行时已连接', detail: '当前没有已注册项目。' },
          projects: [],
        });
        return;
      }
      const workspace = await readProjectWorkspace(selectedProject);
      if (revision !== projectLoadRevision.current) return;
      setSelectedRepoId(selectedProject.repoId);
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
  }, [mcpRefreshing, preview, selectedRepoId]);

  const handleSelectProject = useCallback(async (project: ProjectListItemProjection) => {
    setRequestedRecord(undefined);
    // Project selection from any page changes the next Agent context;
    // established transcripts retain their original repository identity.
    if (activeAgentRepoId !== project.repoId) {
      setNewThreadContext({ repoId: project.repoId });
      setNewThreadRequested(true);
    }
    setActiveView('project');
    await loadProject(project);
  }, [activeAgentRepoId, loadProject]);

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
  const handleNewProjectThread = useCallback((repoId: string) => {
    if (!projects.some((project) => project.repoId === repoId)) return;
    setNewThreadContext({ repoId });
    setActiveView('assistant');
    setNewThreadRequested(true);
  }, [projects]);
  const handleNewThreadHandled = useCallback(() => {
    setNewThreadRequested(false);
    setNewThreadContext(undefined);
  }, []);
  const openProjectSection = useCallback((section: 'project' | 'requirements' | 'plans' | 'knowledge') => {
    // When leaving Agent for project assets, browse the Agent's actual repo,
    // not a different workspace that happened to be loaded earlier.
    if (activeView === 'assistant' && activeAgentRepoId && activeAgentRepoId !== selectedRepoId) {
      const project = projects.find((entry) => entry.repoId === activeAgentRepoId);
      if (project) void loadProject(project);
    }
    setRequestedRecord(undefined);
    setActiveView(section);
  }, [activeView, activeAgentRepoId, selectedRepoId, projects, loadProject]);
  const handleOpenProjects = useCallback(() => openProjectSection('project'), [openProjectSection]);
  const handleOpenRequirements = useCallback(() => openProjectSection('requirements'), [openProjectSection]);
  const handleOpenPlans = useCallback(() => openProjectSection('plans'), [openProjectSection]);
  const handleNavigateRecord = useCallback((mode: 'requirements' | 'plans', id: string) => {
    setRequestedRecord({ mode, id });
    setActiveView(mode);
  }, []);
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
  const handleOpenSettings = useCallback(() => {
    setActiveView('settings');
    // A settings visit reads current connection/provider state from the existing
    // authorities; it never copies or changes their configuration.
    void Promise.all([refreshLocalProvider(), refreshConnection()]);
  }, [refreshLocalProvider, refreshConnection]);

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
    <div className={'app-shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')} style={desktopThemeStyle}>
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
        onNewProjectThread={handleNewProjectThread}
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
          <button className="workspace-sidebar-toggle" type="button"
            aria-controls="forge-sidebar" aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'}
            title={sidebarCollapsed ? '显示侧栏 (⌘B)' : '隐藏侧栏 (⌘B)'}
            onClick={() => setSidebarCollapsed((current) => !current)}>
            <ForgeIcon name={sidebarCollapsed ? 'sidebar-show' : 'sidebar-hide'} size={18} />
          </button>
          <div className="workspace-topbar-title" data-tauri-drag-region>
            <strong>{activeView === 'assistant' ? '本地会话'
              : activeView === 'project' ? '项目'
              : activeView === 'requirements' ? 'Requirements'
              : activeView === 'plans' ? 'Plans'
              : activeView === 'knowledge' ? '记忆与知识'
              : activeView === 'settings' ? '设置' : 'MCP 服务与连接'}</strong>
            {activeView === 'project' && projection.project?.branch && <span className="workspace-topbar-branch">{projection.project.branch}</span>}
          </div>
          <button className="workspace-topbar-health" type="button" onClick={() => void handleOpenRuntime()} title="查看 Forge Runtime 与连接状态">
            <span className={'health-dot ' + runtimeStatus} aria-hidden="true" />
            <span>{runtimeLabel}</span>
          </button>
        </header>

      {/* Keep the one transcript owner mounted while viewing independent
          project semantic assets. In-flight Agent replies must not vanish
          when the user navigates away from the conversation. */}
      <div className="agent-view-preserved" hidden={activeView !== 'assistant'}>
        <AssistantView
          projects={projects}
          defaultProjectRepoId={activeAgentRepoId ?? selectedRepoId}
          newThreadContext={newThreadContext}
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
      {activeView === 'assistant' ? null : activeView === 'requirements' || activeView === 'plans' ? (
        <ProjectRecordsView key={(selectedRepoId ?? 'none') + ':' + activeView}
          mode={activeView} projection={projection}
          requestedRecordId={requestedRecord?.mode === activeView ? requestedRecord.id : undefined}
          onNavigateRecord={handleNavigateRecord}
          onRefresh={refreshMcp} />
      ) : activeView === 'knowledge' ? (
        <KnowledgeView repoId={selectedRepoId ?? projects[0]?.repoId}
          projectName={projects.find((project) => project.repoId === (selectedRepoId ?? projects[0]?.repoId))?.name} />
      ) : activeView === 'settings' ? (
        <SettingsView settings={localApiSettings} loading={localApiLoading} error={localApiError}
          onRefresh={refreshLocalApi} onSave={saveLocalApi} onClearKey={clearLocalApi}
          codexStatus={localProvider} codexError={localProviderError}
          onRefreshCodex={refreshLocalProvider}
          onOpenMcp={() => { void handleOpenRuntime(); }}
          mcpReady={connectionProjection?.ready ?? null} />
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
          onOpenSettings={handleOpenSettings}
        />
      ) : (
        <ProjectView
          projection={projection}
          refreshing={mcpRefreshing}
          refreshError={mcpRefreshError}
          onRefresh={preview ? undefined : refreshMcp}
          onOpenRequirements={handleOpenRequirements}
          onOpenPlans={handleOpenPlans}
        />
      )}
      </div>
    </div>
  );
}
