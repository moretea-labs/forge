import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentGitReview, type GitDiffReceipt } from './agent-git-review';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocalProviderStatusProjection } from './runtime-client';
import type { ProjectListItemProjection } from './runtime-projection';
import type { LocalApiSettings, LocalProviderChoice, LocalApiToolEvent } from './local-api';

const LOCAL_THREADS_KEY = 'forge.desktop.local-threads.v1';
const MAX_THREADS = 100;

export type LocalConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export interface LocalToolProgress {
  conversationId: string;
  name: string;
  phase: 'started' | 'completed' | 'failed';
  requestId?: string;
}

/** Append each start; reconcile its matching completion without inventing success. */
export function advanceLocalToolProgress(
  events: LocalToolProgress[], event: LocalToolProgress,
): LocalToolProgress[] {
  if (event.phase === 'started') return [...events, event].slice(-12);
  let index = -1;
  for (let cursor = events.length - 1; cursor >= 0; cursor -= 1) {
    const entry = events[cursor];
    if (entry && entry.conversationId === event.conversationId
      && entry.name === event.name && entry.phase === 'started'
      && (!event.requestId || entry.requestId === event.requestId)) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return [...events, event].slice(-12);
  return events.map((entry, cursor) => cursor === index ? event : entry);
}

export interface LocalConversationMessage {
  id: string;
  role: LocalConversationRole;
  content: string;
  createdAt: string;
  toolActivityCount?: number;
  toolEvents?: LocalApiToolEvent[];
}

export interface LocalConversationThread {
  id: string;
  title: string;
  projectRepoId?: string;
  // Conversation-local foreign key; Forge remains the sole Work authority.
  workId?: string;
  providerSessionId?: string;
  provider?: LocalProviderChoice;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: LocalConversationMessage[];
}

export interface LocalConversationReply {
  content: string;
  providerSessionId?: string;
  toolActivityCount?: number;
  toolEvents?: LocalApiToolEvent[];
  messages?: LocalConversationMessage[];
}

function localId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createThread(provider: LocalProviderChoice, projectRepoId?: string, workId?: string): LocalConversationThread {
  const timestamp = new Date().toISOString();
  return {
    id: localId('thread'),
    title: '新会话',
    provider,
    ...(projectRepoId ? { projectRepoId } : {}),
    ...(projectRepoId && workId ? { workId } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    messages: [],
  };
}

export function findExistingWorkThread(
  threads: LocalConversationThread[], provider: LocalProviderChoice, repoId: string, workId: string,
): LocalConversationThread | undefined {
  return threads.filter((thread) => !thread.archived && (thread.provider ?? 'codex') === provider
    && thread.projectRepoId === repoId && thread.workId === workId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function loadThreads(): LocalConversationThread[] {
  try {
    const raw = localStorage.getItem(LOCAL_THREADS_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((thread): thread is LocalConversationThread => Boolean(
        thread && typeof thread === 'object'
        && typeof (thread as LocalConversationThread).id === 'string'
        && typeof (thread as LocalConversationThread).title === 'string'
        && Array.isArray((thread as LocalConversationThread).messages),
      ))
      .slice(0, MAX_THREADS)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

function persistThreads(threads: LocalConversationThread[]): void {
  localStorage.setItem(LOCAL_THREADS_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)));
}

function threadLabel(thread: LocalConversationThread): string {
  return thread.title.trim() || '新会话';
}

export interface LocalConversationNavItem {
  id: string;
  title: string;
  updatedAt: string;
  provider: LocalProviderChoice;
}

function LocalMessageBody({ content }: { content: string }) {
  return (
    <div className="local-message-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}>{content}</ReactMarkdown>
    </div>
  );
}

export function LocalConversationSurface({
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
  newThreadRequested,
  onNewThreadHandled,
  openThreadId,
  onOpenThreadHandled,
  onThreadsChange,
  onRefreshProvider,
  onSend,
  onCancel,
}: {
  projects: ProjectListItemProjection[];
  defaultProjectRepoId?: string;
  newThreadContext?: { repoId: string; workId: string };
  onOpenWork?: (repoId: string, workId: string) => void;
  onOpenRecord?: (repoId: string, mode: 'requirements' | 'plans', id: string) => void;
  provider: LocalProviderStatusProjection | null;
  providerLoading: boolean;
  providerError: string | null;
  apiSettings: LocalApiSettings | null;
  onOpenSettings: () => void;
  newThreadRequested: boolean;
  onNewThreadHandled: () => void;
  openThreadId?: string;
  onOpenThreadHandled: () => void;
  onThreadsChange: (items: LocalConversationNavItem[], selectedId?: string) => void;
  onRefreshProvider: () => Promise<void>;
  onSend?: (input: { thread: LocalConversationThread; prompt: string; allowEffects: boolean }) => Promise<LocalConversationReply>;
  onCancel?: (thread: LocalConversationThread) => Promise<void>;
}) {
  const [threads, setThreads] = useState<LocalConversationThread[]>(() => loadThreads());
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(() => loadThreads().find((thread) => !thread.archived)?.id);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingThreadId, setSendingThreadId] = useState<string>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [toolProgress, setToolProgress] = useState<LocalToolProgress[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [allowEffects, setAllowEffects] = useState(false);
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffRepoId, setDiffRepoId] = useState<string>();
  const [diff, setDiff] = useState<GitDiffReceipt>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string>();
  const [workIndex, setWorkIndex] = useState<Array<{ workId: string; objective: string; state: string }>>([]);
  const [workIndexError, setWorkIndexError] = useState<string>();
  const [workDetail, setWorkDetail] = useState<{
    repoId: string; workId: string; objective: string; state: string;
    requirementId?: string; planId?: string;
  }>();
  const [workDetailError, setWorkDetailError] = useState<string>();
  const sendingThreadRef = useRef<string | undefined>(undefined);
  const diffRequest = useRef(0);
  const handledNewThread = useRef(false);
  const initialThreadProvisioned = useRef<LocalProviderChoice | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { persistThreads(threads); }, [threads]);

  // Pure observation from the native agent's existing tool loop. Events never
  // authorize effects or persist another transcript; completed receipts still
  // come only from the native command response.
  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void listen<LocalToolProgress>(
      'forge-agent-tool-progress', (event) => {
        if (!stopped && event.payload.conversationId === sendingThreadRef.current) {
          setToolProgress((current) => advanceLocalToolProgress(current, event.payload));
        }
      },
    ).then((unlisten) => { if (stopped) unlisten(); else unsubscribe = unlisten; })
      .catch(() => { /* Codex CLI or browser-only preview has no native tool events. */ });
    return () => { stopped = true; unsubscribe?.(); };
  }, []);

  const selectedProvider: LocalProviderChoice = apiSettings?.provider ?? 'codex';
  const activeThreads = useMemo(
    () => threads.filter((thread) => !thread.archived && (thread.provider ?? 'codex') === selectedProvider),
    [threads, selectedProvider],
  );
  const selectedThread = activeThreads.find((thread) => thread.id === selectedThreadId) ?? activeThreads[0];
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); },
    [selectedThreadId, selectedThread?.messages.length, sending]);

  useEffect(() => {
    // Empty drafts are not history. Keep them in the single local owner until
    // a first user message makes the thread a real conversation.
    const history = activeThreads.filter((thread) => thread.messages.length > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    onThreadsChange(history.map((thread) => ({
      id: thread.id, title: threadLabel(thread), updatedAt: thread.updatedAt,
      provider: thread.provider ?? 'codex',
    })), selectedThread?.messages.length ? selectedThread.id : undefined);
  }, [activeThreads, selectedThread?.id, onThreadsChange]);

  useEffect(() => {
    if (!openThreadId) return;
    if (activeThreads.some((thread) => thread.id === openThreadId)) {
      setSelectedThreadId(openThreadId);
      setSendError(null);
      setDraft('');
    }
    onOpenThreadHandled();
  }, [openThreadId, activeThreads, onOpenThreadHandled]);

  const selectedProject = projects.find((project) => project.repoId === selectedThread?.projectRepoId);
  const selectedRepoId = selectedThread?.projectRepoId;
  const selectedWorkId = selectedThread?.workId;

  useEffect(() => {
    if (!selectedRepoId) { setWorkIndex([]); setWorkIndexError(undefined); return; }
    let active = true;
    setWorkIndex([]);
    setWorkIndexError(undefined);
    void invoke<{ data?: {
      works?: Array<{ workId: string; objective: string; state: string }>;
      recentHistory?: Array<{ workId: string; objective: string; state: string }>;
    } }>('read_project_work_list', { repoId: selectedRepoId }).then((response) => {
      if (!active) return;
      const rows = [...(response.data?.works ?? []), ...(response.data?.recentHistory ?? [])];
      setWorkIndex([...new Map(rows.map((work) => [work.workId, work] as const)).values()]);
    }).catch((cause: unknown) => {
      if (active) setWorkIndexError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [selectedRepoId]);

  useEffect(() => {
    if (!selectedRepoId || !selectedWorkId) {
      setWorkDetail(undefined); setWorkDetailError(undefined);
      return;
    }
    let active = true;
    setWorkDetail(undefined); setWorkDetailError(undefined);
    void invoke<{ data?: { work?: {
      workId: string; objective: string; state: string; requirementId?: string; planId?: string;
    } } }>('read_work_detail', { repoId: selectedRepoId, workId: selectedWorkId })
      .then((response) => {
        if (!active) return;
        const work = response.data?.work;
        if (!work || work.workId !== selectedWorkId) throw Error('Forge 未确认当前 Work 的归属');
        setWorkDetail({ ...work, repoId: selectedRepoId });
      }).catch((cause: unknown) => {
        if (active) setWorkDetailError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [selectedRepoId, selectedWorkId]);

  const projectBindingReady = !selectedRepoId || Boolean(selectedProject);
  const workBindingReady = !selectedWorkId
    || (workDetail?.repoId === selectedRepoId && workDetail?.workId === selectedWorkId);
  const apiSelected = apiSettings?.provider === 'api';
  const loopbackApi = Boolean(apiSettings && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(apiSettings.endpoint));
  const apiReady = Boolean(apiSettings?.model.trim() && (apiSettings?.hasKey || loopbackApi));
  const providerReady = (apiSelected ? apiReady : provider?.status === 'ready')
    && Boolean(onSend) && projectBindingReady && workBindingReady;

  const addThread = () => {
    const thread = createThread(selectedProvider, defaultProjectRepoId);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
    setDraft('');
    setSendError(null);
  };

  useEffect(() => {
    if (!newThreadRequested) {
      handledNewThread.current = false;
      return;
    }
    if (handledNewThread.current) return;
    handledNewThread.current = true;
    // Re-enter an existing Work-bound Agent thread rather than manufacturing
    // multiple local transcripts for the same ongoing work.
    const existing = newThreadContext
      ? findExistingWorkThread(threads, selectedProvider, newThreadContext.repoId, newThreadContext.workId)
      : undefined;
    if (existing) {
      setSelectedThreadId(existing.id);
      if (existing.id !== selectedThreadId) setDraft('');
    } else {
      const thread = createThread(
        selectedProvider, newThreadContext?.repoId ?? defaultProjectRepoId,
        newThreadContext?.workId,
      );
      setThreads((current) => [thread, ...current]);
      setSelectedThreadId(thread.id);
      setDraft('');
    }
    setSendError(null);
    onNewThreadHandled();
  }, [newThreadRequested, selectedProvider, defaultProjectRepoId, newThreadContext,
    onNewThreadHandled, threads, selectedThreadId]);

  useEffect(() => {
    if (newThreadRequested || activeThreads.length > 0 || initialThreadProvisioned.current === selectedProvider) return;
    initialThreadProvisioned.current = selectedProvider;
    const thread = createThread(selectedProvider, defaultProjectRepoId);
    setThreads((current) => current.some((entry) => !entry.archived && (entry.provider ?? 'codex') === selectedProvider)
      ? current : [thread, ...current]);
    setSelectedThreadId(thread.id);
  }, [activeThreads.length, selectedProvider, defaultProjectRepoId, newThreadRequested]);

  const updateSelected = (updater: (thread: LocalConversationThread) => LocalConversationThread) => {
    if (!selectedThread) return;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? updater(thread) : thread));
  };

  async function toggleDiff(forceRefresh = false) {
    const repoId = selectedThread?.projectRepoId;
    if (!repoId) return;
    if (diffVisible && !forceRefresh && diffRepoId === repoId) {
      diffRequest.current += 1;
      setDiffVisible(false);
      return;
    }
    const request = ++diffRequest.current;
    setDiffRepoId(repoId);
    setDiffVisible(true);
    setDiff(undefined);
    setDiffError(undefined);
    setDiffLoading(true);
    try {
      const response = await invoke<GitDiffReceipt>(
        'read_agent_git_diff', { repoId },
      );
      if (request === diffRequest.current) setDiff(response);
    } catch (cause) {
      if (request === diffRequest.current) {
        setDiffError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (request === diffRequest.current) setDiffLoading(false);
    }
  }

  const send = async () => {
    const prompt = draft.trim();
    if (!selectedThread || !providerReady || !onSend || !prompt || sending) return;
    const authorizedEffects = apiSelected && allowEffects && Boolean(selectedProject);
    if (authorizedEffects && !window.confirm(
      '仅本次回复：允许当前 API 模型通过 Forge 修改所选仓库及执行命令。Forge 原有安全检查仍生效。确认授权？'
    )) return;
    const createdAt = new Date().toISOString();
    const userMessage: LocalConversationMessage = { id: localId('message'), role: 'user', content: prompt, createdAt };
    const pendingThread: LocalConversationThread = {
      ...selectedThread,
      title: selectedThread.messages.length === 0 ? prompt.slice(0, 52) : selectedThread.title,
      updatedAt: createdAt,
      messages: [...selectedThread.messages, userMessage],
    };
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? pendingThread : thread));
    setDraft('');
    setSendError(null);
    sendingThreadRef.current = selectedThread.id;
    setSendingThreadId(selectedThread.id);
    setCancelRequested(false);
    setToolProgress([]);
    setSending(true);
    try {
      const reply = await onSend({ thread: pendingThread, prompt, allowEffects: authorizedEffects });
      const repliedAt = new Date().toISOString();
      const assistantMessage: LocalConversationMessage = {
        id: localId('message'), role: 'assistant', content: reply.content, createdAt: repliedAt,
        ...(typeof reply.toolActivityCount === 'number' ? { toolActivityCount: reply.toolActivityCount } : {}),
        ...(reply.toolEvents ? { toolEvents: reply.toolEvents } : {}),
      };
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? {
        ...thread,
        ...(reply.providerSessionId ? { providerSessionId: reply.providerSessionId } : {}),
        updatedAt: repliedAt,
        messages: [...thread.messages, ...(reply.messages ?? []), assistantMessage],
      } : thread));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const cancelled = reason.includes('FORGE_DESKTOP_API_TURN_CANCELLED')
        || reason.includes('LOCAL_CONVERSATION_CANCELLED_RECONCILE');
      if (cancelled) {
        const cancelledAt = new Date().toISOString();
        const exactEffectId = reason.match(
          /FORGE_DESKTOP_API_TURN_CANCELLED_AFTER_TOOL:([a-zA-Z0-9._:-]+)/,
        )?.[1];
        setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? {
          ...thread,
          updatedAt: cancelledAt,
          messages: [...thread.messages, {
            id: localId('message'), role: 'system', createdAt: cancelledAt,
            content: reason.includes('_AFTER_TOOL:') || reason.includes('CANCELLED_RECONCILE')
              ? '已停止等待模型继续执行。已有 Forge 工具可能已经完成；请核对当前仓库与操作请求记录。'
                + (exactEffectId ? '\n\nForge 操作请求 ID：\`' + exactEffectId + '\`' : '')
              : '已停止此次模型回复；已发送的远端请求可能仍会计费。',
          }],
        } : thread));
        setSendError(null);
      } else {
        setSendError('本次回复未确认：' + reason + '。若可能涉及工具操作，请先检查 Forge 结果再决定是否重新发送。');
      }
    } finally {
      setAllowEffects(false);
      sendingThreadRef.current = undefined;
      setToolProgress([]);
      setSendingThreadId(undefined);
      setCancelRequested(false);
      setSending(false);
    }
  };

  const cancelTurn = async () => {
    if (!(apiSelected || provider?.cancellable === true) || !sending || !selectedThread
      || sendingThreadId !== selectedThread.id || !onCancel || cancelRequested) return;
    setCancelRequested(true);
    setSendError(null);
    try {
      await onCancel(selectedThread);
    } catch (cause) {
      // No success claim: the turn may have completed in the time between
      // clicking and the native cancel request.
      setCancelRequested(false);
      setSendError('未确认停止：' + (cause instanceof Error ? cause.message : String(cause)));
    }
  };

  return (
    <section className={'local-conversation' + (diffVisible && diffRepoId === selectedThread?.projectRepoId ? ' with-diff' : '')} aria-label="本地会话">
      <div className="local-toolbar">
        <div>
          <span className="breadcrumb">本地会话</span>
          <strong>{selectedThread ? threadLabel(selectedThread) : '新建一个会话'}</strong>
        </div>
        <div className="local-toolbar-actions">
          <button className="plain-action" type="button"
            disabled={!selectedThread?.projectRepoId}
            aria-expanded={diffVisible && diffRepoId === selectedThread?.projectRepoId}
            onClick={() => void toggleDiff()}>
            {diffVisible && diffRepoId === selectedThread?.projectRepoId ? '收起变更' : '查看变更'}
          </button>
          <button className="plain-action" type="button" disabled={sending} onClick={addThread}>新建会话</button>
          {selectedThread && (
            <button className="plain-action" type="button" disabled={sending} onClick={() => {
              updateSelected((thread) => ({ ...thread, archived: true, updatedAt: new Date().toISOString() }));
              setSelectedThreadId(activeThreads.find((thread) => thread.id !== selectedThread.id)?.id);
            }}>归档</button>
          )}
        </div>
      </div>

      <div className={'local-provider ' + (apiSelected ? (apiReady ? 'ready' : 'unavailable') : provider?.status ?? 'unavailable')}>
        <span className={'health-dot ' + (apiSelected ? (apiReady ? 'connected' : 'degraded') : provider?.status === 'ready' ? 'connected' : 'degraded')} />
        <div>
          <strong>{apiSelected ? (apiReady ? '兼容 API 已配置' : '兼容 API 尚未配置') : providerLoading ? '正在读取 Codex' : provider?.label ?? 'Codex 不可用'}</strong>
          <p>{apiSelected ? (apiReady
              ? '模型：' + apiSettings?.model + ' · ' + (apiSettings?.apiProtocol === 'anthropic' ? 'Claude Messages' : 'OpenAI Chat Completions')
                + ' · 本地直接调用 Forge 工具'
              : '请在设置中配置 Endpoint、模型与所需密钥。')
              : providerError ?? provider?.detail ?? '本地会话通过 Forge Controller 运行 Codex。'}</p>
        </div>
        <button className="plain-action" type="button" disabled={!apiSelected && providerLoading} onClick={() => apiSelected ? onOpenSettings() : void onRefreshProvider()}>{apiSelected ? 'API 设置' : '刷新'}</button>
      </div>

      {!selectedThread ? (
        <div className="local-empty">
          <strong>开始一个本地会话</strong>
          <p>会话记录只属于桌面客户端；Requirement、Plan 和 Work 仍由 Forge 保持唯一权威。</p>
          <button className="plain-action" type="button" onClick={addThread}>新建会话</button>
        </div>
      ) : (
        <>
          <div className="local-context-row">
            <label>
              <span>项目上下文</span>
              <select
                value={selectedThread.projectRepoId ?? ''}
                disabled={sending}
                onChange={(event) => {
                  const nextRepoId = event.target.value || undefined;
                  if (nextRepoId === selectedThread.projectRepoId) return;
                  setAllowEffects(false);
                  setSendError(null);
                  if (selectedThread.messages.length > 0) {
                    // Never silently rebind an established transcript (or
                    // Codex resume handle) to another repository.
                    const next = createThread(selectedProvider, nextRepoId);
                    setThreads((current) => [next, ...current]);
                    setSelectedThreadId(next.id);
                    setDraft('');
                  } else {
                    updateSelected((thread) => ({
                      ...thread,
                      projectRepoId: nextRepoId,
                      workId: undefined,
                      providerSessionId: undefined,
                      updatedAt: new Date().toISOString(),
                    }));
                  }
                }}
              >
                <option value="">不附加项目（纯对话）</option>
                {projects.map((project) => <option key={project.repoId} value={project.repoId}>{project.name}</option>)}
              </select>
            </label>
            <span>{selectedProject ? '仓库工具仅作用于 ' + selectedProject.name : '选择项目后启用仓库工具'}</span>
          </div>
          {selectedRepoId && (
            <div className="local-work-context">
              <label>
                <span>关联已有 Work（可选）</span>
                <select aria-label="会话关联的 Forge Work" value={selectedWorkId ?? ''} disabled={sending}
                  onChange={(event) => {
                    const nextWorkId = event.target.value || undefined;
                    if (nextWorkId === selectedWorkId) return;
                    if (selectedThread.messages.length > 0) {
                      // A Work switch never silently rebinds existing Agent output.
                      const next = createThread(selectedProvider, selectedRepoId, nextWorkId);
                      setThreads((current) => [next, ...current]);
                      setSelectedThreadId(next.id);
                      setDraft('');
                    } else {
                      updateSelected((thread) => ({
                        ...thread, workId: nextWorkId, providerSessionId: undefined,
                        updatedAt: new Date().toISOString(),
                      }));
                    }
                    setSendError(null);
                  }}>
                  <option value="">不关联 Work</option>
                  {selectedWorkId && !workIndex.some((work) => work.workId === selectedWorkId) && (
                    <option value={selectedWorkId}>{selectedWorkId} · 当前列表以外</option>
                  )}
                  {workIndex.map((work) => (
                    <option value={work.workId} key={work.workId}>
                      {work.state === 'open' ? '进行中' : '历史'} · {work.objective.slice(0, 72)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedWorkId && workBindingReady && workDetail && (
                <div className="local-work-links">
                  <button type="button" onClick={() => onOpenWork?.(selectedRepoId, workDetail.workId)}>
                    查看 Work
                  </button>
                  {workDetail.requirementId && <button type="button"
                    onClick={() => onOpenRecord?.(selectedRepoId, 'requirements', workDetail.requirementId!)}>
                    Requirement
                  </button>}
                  {workDetail.planId && <button type="button"
                    onClick={() => onOpenRecord?.(selectedRepoId, 'plans', workDetail.planId!)}>
                    Plan
                  </button>}
                </div>
              )}
              {!projectBindingReady && <small role="alert">此会话引用的项目已不在当前注册目录中，请选择有效项目。</small>}
              {workIndexError && <small role="status">Work 目录读取失败：{workIndexError}</small>}
              {selectedWorkId && !workBindingReady && (
                <small role="alert">{workDetailError ?? '正在核对 Forge Work 与项目归属…'}</small>
              )}
            </div>
          )}

          {diffVisible && diffRepoId === selectedThread.projectRepoId && (
            <AgentGitReview diff={diff} loading={diffLoading} error={diffError}
              onRefresh={() => void toggleDiff(true)}
              onClose={() => { diffRequest.current += 1; setDiffVisible(false); }} />
          )}

          <div className="local-transcript">
            {selectedThread.messages.length === 0 ? (
              <div className="local-empty transcript-empty">
                <strong>让 Forge 完成一个任务</strong>
                <p>选择项目，描述目标。Agent 可读取代码、使用工具，并在会话中保留结果。</p>
              </div>
            ) : selectedThread.messages.map((message) => (
              <article className={'local-message ' + message.role} key={message.id}>
                <div className="local-message-heading">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Forge 助手' : message.role === 'tool' ? '工具' : '系统'}</strong>
                  <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <LocalMessageBody content={message.content} />
                {message.role === 'assistant' && typeof message.toolActivityCount === 'number' && message.toolActivityCount > 0 && (
                  <details className="local-tool-summary">
                    <summary>Forge 工具执行 · {message.toolActivityCount} 次</summary>
                    {message.toolEvents?.length ? message.toolEvents.map((event, index) => (
                      <div className="local-tool-event" key={index}>
                        <span>{event.name}{event.requestId && <code title="Forge 操作请求标识"> · {event.requestId}</code>}</span>
                        <strong>{event.ok ? '已执行' : '失败'}</strong>
                      </div>
                    )) : <p>当前提供方仅返回调用次数，未提供逐项执行记录。</p>}
                  </details>
                )}
              </article>
            ))}
            {sending && sendingThreadId === selectedThread.id && (
              <div className="local-pending-message" role="status">
                <span className="local-pending-indicator" />
                <div className="local-pending-content">
                <span>{cancelRequested ? '已请求停止；如果 Forge 工具正在运行，将在收到结果后结束…'
                  : toolProgress.some((event) => event.phase === 'started')
                    ? 'Agent 正在使用 Forge 工具…'
                    : toolProgress.length > 0 ? '工具调用已返回，正在整理回复…'
                    : 'Agent 正在处理请求…'}</span>
                {toolProgress.length > 0 && (
                  <div className="local-tool-progress-list" aria-label="本轮 Forge 工具进度">
                    {toolProgress.slice(-6).map((event, index) => (
                      <div className={'local-tool-progress-row ' + event.phase} key={index}>
                        <span>{event.name}</span>
                        <small>{event.phase === 'started' ? '执行中' : event.phase === 'completed' ? '已完成' : '失败'}</small>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>

          <div className="local-composer">
            <textarea
              rows={3}
              aria-label="本地会话消息"
              placeholder={providerReady ? '描述任务或提出问题…' : '先写下任务，配置模型或恢复连接后发送…'}
              value={draft}
              disabled={sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {apiSelected && selectedProject && (
              <label className="local-tool-permission">
                <input type="checkbox" disabled={sending} checked={allowEffects}
                  onChange={(event) => setAllowEffects(event.target.checked)} />
                本次允许修改文件及执行命令（发送时确认）
              </label>
            )}
            {sendError && <div role="alert" className="composer-error">{sendError}</div>}
            <div className="composer-footer">
              <span className="local-provider-selection">
                <span>{selectedProject?.name ?? '本地'}</span>
                <button className="local-provider-switch" type="button" onClick={onOpenSettings}
                  aria-label="切换聊天模型及 API 设置">
                  {apiSelected ? (apiSettings?.model || '兼容 API') : 'Codex CLI'} <span aria-hidden="true">⌄</span>
                </button>
              </span>
              {sending && sendingThreadId === selectedThread.id
                && (apiSelected || provider?.cancellable === true) && (
                <button className="local-stop-button" type="button" onClick={() => void cancelTurn()}
                  aria-label="请求停止当前 Agent 回复" disabled={cancelRequested}>
                  {cancelRequested ? '停止中' : '停止'}
                </button>
              )}
              <button className="local-send-button" type="button" aria-label={sending ? '正在发送' : '发送消息'}
                disabled={!providerReady || !draft.trim() || sending} onClick={() => void send()}>
                <span aria-hidden="true">{sending ? '…' : '↑'}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
