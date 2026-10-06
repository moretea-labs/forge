import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  designPreviewProjection,
  disconnectedProjection,
  type AutomaticContinuationTaskProjection,
  type ForgeDesktopProjection,
} from './runtime-projection';
import { readAutomaticContinuations, switchAutomaticContinuationConversation, tauriRuntimeAvailable } from './runtime-client';

const PROJECTS = ['forge', 'Avela', 'Knowledge'] as const;
const SYSTEM_NAV = ['Connections', 'Runtime', 'Settings'] as const;

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
    <section className="surface continuation-card" aria-labelledby="automatic-continuation-title">
      <div className="section-heading-row">
        <div>
          <div className="section-kicker">Workflow Supervisor</div>
          <h2 id="automatic-continuation-title">Automatic continuation</h2>
        </div>
        <span className={`status-badge ${statusTone(task.status)}`}>{switchPreviewed ? 'Switch preview' : task.statusLabel}</span>
      </div>

      <p className="section-copy">{task.objective}</p>
      <dl className="fact-grid">
        <div><dt>Task</dt><dd title={task.taskId}>{compactId(task.taskId)}</dd></div>
        <div><dt>Work</dt><dd title={task.workId}>{task.workId ? compactId(task.workId) : 'Standalone'}</dd></div>
        <div><dt>Current state</dt><dd>{task.detail}</dd></div>
        <div><dt>Next</dt><dd>{task.nextAction ?? 'No projected next action.'}</dd></div>
      </dl>

      <div className="conversation-binding">
        <div className="binding-copy">
          <span className="field-label">Bound conversation</span>
          {conversation ? (
            <>
              <a href={conversation.conversationUrl} target="_blank" rel="noreferrer">{conversation.title ?? 'Open ChatGPT conversation'}</a>
              <span className="mono" title={conversation.conversationId}>{compactId(conversation.conversationId)}</span>
            </>
          ) : <span className="muted">No exact conversation is bound.</span>}
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
          title={preview ? 'Preview the explicit fresh-conversation migration action' : 'Move this task through the canonical Workflow Supervisor migration capability'}
        >
          {switching ? 'Switching…' : switchPreviewed ? 'Fresh conversation requested' : 'Use new conversation'}
        </button>
      </div>

      {switchError && <div className="inline-notice error">Switch failed: {switchError}</div>}

      {switchPreviewed && (
        <div className="inline-notice">
          Preview only: production sends <span className="mono">controller.workflow_supervisor.switch_to_fresh_conversation</span> with the current conversation ID as the CAS fence. The Supervisor creates the fresh chat, resends the objective, then updates the canonical Work binding after the new conversation is observed.
        </div>
      )}
    </section>
  );
}

function Sidebar({ projectName }: { projectName?: string }) {
  return (
    <aside className="sidebar">
      <div className="scope-nav">
        <button className="scope-item" type="button"><span className="scope-icon">✦</span><span>Assistant</span></button>
        <div className="sidebar-label">Projects</div>
        {PROJECTS.map((project) => (
          <button key={project} className={project === projectName ? 'scope-item active' : 'scope-item'} type="button">
            <span className="project-dot" aria-hidden="true" />
            <span>{project}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom">
        {SYSTEM_NAV.map((item) => <button key={item} className="scope-item small" type="button">{item}</button>)}
      </div>
    </aside>
  );
}

function WorkSurface({ projection, preview, onSwitch }: { projection: ForgeDesktopProjection; preview: boolean; onSwitch?: (task: AutomaticContinuationTaskProjection) => Promise<void> }) {
  const work = projection.work;
  return (
    <section className="workspace">
      {projection.project && (
        <div className="project-context">
          <strong>{projection.project.name}</strong>
          <span>{projection.project.repository}</span>
          <span>{projection.project.branch}</span>
          <span>{projection.project.worktree}</span>
        </div>
      )}

      <div className="workspace-scroll">
        {work ? (
          <>
            <header className="work-header">
              <div className="section-kicker">{work.relationLabel ?? 'Work'}</div>
              <div className="work-title-row">
                <h1>{work.title}</h1>
                <span className="semantic-state">{work.semanticState}</span>
              </div>
              <div className="work-meta"><span className="mono">{work.workId}</span><span>{work.controller ?? 'Controller unassigned'}</span></div>
            </header>

            <section className="surface focus-card">
              <div className="section-kicker">Current Focus</div>
              <h2>{work.currentFocus ?? 'Canonical Work projection'}</h2>
              <p className="section-copy">The desktop keeps Work meaning separate from Runtime mechanics. It reads Forge facts and does not manufacture lifecycle state.</p>
            </section>

            {projection.automaticContinuations.map((task) => (
              <AutomaticContinuationPanel key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
            ))}

            {projection.automaticContinuations.length === 0 && (
              <section className="surface empty-surface">
                <div className="section-kicker">Automatic continuation</div>
                <h2>No Runtime projection</h2>
                <p>{projection.runtime.detail}</p>
              </section>
            )}

            <section className="surface evidence-preview">
              <div className="section-heading-row"><div><div className="section-kicker">Evidence</div><h2>Changes & verification</h2></div><button className="text-action" type="button">Open full evidence</button></div>
              <div className="evidence-columns">
                <div><span className="field-label">Changed files</span><strong>Desktop client + Supervisor capability</strong><span>Canonical source only</span></div>
                <div><span className="field-label">Checks</span><strong>Pending this batch</strong><span>Type, architecture, desktop build</span></div>
                <div><span className="field-label">History</span><strong>Same Work identity</strong><span>Continuation stays in History</span></div>
              </div>
            </section>
          </>
        ) : projection.automaticContinuations.length > 0 ? (
          <div className="global-continuations">
            <header className="work-header">
              <div className="section-kicker">Forge instance</div>
              <h1>Automatic continuation tasks</h1>
              <p className="section-copy">Live Workflow Supervisor projection. Opening or switching a conversation does not create a client-owned task state.</p>
            </header>
            {projection.automaticContinuations.map((task) => (
              <AutomaticContinuationPanel key={task.taskId} task={task} preview={preview} onSwitch={onSwitch} />
            ))}
          </div>
        ) : (
          <div className="disconnected-state">
            <div className="section-kicker">Forge V3 Desktop</div>
            <h1>{projection.runtime.status === 'connected' ? 'No active automatic continuation tasks' : 'Runtime projection is not connected'}</h1>
            <p>{projection.runtime.detail}</p>
            {!tauriRuntimeAvailable() && <><code>?preview=1</code><span> opens the explicit design preview without turning fixture data into Runtime truth.</span></>}
          </div>
        )}
      </div>

      <div className="composer">
        <textarea aria-label="Message controller" placeholder="Message controller…" rows={2} disabled={!work} />
        <div className="composer-footer"><span>{work ? 'Current Work · MCP' : 'No Work scope'}</span><button type="button" disabled={!work}>Send</button></div>
      </div>
    </section>
  );
}

function RuntimeInspector({ projection }: { projection: ForgeDesktopProjection }) {
  const task = projection.automaticContinuations[0];
  return (
    <aside className="inspector">
      <div className="inspector-title">Inspector</div>
      <section className="inspector-section">
        <span className="field-label">Runtime</span>
        <div className="health-row"><span className={`health-dot ${projection.runtime.status}`} /> <strong>{projection.runtime.label}</strong></div>
        <p>{projection.runtime.detail}</p>
      </section>
      <section className="inspector-section">
        <span className="field-label">Controller</span>
        <strong>{projection.work?.controller ?? 'Unavailable'}</strong>
        <span className="muted">Semantic Work authority remains outside the client.</span>
      </section>
      <section className="inspector-section">
        <span className="field-label">Automatic continuation</span>
        <strong>{task?.statusLabel ?? 'No task projected'}</strong>
        <span className="muted">{task?.conversation ? 'Exact conversation bound' : 'No conversation binding'}</span>
      </section>
      {projection.source === 'design_preview' && <div className="preview-watermark">DESIGN PREVIEW</div>}
    </aside>
  );
}

export function App() {
  const preview = useMemo(previewEnabled, []);
  const [projection, setProjection] = useState<ForgeDesktopProjection>(preview ? designPreviewProjection : disconnectedProjection);

  const refreshAutomaticContinuations = useCallback(async () => {
    if (preview || !tauriRuntimeAvailable()) return;
    try {
      const automaticContinuations = await readAutomaticContinuations();
      setProjection({
        ...disconnectedProjection,
        source: 'runtime',
        runtime: {
          status: 'connected',
          label: 'Runtime connected',
          detail: 'Automatic continuation tasks are projected from the canonical Workflow Supervisor through Runtime MCP.',
        },
        automaticContinuations,
      });
    } catch (error) {
      setProjection({
        ...disconnectedProjection,
        runtime: {
          status: 'degraded',
          label: 'Runtime unavailable',
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }, [preview]);

  useEffect(() => { void refreshAutomaticContinuations(); }, [refreshAutomaticContinuations]);

  const handleSwitch = useCallback(async (task: AutomaticContinuationTaskProjection) => {
    await switchAutomaticContinuationConversation(task);
    await refreshAutomaticContinuations();
  }, [refreshAutomaticContinuations]);

  return (
    <main className="app-frame">
      <header className="native-titlebar">
        <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
        <div className="window-title"><strong>Forge</strong><span>{projection.project ? `${projection.project.name} · Work Focus` : 'Assistant'}</span></div>
        <div className="command-search">Command or search… <kbd>⌘K</kbd></div>
        <div className="runtime-chip"><span className={`health-dot ${projection.runtime.status}`} />{projection.runtime.label}</div>
      </header>
      <div className="app-body">
        <Sidebar projectName={projection.project?.name} />
        <WorkSurface projection={projection} preview={preview} onSwitch={preview ? undefined : handleSwitch} />
        <RuntimeInspector projection={projection} />
      </div>
    </main>
  );
}
