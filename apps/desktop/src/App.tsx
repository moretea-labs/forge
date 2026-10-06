import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  designPreviewProjection,
  disconnectedProjection,
  type AutomaticContinuationTaskProjection,
  type ForgeDesktopProjection,
  type ProjectListItemProjection,
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

const SYSTEM_NAV = ['连接', '运行时', '设置'] as const;

function previewEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('preview') === '1';
}

function compactId(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 16)}…${value.slice(-8)}`;
}

function statusTone(status: AutomaticContinuationTaskProjection['status']): string {
  if (status === 'needs_user') return 'attention';
  if (status === 'completed' || status === 'stopped') return 'quiet';
  if (status === 'switching_conversation') return 'switching';
  return 'live';
}

function semanticStateLabel(state: WorkSemanticState): string {
  if (state === 'completed') return '已完成';
  if (state === 'cancelled') return '已取消';
  return '进行中';
}

function AutomaticContinuationPanel({
  task,
  preview,
  onSwitch,
}: {
  task: AutomaticContinuationTaskProjection;
  preview: boolean;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
}) {
  const [switchPreviewed, setSwitchPreviewed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const conversation = task.conversation;
  const canSwitch = Boolean(conversation) && !['completed', 'stopped', 'switching_conversation'].includes(task.status);

  return (
    <section className="surface continuation-card" aria-labelledby={`automatic-continuation-${task.taskId}`}>
      <div className="section-heading-row">
        <div>
          <div className="section-kicker">自动推进监督器</div>
          <h2 id={`automatic-continuation-${task.taskId}`}>自动推进</h2>
        </div>
        <span className={`status-badge ${statusTone(task.status)}`}>{switchPreviewed ? '切换预览' : task.statusLabel}</span>
      </div>

      <p className="section-copy">{task.objective}</p>
      <dl className="fact-grid">
        <div><dt>任务</dt><dd title={task.taskId}>{compactId(task.taskId)}</dd></div>
        <div><dt>工作</dt><dd title={task.workId}>{task.workId ? compactId(task.workId) : '独立任务'}</dd></div>
        <div><dt>当前状态</dt><dd>{task.detail}</dd></div>
        <div><dt>下一步</dt><dd>{task.nextAction ?? '当前没有投影出的下一步操作。'}</dd></div>
      </dl>

      <div className="conversation-binding">
        <div className="binding-copy">
          <span className="field-label">绑定会话</span>
          {conversation ? (
            <>
              <a href={conversation.conversationUrl} target="_blank" rel="noreferrer">{conversation.title ?? '打开 ChatGPT 会话'}</a>
              <span className="mono" title={conversation.conversationId}>{compactId(conversation.conversationId)}</span>
            </>
          ) : <span className="muted">尚未绑定精确会话。</span>}
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={!canSwitch || switching || (!preview && !onSwitch)}
          onClick={async () => {
            setSwitchError(null);
            if (preview) { setSwitchPreviewed(true); return; }
            if (!onSwitch) return;
            setSwitching(true);
            try { await onSwitch(task); }
            catch (error) { setSwitchError(error instanceof Error ? error.message : String(error)); }
            finally { setSwitching(false); }
          }}
          title={preview ? '预览显式切换新会话的操作' : '通过权威自动推进能力把当前任务迁移到新会话'}
        >
          {switching ? '正在切换…' : switchPreviewed ? '已请求新会话' : '切换到新会话'}
        </button>
      </div>

      {switchError && <div className="inline-notice error">切换失败：{switchError}</div>}

      {switchPreviewed && (
        <div className="inline-notice">
          仅为设计预览：正式客户端会调用 <span className="mono">controller.workflow_supervisor.switch_to_fresh_conversation</span>，并用当前会话 ID 作为 CAS 栅栏。监督器创建新会话并重发目标后，只有观察到新会话真实成立才会更新权威 Work 绑定。
        </div>
      )}
    </section>
  );
}

function Sidebar({
  projects,
  selectedRepoId,
  onSelectProject,
}: {
  projects: ProjectListItemProjection[];
  selectedRepoId?: string;
  onSelectProject?: (project: ProjectListItemProjection) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="scope-nav">
        <button className="scope-item" type="button"><span className="scope-icon">✦</span><span>助手</span></button>
        <div className="sidebar-label">项目</div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.repoId}
              className={project.repoId === selectedRepoId ? 'scope-item active' : 'scope-item'}
              type="button"
              title={project.repository}
              onClick={() => onSelectProject?.(project)}
            >
              <span className="project-dot" aria-hidden="true" />
              <span>{project.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-bottom">
        {SYSTEM_NAV.map((item) => <button key={item} className="scope-item small" type="button">{item}</button>)}
      </div>
    </aside>
  );
}

function WorkGraphPanel({
  projection,
  selectedWorkId,
  onSelectWork,
}: {
  projection: ForgeDesktopProjection;
  selectedWorkId?: string;
  onSelectWork?: (workId: string) => void;
}) {
  if (!projection.project) return null;
  const edgesByWork = new Map<string, string[]>();
  for (const edge of projection.workGraph.edges) {
    const label = edge.kind === 'dependency'
      ? `依赖 ${compactId(edge.fromWorkId)}`
      : `属于 ${compactId(edge.fromWorkId)}`;
    const list = edgesByWork.get(edge.toWorkId) ?? [];
    list.push(label);
    edgesByWork.set(edge.toWorkId, list);
  }

  return (
    <section className="surface work-graph-surface">
      <div className="section-heading-row">
        <div>
          <div className="section-kicker">项目工作图</div>
          <h2>当前工作</h2>
        </div>
        <span className="muted">{projection.workGraph.truncated ? '仅显示有界投影' : `${projection.workGraph.nodes.length} 项`}</span>
      </div>
      {projection.workGraph.nodes.length > 0 ? (
        <div className="work-graph-list">
          {projection.workGraph.nodes.map((node) => (
            <button
              key={node.workId}
              className={node.workId === selectedWorkId ? 'work-node selected' : 'work-node'}
              type="button"
              onClick={() => onSelectWork?.(node.workId)}
            >
              <span className={`work-state-dot ${node.state}`} aria-hidden="true" />
              <span className="work-node-main">
                <strong>{node.objective}</strong>
                <span className="mono">{compactId(node.workId)}</span>
              </span>
              <span className="work-node-meta">
                <span>{semanticStateLabel(node.state)}</span>
                {(edgesByWork.get(node.workId) ?? []).map((relation) => <span key={relation}>{relation}</span>)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-inline">这个项目当前没有可展示的工作。</div>
      )}
    </section>
  );
}

function WorkContextPanel({ projection }: { projection: ForgeDesktopProjection }) {
  const work = projection.work;
  if (!work) return null;
  return (
    <section className="surface context-panel">
      <div className="section-kicker">语义上下文</div>
      <div className="context-grid">
        <div><span className="field-label">需求</span><strong>{work.requirementId ? compactId(work.requirementId) : '未绑定'}</strong></div>
        <div><span className="field-label">计划</span><strong>{work.planId ? compactId(work.planId) : '未绑定'}</strong></div>
        <div><span className="field-label">计划状态</span><strong>{projection.plan?.status ?? '无'}</strong></div>
      </div>
      {projection.plan && <p className="section-copy plan-goal">{projection.plan.goal}</p>}
    </section>
  );
}

function WorkSurface({
  projection,
  preview,
  onSelectWork,
  onSwitch,
  onContinue,
}: {
  projection: ForgeDesktopProjection;
  preview: boolean;
  onSelectWork?: (workId: string) => void;
  onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void>;
  onContinue?: (prompt: string) => Promise<void>;
}) {
  const work = projection.work;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  return (
    <section className="workspace">
      {projection.project && (
        <div className="project-context">
          <strong>{projection.project.name}</strong>
          <span>{projection.project.repository}</span>
          <span>分支 {projection.project.branch}</span>
          <span>{projection.project.worktree}</span>
          <span className="mono">{compactId(projection.project.sourceRevision)}</span>
        </div>
      )}

      <div className="workspace-scroll">
        {projection.project && (
          <WorkGraphPanel projection={projection} selectedWorkId={work?.workId} onSelectWork={onSelectWork} />
        )}

        {work ? (
          <>
            <header className="work-header">
              <div className="section-kicker">{work.relationLabel ?? '工作'}</div>
              <div className="work-title-row">
                <h1>{work.title}</h1>
                <span className="semantic-state">{semanticStateLabel(work.semanticState)}</span>
              </div>
              <div className="work-meta"><span className="mono">{work.workId}</span></div>
            </header>

            <section className="surface focus-card">
              <div className="section-kicker">当前焦点</div>
              <h2>{work.currentFocus ?? work.objective}</h2>
              <p className="section-copy">桌面客户端只读取 Forge 权威语义事实；运行时、恢复和连接状态不会改写 Work 的语义状态。</p>
            </section>

            <WorkContextPanel projection={projection} />

            {projection.automaticContinuations
              .filter((task) => !task.workId || task.workId === work.workId)
              .map((task) => (
                <AutomaticContinuationPanel key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
              ))}

            <section className="surface evidence-preview">
              <div className="section-heading-row"><div><div className="section-kicker">结果与证据</div><h2>当前工作结果</h2></div></div>
              {work.resultRefs.length > 0 ? (
                <div className="result-ref-list">
                  {work.resultRefs.slice(0, 6).map((resultRef) => <span key={resultRef} className="mono result-ref">{resultRef}</span>)}
                </div>
              ) : <div className="empty-inline">当前工作还没有记录结果引用。</div>}
            </section>
          </>
        ) : projection.automaticContinuations.length > 0 && !projection.project ? (
          <div className="global-continuations">
            <header className="work-header">
              <div className="section-kicker">Forge 实例</div>
              <h1>自动推进任务</h1>
              <p className="section-copy">这里展示自动推进监督器的实时投影；打开或切换会话不会创建客户端自己的任务状态。</p>
            </header>
            {projection.automaticContinuations.map((task) => (
              <AutomaticContinuationPanel key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
            ))}
          </div>
        ) : !projection.project ? (
          <div className="disconnected-state">
            <div className="section-kicker">Forge V3 桌面客户端</div>
            <h1>{projection.runtime.status === 'connected' ? '当前没有活动的自动推进任务' : '运行时投影尚未连接'}</h1>
            <p>{projection.runtime.detail}</p>
            {!tauriRuntimeAvailable() && <><code>?preview=1</code><span> 可打开明确标记的设计预览，不会把示例数据当作运行时事实。</span></>}
          </div>
        ) : null}
      </div>

      <div className="composer">
        <textarea
          aria-label="向当前工作发送指令"
          placeholder={work ? '告诉 ChatGPT 接下来要继续做什么…' : '先选择一个工作…'}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!work || !onContinue}
        />
        {sendError && <div className="composer-error">发送失败：{sendError}</div>}
        <div className="composer-footer">
          <span>{work ? `当前工作 · ${compactId(work.workId)}` : '未选择工作'}</span>
          <button
            type="button"
            disabled={!work || !onContinue || !draft.trim() || sending}
            onClick={async () => {
              if (!onContinue || !draft.trim()) return;
              setSendError(null);
              setSending(true);
              try {
                await onContinue(draft.trim());
                setDraft('');
              } catch (error) {
                setSendError(error instanceof Error ? error.message : String(error));
              } finally {
                setSending(false);
              }
            }}
          >{sending ? '发送中…' : '继续工作'}</button>
        </div>
      </div>
    </section>
  );
}

function RuntimeInspector({ projection }: { projection: ForgeDesktopProjection }) {
  const task = projection.automaticContinuations.find((candidate) => !projection.work || candidate.workId === projection.work.workId);
  return (
    <aside className="inspector">
      <div className="inspector-title">检查器</div>
      <section className="inspector-section">
        <span className="field-label">运行时</span>
        <div className="health-row"><span className={`health-dot ${projection.runtime.status}`} /> <strong>{projection.runtime.label}</strong></div>
        <p>{projection.runtime.detail}</p>
      </section>
      <section className="inspector-section">
        <span className="field-label">项目</span>
        <strong>{projection.project?.name ?? '未选择'}</strong>
        <span className="muted">项目与仓库身份来自 Forge Repository Registry。</span>
      </section>
      <section className="inspector-section">
        <span className="field-label">当前工作</span>
        <strong>{projection.work ? compactId(projection.work.workId) : '未选择'}</strong>
        <span className="muted">工作语义权威仍由 Forge Runtime 持有。</span>
      </section>
      <section className="inspector-section">
        <span className="field-label">自动推进</span>
        <strong>{task?.statusLabel ?? '没有绑定任务'}</strong>
        <span className="muted">{task?.conversation ? '已绑定精确会话' : '没有精确会话绑定'}</span>
      </section>
      {projection.source === 'design_preview' && <div className="preview-watermark">设计预览</div>}
    </aside>
  );
}

export function App() {
  const preview = useMemo(previewEnabled, []);
  const [projection, setProjection] = useState<ForgeDesktopProjection>(preview ? designPreviewProjection : disconnectedProjection);
  const [projects, setProjects] = useState<ProjectListItemProjection[]>(preview ? [...designPreviewProjection.projects] : []);
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(preview ? designPreviewProjection.project?.repoId : undefined);
  const [selectedWorkId, setSelectedWorkId] = useState<string | undefined>(preview ? designPreviewProjection.work?.workId : undefined);

  const loadProject = useCallback(async (project: ProjectListItemProjection, workId?: string) => {
    if (preview || !tauriRuntimeAvailable()) return;
    setProjection((current) => ({
      ...current,
      source: 'runtime',
      runtime: { status: 'connecting', label: '正在读取运行时', detail: '正在读取项目与工作权威投影。' },
      projects,
    }));
    try {
      const [workspace, automaticContinuations] = await Promise.all([
        readProjectWorkspace(project, workId),
        readAutomaticContinuations(),
      ]);
      setSelectedRepoId(project.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '项目、工作与自动推进状态均来自 Forge Runtime MCP 权威投影。' },
        projects,
        ...workspace,
        automaticContinuations,
      });
    } catch (error) {
      setProjection((current) => ({
        ...current,
        source: 'runtime',
        runtime: { status: 'degraded', label: '运行时读取异常', detail: error instanceof Error ? error.message : String(error) },
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
        return;
      }
      const workspace = await readProjectWorkspace(selectedProject);
      setSelectedRepoId(selectedProject.repoId);
      setSelectedWorkId(workspace.work?.workId);
      setProjection({
        source: 'runtime',
        runtime: { status: 'connected', label: '运行时已连接', detail: '项目、工作与自动推进状态均来自 Forge Runtime MCP 权威投影。' },
        projects: catalog.projects,
        ...workspace,
        automaticContinuations,
      });
    } catch (error) {
      setProjection({
        ...disconnectedProjection,
        runtime: { status: 'degraded', label: '运行时不可用', detail: error instanceof Error ? error.message : String(error) },
      });
    }
  }, [preview]);

  useEffect(() => { void bootstrapRuntime(); }, [bootstrapRuntime]);

  const handleSelectProject = useCallback(async (project: ProjectListItemProjection) => {
    setSelectedWorkId(undefined);
    await loadProject(project);
  }, [loadProject]);

  const handleSelectWork = useCallback(async (workId: string) => {
    const project = projects.find((candidate) => candidate.repoId === selectedRepoId);
    if (!project) return;
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

  return (
    <main className="app-frame">
      <header className="native-titlebar">
        <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
        <div className="window-title"><strong>Forge</strong><span>{projection.project ? `${projection.project.name} · 项目工作台` : '助手'}</span></div>
        <div className="command-search">搜索工作、计划、文件… <kbd>⌘K</kbd></div>
        <div className="runtime-chip"><span className={`health-dot ${projection.runtime.status}`} />{projection.runtime.label}</div>
      </header>
      <div className="app-body">
        <Sidebar
          projects={projects}
          selectedRepoId={selectedRepoId}
          onSelectProject={preview ? undefined : handleSelectProject}
        />
        <WorkSurface
          projection={projection}
          preview={preview}
          onSelectWork={preview ? undefined : handleSelectWork}
          onSwitch={preview ? undefined : handleSwitch}
          onContinue={preview ? undefined : handleContinue}
        />
        <RuntimeInspector projection={projection} />
      </div>
    </main>
  );
}
