import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  designPreviewProjection,
  disconnectedProjection,
  type AutomaticContinuationTaskProjection,
  type ForgeDesktopProjection,
  type ProjectListItemProjection,
  type RuntimeRecoveryProjection,
  type WorkGraphNodeProjection,
  type WorkSemanticState,
} from './runtime-projection';
import {
  continueWork,
  readAutomaticContinuations,
  readProjects,
  readProjectWorkspace,
  switchAutomaticContinuationConversation,
  tauriRuntimeAvailable,
} from './runtime-client';
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

function statusTone(status: AutomaticContinuationTaskProjection['status']): string {
  if (status === 'needs_user') return 'attention';
  if (status === 'completed' || status === 'stopped') return 'quiet';
  if (status === 'switching_conversation') return 'switching';
  return 'live';
}

function Sidebar({
  projects,
  workNodes,
  selectedRepoId,
  selectedWorkId,
  activeView,
  runtimeLabel,
  runtimeStatus,
  onOpenAssistant,
  onSelectProject,
  onSelectWork,
  onOpenRuntime,
}: {
  projects: ProjectListItemProjection[];
  workNodes: WorkGraphNodeProjection[];
  selectedRepoId?: string;
  selectedWorkId?: string;
  activeView: AppView;
  runtimeLabel: string;
  runtimeStatus: string;
  onOpenAssistant: () => void;
  onSelectProject?: (project: ProjectListItemProjection) => void;
  onSelectWork?: (workId: string) => void;
  onOpenRuntime?: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-main">
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

        {activeView === 'project' && workNodes.length > 0 && (
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
  onSwitch,
  onContinue,
}: {
  projection: ForgeDesktopProjection;
  preview: boolean;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
  onContinue?: (prompt: string) => Promise<void>;
}) {
  const work = projection.work;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (!work) {
    return (
      <main className="main-pane empty-main">
        <div className="empty-copy">
          <h1>{projection.project ? '选择一个工作' : '选择一个项目'}</h1>
          <p>{projection.project ? '从左侧工作列表选择要继续的工作。' : '从左侧项目列表开始。'}</p>
        </div>
      </main>
    );
  }

  const continuations = projection.automaticContinuations.filter((task) => !task.workId || task.workId === work.workId);

  return (
    <main className="main-pane work-pane">
      <div className="content-column">
        <header className="work-hero">
          <div className="breadcrumb">{projection.project?.name ?? '项目'} / {semanticStateLabel(work.semanticState)}</div>
          <h1>{work.title}</h1>
          {work.currentFocus && work.currentFocus !== work.title && <p>{work.currentFocus}</p>}
        </header>

        {continuations.map((task) => (
          <AutomaticContinuationRow key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
        ))}

        <div className="work-body-copy">
          <p>{work.objective}</p>
        </div>

        <div className="fact-strip" aria-label="当前 Forge 事实">
          <div><span>工作</span><strong>{semanticStateLabel(work.semanticState)} · r{work.revision}</strong></div>
          <div><span>代码</span><strong>{projection.project?.dirty ? '有未提交修改' : '工作区干净'}</strong></div>
          <div><span>分支</span><strong>{projection.project?.branch ?? '未知'}</strong></div>
          <div><span>版本</span><strong className="mono">{projection.project?.sourceRevision ? compactId(projection.project.sourceRevision) : '未知'}</strong></div>
        </div>

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
            <div><span>检出</span><strong>{projection.project?.worktree ?? '未知'}</strong></div>
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
          <details className="detail-section">
            <summary>计划 · r{projection.plan.revision}</summary>
            <p className="detail-text">{projection.plan.goal}</p>
            {projection.plan.items.length > 0 && (
              <ul className="fact-list">{projection.plan.items.map((item) => <li key={item.id}>{item.objective}</li>)}</ul>
            )}
          </details>
        )}

        {work.executionEvidence && (
          <details className="detail-section">
            <summary>执行与验证 · {work.executionEvidence.verifications.length} 条检查记录</summary>
            <div className="detail-grid">
              <div><span>阶段</span><strong>{executionPhaseLabel(work.executionEvidence.phase)}</strong></div>
              <div><span>调度</span><strong className="mono">{work.executionEvidence.dispatchState}</strong></div>
              <div><span>证据</span><strong className="mono">{work.executionEvidence.evidenceState}</strong></div>
              <div><span>类型</span><strong className="mono">{work.executionEvidence.workKind}</strong></div>
            </div>
            {work.executionEvidence.verifications.length > 0 && (
              <div className="verification-list">
                {work.executionEvidence.verifications.map((verification, index) => (
                  <div className="verification-item" key={`${verification.checkId}-${verification.recordedAt}-${index}`}>
                    <div className="verification-heading">
                      <strong className="mono">{verification.checkId}</strong>
                      <span>{verificationOutcomeLabel(verification.outcome)}</span>
                      <span>{formatTimestamp(verification.recordedAt)}</span>
                    </div>
                    <p>{verification.summary}</p>
                    {verification.sourceRevision && <span className="verification-source mono">版本 {compactId(verification.sourceRevision)}</span>}
                  </div>
                ))}
              </div>
            )}
            {work.executionEvidence.evidenceRefs.length > 0 && (
              <div className="evidence-ref-list">
                {work.executionEvidence.evidenceRefs.map((evidence, index) => (
                  <div key={`${evidence.evidenceId ?? evidence.artifactId ?? evidence.title}-${index}`}>
                    <strong>{evidence.title}</strong>
                    {evidence.summary && <span>{evidence.summary}</span>}
                  </div>
                ))}
              </div>
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
  preview,
  onSwitch,
}: {
  tasks: AutomaticContinuationTaskProjection[];
  preview: boolean;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
}) {
  return (
    <main className="main-pane assistant-pane">
      <div className="content-column">
        <header className="work-hero">
          <div className="breadcrumb">Forge</div>
          <h1>助手</h1>
          <p>查看跨项目自动推进任务，打开对应会话或继续处理。</p>
        </header>
        {tasks.length > 0 ? tasks.map((task) => (
          <AutomaticContinuationRow key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
        )) : (
          <div className="empty-copy inline-empty"><p>当前没有活动的自动推进任务。</p></div>
        )}
      </div>
    </main>
  );
}

function RuntimeView({
  projection,
  loading,
  error,
  action,
  onRefresh,
  onDiagnose,
  onRestart,
}: {
  projection: RuntimeRecoveryProjection | null;
  loading: boolean;
  error: string | null;
  action: 'diagnose' | 'restart' | null;
  onRefresh: () => Promise<void>;
  onDiagnose: () => Promise<void>;
  onRestart: () => Promise<void>;
}) {
  const disabled = loading || action !== null || !projection?.recovery.available;
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
            <button className="plain-action" type="button" disabled={disabled} onClick={() => void onRestart()}>{action === 'restart' ? '重启中…' : '重启运行时'}</button>
          </div>
        </section>

        <details className="detail-section" open>
          <summary>状态详情</summary>
          <div className="detail-grid">
            <div><span>进程 ID</span><strong>{projection?.runtime.pid ?? '未知'}</strong></div>
            <div><span>发布版本</span><strong className="mono">{projection?.runtime.releaseId ? compactId(projection.runtime.releaseId) : '未知'}</strong></div>
            <div><span>独立恢复</span><strong>{projection?.recovery.label ?? '未知'}</strong></div>
            <div><span>最近观察</span><strong>{formatTimestamp(projection?.runtime.observedAt)}</strong></div>
          </div>
        </details>

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
  const [recoveryAction, setRecoveryAction] = useState<'diagnose' | 'restart' | null>(null);

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
      void refreshRecovery();
    }
  }, [preview, refreshRecovery]);

  useEffect(() => { void bootstrapRuntime(); }, [bootstrapRuntime]);

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

  const handleOpenRuntime = useCallback(async () => {
    setActiveView('runtime');
    await refreshRecovery();
  }, [refreshRecovery]);

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
    const confirmed = window.confirm('将通过独立恢复服务重启主运行时，现有运行时连接会短暂中断。是否继续？');
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
        selectedRepoId={selectedRepoId}
        selectedWorkId={selectedWorkId}
        activeView={activeView}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        onOpenAssistant={handleOpenAssistant}
        onSelectProject={preview ? undefined : handleSelectProject}
        onSelectWork={preview ? undefined : handleSelectWork}
        onOpenRuntime={preview ? undefined : handleOpenRuntime}
      />

      {activeView === 'assistant' ? (
        <AssistantView tasks={projection.automaticContinuations} preview={preview} onSwitch={preview ? undefined : handleSwitch} />
      ) : activeView === 'runtime' ? (
        <RuntimeView
          projection={recoveryProjection}
          loading={recoveryLoading}
          error={recoveryError}
          action={recoveryAction}
          onRefresh={refreshRecovery}
          onDiagnose={handleDiagnose}
          onRestart={handleRestartRuntime}
        />
      ) : (
        <WorkView
          projection={projection}
          preview={preview}
          onSwitch={preview ? undefined : handleSwitch}
          onContinue={preview ? undefined : handleContinue}
        />
      )}
    </div>
  );
}
