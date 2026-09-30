import { useEffect, useMemo, useState } from 'react';
import {
  createLocalThread,
  loadLocalThreads,
  loadSnapshot,
  persistLocalThreads,
  restartNativeRuntime,
  type LocalMessage,
  type LocalThread,
  type Mode,
  type Scope,
  type Snapshot,
  type Work,
} from './client';
import './conversation.css';

const iconPaths = {
  spark: 'M12 2l1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2z',
  folder: 'M3 5.5A1.5 1.5 0 014.5 4H10l2 2h7.5A1.5 1.5 0 0121 7.5v9A1.5 1.5 0 0119.5 18h-15A1.5 1.5 0 013 16.5v-11z',
  chevron: 'M9 6l6 6-6 6',
  pulse: 'M3 12h4l2-7 4 14 2-7h6',
  plus: 'M12 5v14M5 12h14',
  archive: 'M4 7h16v12H4z M3 7h18 M8 11h8',
  send: 'M4 12h15 M13 6l6 6-6 6',
} as const;

function Icon({ name }: { name: keyof typeof iconPaths }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function RuntimePill({ snapshot, onRefresh, onRecover }: { snapshot: Snapshot; onRefresh: () => void; onRecover: () => void }) {
  return <div className="runtime-control"><button className={`runtime-pill ${snapshot.runtime}`} onClick={onRefresh} title="Refresh Forge status">
    <span className="runtime-dot" /><span>{snapshot.runtimeLabel}</span><small>{snapshot.source === 'live' ? 'LIVE' : snapshot.source === 'native' ? 'NATIVE' : 'PREVIEW'}</small>
  </button>{snapshot.source === 'native' && snapshot.runtime !== 'ready' && <button className="runtime-recover" onClick={onRecover}>Restart Runtime</button>}</div>;
}

function WorkRow({ work, selected, onSelect }: { work: Work; selected: boolean; onSelect: () => void }) {
  return <button className={`work-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
    <span className={`work-state ${work.state}`} /><span className="work-copy"><strong>{work.title}</strong><small>{work.summary}</small></span><span className="work-time">{work.updatedAt}</span>
  </button>;
}

function LocalConversation({ thread, onChange, onArchive }: { thread: LocalThread; onChange: (thread: LocalThread) => void; onArchive: () => void }) {
  const [input, setInput] = useState('');
  const send = () => {
    const content = input.trim();
    if (!content) return;
    const message: LocalMessage = { id: `message-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString() };
    onChange({ ...thread, title: thread.title === 'New conversation' ? content.slice(0, 48) : thread.title, updatedAt: message.createdAt, messages: [...thread.messages, message] });
    setInput('');
  };
  return <section className="conversation">
    <div className="conversation-head"><div><span className="context-label">LOCAL THREAD</span><h2>{thread.title}</h2></div><button className="quiet-action" onClick={onArchive}><Icon name="archive" />Archive</button></div>
    <div className="provider-banner"><span className="runtime-dot attention" /><div><strong>Local provider not connected</strong><small>Messages stay in this client-local transcript. Forge Work and Plan state is not created implicitly.</small></div><button className="secondary-action">Connect provider</button></div>
    <div className="message-list">{thread.messages.length === 0 ? <div className="conversation-empty"><div className="empty-icon"><Icon name="spark" /></div><strong>Start a local conversation</strong><span>This thread is independent from Requirement, Plan and Work.</span></div> : thread.messages.map(message => <div className={`message ${message.role}`} key={message.id}><span className="message-role">{message.role === 'user' ? 'You' : 'Forge'}</span><p>{message.content}</p></div>)}</div>
    <div className="composer"><textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Write a message…" aria-label="Local conversation message" /><button className="primary-action" onClick={send} disabled={!input.trim()}><Icon name="send" />Send</button></div>
  </section>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [mode, setMode] = useState<Mode>('mcp');
  const [scope, setScope] = useState<Scope>('projects');
  const [projectId, setProjectId] = useState('forge');
  const [selectedId, setSelectedId] = useState('w-v3');
  const [refreshing, setRefreshing] = useState(false);
  const [threads, setThreads] = useState<LocalThread[]>([]);
  const [threadId, setThreadId] = useState<string>();

  const refresh = async () => { setRefreshing(true); setSnapshot(await loadSnapshot()); setRefreshing(false); };
  useEffect(() => { setThreads(loadLocalThreads()); void refresh(); }, []);
  useEffect(() => { if (threads.length) persistLocalThreads(threads); }, [threads]);

  const project = snapshot?.projects.find(item => item.id === projectId) ?? snapshot?.projects[0];
  const works = scope === 'assistant' ? (snapshot?.assistant ?? []) : (project?.work ?? []);
  const selected = useMemo(() => works.find(work => work.id === selectedId) ?? works[0], [works, selectedId]);
  const activeThreads = threads.filter(thread => !thread.archived);
  const selectedThread = activeThreads.find(thread => thread.id === threadId) ?? activeThreads[0];
  const newThread = () => { const thread = createLocalThread(scope === 'projects' ? project?.id : undefined); setThreads(current => [thread, ...current]); setThreadId(thread.id); setMode('local'); };
  const updateThread = (thread: LocalThread) => setThreads(current => current.map(item => item.id === thread.id ? thread : item));
  const archiveThread = () => { if (!selectedThread) return; setThreads(current => current.map(item => item.id === selectedThread.id ? { ...item, archived: true, updatedAt: new Date().toISOString() } : item)); setThreadId(undefined); };
  const recoverRuntime = async () => { await restartNativeRuntime(); await refresh(); };

  if (!snapshot) return <div className="loading"><span className="forge-mark">F</span><strong>Opening Forge</strong><span>Restoring workspace…</span></div>;
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="forge-mark">F</span><span><strong>Forge</strong><small>V3 Desktop</small></span></div>
      <div className="mode-switch" role="tablist" aria-label="Forge mode"><button className={mode === 'mcp' ? 'active' : ''} onClick={() => setMode('mcp')}>MCP</button><button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>Local</button></div>
      <nav className="scope-nav"><button className={scope === 'assistant' ? 'active' : ''} onClick={() => setScope('assistant')}><Icon name="spark" /><span>Assistant</span></button><button className={scope === 'projects' ? 'active' : ''} onClick={() => setScope('projects')}><Icon name="folder" /><span>Projects</span><kbd>⌘1</kbd></button></nav>
      {mode === 'local' ? <div className="project-list"><div className="side-label">Threads <button aria-label="New thread" onClick={newThread}><Icon name="plus" /></button></div>{activeThreads.map(thread => <button className={thread.id === selectedThread?.id ? 'project active' : 'project'} key={thread.id} onClick={() => { setThreadId(thread.id); setMode('local'); }}><span className="project-icon"><Icon name="spark" /></span><span><strong>{thread.title}</strong><small>{thread.projectId ?? 'Assistant-global'}</small></span></button>)}{!activeThreads.length && <span className="thread-hint">No local threads yet.</span>}</div> : scope === 'projects' && <div className="project-list"><div className="side-label">Projects <button aria-label="Add project"><Icon name="plus" /></button></div>{snapshot.projects.map(item => <button className={item.id === projectId ? 'project active' : 'project'} key={item.id} onClick={() => { setProjectId(item.id); setSelectedId(item.work[0]?.id); }}><span className="project-icon"><Icon name="folder" /></span><span><strong>{item.name}</strong><small>{item.branch}</small></span></button>)}</div>}
      <div className="sidebar-bottom"><RuntimePill snapshot={snapshot} onRefresh={() => void refresh()} onRecover={() => void recoverRuntime()} /><button className="settings-link" onClick={() => setMode('local')}><span className="avatar">G</span><span><strong>Greyson</strong><small>Connections</small></span><Icon name="chevron" /></button></div>
    </aside>
    <main className="main"><header className="topbar"><div><span className="context-label">{mode === 'mcp' ? 'MCP WORKSPACE' : 'LOCAL CONVERSATION'}</span><h1>{mode === 'local' ? 'Local' : scope === 'assistant' ? 'Assistant' : project?.name ?? 'Projects'}</h1></div><div className="top-actions"><button className="quiet-action" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button className="primary-action" onClick={newThread}><Icon name="plus" />{mode === 'local' ? 'New thread' : 'New Work'}</button></div></header>
      {mode === 'local' ? (selectedThread ? <LocalConversation thread={selectedThread} onChange={updateThread} onArchive={archiveThread} /> : <section className="local-empty"><div className="empty-icon"><Icon name="spark" /></div><h2>Conversation-first work</h2><p>Local threads are client-owned and independent from Requirement, Plan and Work.</p><button className="primary-action" onClick={newThread}><Icon name="plus" />New thread</button></section>) : <div className="workspace"><section className="work-column"><div className="workspace-heading"><div><span className="context-label">{scope === 'assistant' ? 'ASSISTANT-GLOBAL' : 'PROJECT WORK'}</span><h2>{scope === 'assistant' ? 'Current work' : 'Current'}</h2></div><span className="count-label">{works.length} {works.length === 1 ? 'item' : 'items'}</span></div><div className="work-list">{works.map(work => <WorkRow key={work.id} work={work} selected={selected?.id === work.id} onSelect={() => setSelectedId(work.id)} />)}</div>{!works.length && <div className="empty-state"><strong>No current Work</strong><span>Start from a repository or keep this as an Assistant-global workspace.</span></div>}<div className="history-link"><button onClick={() => setScope(scope)}>Show history <Icon name="chevron" /></button></div></section><aside className="inspector">{selected ? <><div className="inspector-header"><span className={`state-badge ${selected.state}`}>{selected.state === 'active' ? 'Active' : selected.state === 'planned' ? 'Planned' : selected.state === 'blocked' ? 'Blocked' : 'Done'}</span><span className="id-label">{selected.id}</span></div><h2>{selected.title}</h2><p className="inspector-summary">{selected.summary}</p><dl><div><dt>Repository</dt><dd>{selected.repository}</dd></div><div><dt>Semantic parent</dt><dd>{selected.parentId ?? 'None'}</dd></div><div><dt>Dependencies</dt><dd>{selected.dependsOn?.length ? selected.dependsOn.join(', ') : 'None'}</dd></div></dl>{selected.plan && <div className="plan-reference"><span>Plan context</span><strong>{selected.plan}</strong><small>Descriptive context only · Work is the progress node</small></div>}{selected.evidence && <div className="evidence"><span>Evidence</span>{selected.evidence.map(entry => <div key={entry}><Icon name="pulse" />{entry}</div>)}</div>}<button className="secondary-action">Open details <Icon name="chevron" /></button></> : <div className="inspector-empty">Select a Work to inspect its current facts.</div>}</aside></div>}
    </main>
  </div>;
}
