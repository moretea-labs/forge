import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocalProviderStatusProjection } from './runtime-client';
import type { ProjectListItemProjection } from './runtime-projection';
import type { LocalApiSettings, LocalProviderChoice } from './local-api';

const LOCAL_THREADS_KEY = 'forge.desktop.local-threads.v1';
const MAX_THREADS = 100;

export type LocalConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export interface LocalConversationMessage {
  id: string;
  role: LocalConversationRole;
  content: string;
  createdAt: string;
  toolActivityCount?: number;
}

export interface LocalConversationThread {
  id: string;
  title: string;
  projectRepoId?: string;
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
  messages?: LocalConversationMessage[];
}

function localId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createThread(provider: LocalProviderChoice, projectRepoId?: string): LocalConversationThread {
  const timestamp = new Date().toISOString();
  return {
    id: localId('thread'),
    title: '新会话',
    provider,
    ...(projectRepoId ? { projectRepoId } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    messages: [],
  };
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
}: {
  projects: ProjectListItemProjection[];
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
  onSend?: (input: { thread: LocalConversationThread; prompt: string }) => Promise<LocalConversationReply>;
}) {
  const [threads, setThreads] = useState<LocalConversationThread[]>(() => loadThreads());
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(() => loadThreads().find((thread) => !thread.archived)?.id);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handledNewThread = useRef(false);
  const initialThreadProvisioned = useRef<LocalProviderChoice | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { persistThreads(threads); }, [threads]);

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
  const apiSelected = apiSettings?.provider === 'api';
  const loopbackApi = Boolean(apiSettings && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(apiSettings.endpoint));
  const apiReady = Boolean(apiSettings?.model.trim() && (apiSettings?.hasKey || loopbackApi));
  const providerReady = (apiSelected ? apiReady : provider?.status === 'ready') && Boolean(onSend);

  const addThread = () => {
    const thread = createThread(selectedProvider);
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
    const thread = createThread(selectedProvider);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
    setDraft('');
    setSendError(null);
    onNewThreadHandled();
  }, [newThreadRequested, selectedProvider, onNewThreadHandled]);

  useEffect(() => {
    if (newThreadRequested || activeThreads.length > 0 || initialThreadProvisioned.current === selectedProvider) return;
    initialThreadProvisioned.current = selectedProvider;
    const thread = createThread(selectedProvider);
    setThreads((current) => current.some((entry) => !entry.archived && (entry.provider ?? 'codex') === selectedProvider)
      ? current : [thread, ...current]);
    setSelectedThreadId(thread.id);
  }, [activeThreads.length, selectedProvider, newThreadRequested]);

  const updateSelected = (updater: (thread: LocalConversationThread) => LocalConversationThread) => {
    if (!selectedThread) return;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? updater(thread) : thread));
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!selectedThread || !providerReady || !onSend || !prompt || sending) return;
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
    setSending(true);
    try {
      const reply = await onSend({ thread: pendingThread, prompt });
      const repliedAt = new Date().toISOString();
      const assistantMessage: LocalConversationMessage = {
        id: localId('message'), role: 'assistant', content: reply.content, createdAt: repliedAt,
        ...(typeof reply.toolActivityCount === 'number' ? { toolActivityCount: reply.toolActivityCount } : {}),
      };
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? {
        ...thread,
        ...(reply.providerSessionId ? { providerSessionId: reply.providerSessionId } : {}),
        updatedAt: repliedAt,
        messages: [...thread.messages, ...(reply.messages ?? []), assistantMessage],
      } : thread));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setSendError('本次回复未确认：' + reason + '。若可能涉及工具操作，请先检查 Forge 结果再决定是否重新发送。');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="local-conversation" aria-label="本地会话">
      <div className="local-toolbar">
        <div>
          <span className="breadcrumb">本地会话</span>
          <strong>{selectedThread ? threadLabel(selectedThread) : '新建一个会话'}</strong>
        </div>
        <div className="local-toolbar-actions">
          <button className="plain-action" type="button" onClick={addThread}>新建会话</button>
          {selectedThread && (
            <button className="plain-action" type="button" onClick={() => {
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
          <p>{apiSelected ? (apiReady ? '当前模型：' + apiSettings?.model + ' · 独立文本聊天，不使用 Forge MCP 工具' : '请在设置中配置 Endpoint、模型与所需密钥。') : providerError ?? provider?.detail ?? '本地会话通过 Forge Controller 运行 Codex。'}</p>
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
                onChange={(event) => updateSelected((thread) => ({
                  ...thread,
                  ...(event.target.value ? { projectRepoId: event.target.value } : { projectRepoId: undefined }),
                  updatedAt: new Date().toISOString(),
                }))}
              >
                <option value="">不附加项目</option>
                {projects.map((project) => <option key={project.repoId} value={project.repoId}>{project.name}</option>)}
              </select>
            </label>
            <span>{selectedProject ? `仅引用 ${selectedProject.name} 的 canonical repository identity` : '此会话不绑定项目'}</span>
          </div>

          <div className="local-transcript">
            {selectedThread.messages.length === 0 ? (
              <div className="local-empty transcript-empty"><p>消息会保存在这个客户端，不会自动创建 Requirement、Plan 或 Work。</p></div>
            ) : selectedThread.messages.map((message) => (
              <article className={'local-message ' + message.role} key={message.id}>
                <div className="local-message-heading">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Forge 助手' : message.role === 'tool' ? '工具' : '系统'}</strong>
                  <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <LocalMessageBody content={message.content} />
                {message.role === 'assistant' && typeof message.toolActivityCount === 'number' && message.toolActivityCount > 0 && (
                  <div className="local-tool-summary">调用 Forge 工具 {message.toolActivityCount} 次 · 当前接口未返回逐条调用记录</div>
                )}
              </article>
            ))}
            {sending && <div className="local-pending-message" role="status"><span className="local-pending-indicator" />正在生成回复…</div>}
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
            {sendError && <div role="alert" className="composer-error">{sendError}</div>}
            <div className="composer-footer">
              <span className="local-provider-selection">
                <span>{selectedProject?.name ?? '本地'}</span>
                <button className="local-provider-switch" type="button" onClick={onOpenSettings}
                  aria-label="切换聊天模型及 API 设置">
                  {apiSelected ? (apiSettings?.model || '兼容 API') : 'Codex CLI'} <span aria-hidden="true">⌄</span>
                </button>
              </span>
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
