import { useEffect, useMemo, useState } from 'react';
import type { LocalProviderStatusProjection } from './runtime-client';
import type { ProjectListItemProjection } from './runtime-projection';

const LOCAL_THREADS_KEY = 'forge.desktop.local-threads.v1';
const MAX_THREADS = 100;

export type LocalConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export interface LocalConversationMessage {
  id: string;
  role: LocalConversationRole;
  content: string;
  createdAt: string;
}

export interface LocalConversationThread {
  id: string;
  title: string;
  projectRepoId?: string;
  providerSessionId?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: LocalConversationMessage[];
}

export interface LocalConversationReply {
  content: string;
  providerSessionId?: string;
  messages?: LocalConversationMessage[];
}

function localId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createThread(projectRepoId?: string): LocalConversationThread {
  const timestamp = new Date().toISOString();
  return {
    id: localId('thread'),
    title: '新会话',
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

export function LocalConversationSurface({
  projects,
  provider,
  providerLoading,
  providerError,
  onRefreshProvider,
  onSend,
}: {
  projects: ProjectListItemProjection[];
  provider: LocalProviderStatusProjection | null;
  providerLoading: boolean;
  providerError: string | null;
  onRefreshProvider: () => Promise<void>;
  onSend?: (input: { thread: LocalConversationThread; prompt: string }) => Promise<LocalConversationReply>;
}) {
  const [threads, setThreads] = useState<LocalConversationThread[]>(() => loadThreads());
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(() => loadThreads().find((thread) => !thread.archived)?.id);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => { persistThreads(threads); }, [threads]);

  const activeThreads = useMemo(() => threads.filter((thread) => !thread.archived), [threads]);
  const selectedThread = activeThreads.find((thread) => thread.id === selectedThreadId) ?? activeThreads[0];
  const selectedProject = projects.find((project) => project.repoId === selectedThread?.projectRepoId);
  const providerReady = provider?.status === 'ready' && Boolean(onSend);

  const addThread = () => {
    const thread = createThread();
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
    setDraft('');
    setSendError(null);
  };

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
      const assistantMessage: LocalConversationMessage = { id: localId('message'), role: 'assistant', content: reply.content, createdAt: repliedAt };
      setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? {
        ...thread,
        ...(reply.providerSessionId ? { providerSessionId: reply.providerSessionId } : {}),
        updatedAt: repliedAt,
        messages: [...thread.messages, ...(reply.messages ?? []), assistantMessage],
      } : thread));
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
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
          {selectedThread && (
            <select
              aria-label="会话"
              value={selectedThread.id}
              onChange={(event) => setSelectedThreadId(event.target.value)}
            >
              {activeThreads.map((thread) => <option key={thread.id} value={thread.id}>{threadLabel(thread)}</option>)}
            </select>
          )}
          <button className="plain-action" type="button" onClick={addThread}>新建会话</button>
          {selectedThread && (
            <button className="plain-action" type="button" onClick={() => {
              updateSelected((thread) => ({ ...thread, archived: true, updatedAt: new Date().toISOString() }));
              setSelectedThreadId(activeThreads.find((thread) => thread.id !== selectedThread.id)?.id);
            }}>归档</button>
          )}
        </div>
      </div>

      <div className={`local-provider ${provider?.status ?? 'unavailable'}`}>
        <span className={`health-dot ${provider?.status === 'ready' ? 'connected' : 'degraded'}`} />
        <div>
          <strong>{providerLoading ? '正在读取本地模型连接' : provider?.label ?? '本地模型不可用'}</strong>
          <p>{providerError ?? provider?.detail ?? '本地会话由 Controller provider adapter 执行；不会为了聊天隐式创建 Work。'}</p>
        </div>
        <button className="plain-action" type="button" disabled={providerLoading} onClick={() => void onRefreshProvider()}>刷新</button>
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
              <article className={`local-message ${message.role}`} key={message.id}>
                <span>{message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : message.role === 'tool' ? '工具' : '系统'}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>

          <div className="local-composer">
            <textarea
              rows={3}
              aria-label="本地会话消息"
              placeholder={providerReady ? '输入消息…' : '本地 provider 接入后即可发送消息'}
              value={draft}
              disabled={!providerReady || sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {sendError && <div className="composer-error">发送失败：{sendError}</div>}
            <div className="composer-footer">
              <span>{selectedProject?.name ?? '本地'} · 客户端会话</span>
              <button type="button" disabled={!providerReady || !draft.trim() || sending} onClick={() => void send()}>{sending ? '发送中…' : '发送'}</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
