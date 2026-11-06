import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentGitReview, splitGitDiffFiles, type GitDiffReceipt } from './agent-git-review';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocalProviderStatusProjection } from './runtime-client';
import type { ProjectListItemProjection } from './runtime-projection';
import type { LocalApiSettings, LocalProviderChoice, LocalApiToolEvent } from './local-api';
import { ForgeIcon as AgentControlIcon } from './ui-icons';

const LOCAL_THREADS_KEY = 'forge.desktop.local-threads.v1';
const LOCAL_DRAFTS_KEY = 'forge.desktop.local-drafts.v1';
const MAX_THREADS = 100;

export type LocalConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export interface LocalToolProgress {
  conversationId: string;
  name: string;
  phase: 'started' | 'completed' | 'failed';
  requestId?: string;
}

/** Geometry-based following avoids moving the viewport while reading earlier messages. */
export function transcriptIsNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 96;
}

/** Enter submits; Shift/Option+Enter inserts text and IME confirmation never submits. */
export function shouldSubmitComposerKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'>,
  busy: boolean,
): boolean {
  return !busy && event.key === 'Enter' && !event.shiftKey && !event.altKey
    && !event.isComposing && event.keyCode !== 229;
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
  // Exact registered checkout identity, fixed for an established transcript.
  checkoutId?: string;
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

export function createThread(
  provider: LocalProviderChoice, projectRepoId?: string, workId?: string, checkoutId?: string,
): LocalConversationThread {
  const timestamp = new Date().toISOString();
  return {
    id: localId('thread'),
    title: '新会话',
    provider,
    ...(projectRepoId ? { projectRepoId } : {}),
    ...(projectRepoId && checkoutId ? { checkoutId } : {}),
    ...(projectRepoId && workId ? { workId } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    messages: [],
  };
}

/** Checkout switching never rebinds established messages or provider sessions. */
export function selectThreadCheckout(
  thread: LocalConversationThread, provider: LocalProviderChoice, checkoutId: string,
): { thread: LocalConversationThread; created: boolean } {
  if (thread.checkoutId === checkoutId) return { thread, created: false };
  if (thread.messages.length > 0 || thread.providerSessionId) {
    return { thread: createThread(provider, thread.projectRepoId, undefined, checkoutId), created: true };
  }
  return {
    thread: { ...thread, checkoutId, workId: undefined, providerSessionId: undefined,
      updatedAt: new Date().toISOString() },
    created: false,
  };
}

/** Repository selection may replace an empty draft, never a transcript or resume handle. */
export function selectThreadRepository(
  thread: LocalConversationThread, provider: LocalProviderChoice, nextRepoId?: string,
  nextCheckoutId?: string,
): { thread: LocalConversationThread; created: boolean } {
  if (thread.projectRepoId === nextRepoId) return { thread, created: false };
  if (thread.messages.length > 0 || thread.providerSessionId) {
    return { thread: createThread(provider, nextRepoId, undefined, nextCheckoutId), created: true };
  }
  return {
    thread: {
      ...thread, projectRepoId: nextRepoId, checkoutId: nextCheckoutId, workId: undefined,
      providerSessionId: undefined, updatedAt: new Date().toISOString(),
    },
    created: false,
  };
}

export function findExistingWorkThread(
  threads: LocalConversationThread[], provider: LocalProviderChoice, repoId: string, workId: string,
  checkoutId?: string,
): LocalConversationThread | undefined {
  return threads.filter((thread) => !thread.archived && (thread.provider ?? 'codex') === provider
    && thread.projectRepoId === repoId && thread.checkoutId === checkoutId && thread.workId === workId)
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

// Drafts belong only to their conversation ID. Keep them separate from the
// transcript so typing does not rewrite up to 100 complete message histories.
function loadDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([id, draft]) => id.length <= 160 && typeof draft === 'string')
      .slice(0, MAX_THREADS)) as Record<string, string>;
  } catch {
    return {};
  }
}

function threadLabel(thread: LocalConversationThread): string {
  return thread.title.trim() || '新会话';
}

export interface LocalConversationNavItem {
  id: string;
  title: string;
  updatedAt: string;
  provider: LocalProviderChoice;
  draft?: boolean;
}

/** The existing sidebar is the navigation authority for sent and unsent threads. */
export function localConversationNavItems(
  threads: LocalConversationThread[], drafts: Record<string, string>,
): LocalConversationNavItem[] {
  return threads.filter((thread) => !thread.archived
    && (thread.messages.length > 0 || Boolean(drafts[thread.id]?.trim())))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({
      id: thread.id,
      title: thread.messages.length ? threadLabel(thread) : drafts[thread.id]!.trim().slice(0, 52),
      updatedAt: thread.updatedAt,
      provider: thread.provider ?? 'codex',
      ...(thread.messages.length ? {} : { draft: true }),
    }));
}

function closeAgentMenus(root: HTMLElement | null, keep: Element | null = null): HTMLDetailsElement | undefined {
  let lastClosed: HTMLDetailsElement | undefined;
  root?.querySelectorAll<HTMLDetailsElement>(
    'details.agent-context-menu[open], details.agent-header-menu[open]',
  ).forEach((menu) => {
    if (menu !== keep) {
      menu.open = false;
      lastClosed = menu;
    }
  });
  return lastClosed;
}

function CopyTextAction({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return <span className="agent-copy-action">
    <button type="button" aria-label={label} title={label} disabled={!text}
      onClick={() => void copy()}>
      <AgentControlIcon name={state === 'copied' ? 'check' : 'copy'} size={15} />
    </button>
    {state === 'copied' && <small role="status">已复制</small>}
    {state === 'failed' && <small role="alert">复制不可用，请手动选中文本</small>}
  </span>;
}

function textOfMarkdown(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfMarkdown).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? textOfMarkdown(node.props.children) : '';
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const source = textOfMarkdown(children);
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/language-([\w+-]+)/)?.[1] : undefined;
  return <div className="local-code-block">
    <div className="local-code-label">
      <span>{language ?? '代码'}</span>
      <CopyTextAction text={source} label="复制代码" />
    </div>
    <pre>{children}</pre>
  </div>;
}

export function LocalMessageBody({ content }: { content: string }) {
  return <div className="local-message-body">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
    }}>{content}</ReactMarkdown>
  </div>;
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
  onOpenProjects,
  onOpenKnowledge,
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
  newThreadContext?: { repoId: string; workId?: string };
  onOpenWork?: (repoId: string, workId: string) => void;
  onOpenRecord?: (repoId: string, mode: 'requirements' | 'plans', id: string) => void;
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
  onSend?: (input: { thread: LocalConversationThread; prompt: string; allowEffects: boolean }) => Promise<LocalConversationReply>;
  onCancel?: (thread: LocalConversationThread) => Promise<void>;
}) {
  const [threads, setThreads] = useState<LocalConversationThread[]>(() => loadThreads());
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(() => loadThreads().find((thread) => !thread.archived)?.id);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const [sending, setSending] = useState(false);
  const [sendingThreadId, setSendingThreadId] = useState<string>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [toolProgress, setToolProgress] = useState<LocalToolProgress[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [allowEffects, setAllowEffects] = useState(false);
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffStaged, setDiffStaged] = useState(false);
  const [diffRepoId, setDiffRepoId] = useState<string>();
  const [diffCheckoutId, setDiffCheckoutId] = useState<string>();
  const [diffThreadId, setDiffThreadId] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string>();
  const [commitSuccess, setCommitSuccess] = useState<{ threadId: string; head: string }>();
  const [diff, setDiff] = useState<GitDiffReceipt>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string>();
  const [checkoutIndex, setCheckoutIndex] = useState<Array<{
    checkoutId: string; branch?: string; path?: string; active: boolean;
  }>>([]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string>();
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerTextRef = useRef<HTMLTextAreaElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => { persistThreads(threads); }, [threads]);
  useEffect(() => { localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(drafts)); }, [drafts]);

  // The native details controls remain the only menu owner. Outside clicks,
  // keyboard Escape and navigation close them without a separate menu state.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      closeAgentMenus(surfaceRef.current,
        target?.closest('details.agent-context-menu,details.agent-header-menu') ?? null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const closed = closeAgentMenus(surfaceRef.current);
      if (closed) {
        event.preventDefault();
        event.stopPropagation();
        closed.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
      } else if (diffVisible && !committing) {
        diffRequest.current += 1;
        setDiffVisible(false);
        event.preventDefault();
        event.stopPropagation();
        composerTextRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [diffVisible, committing]);

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
  const draft = selectedThread ? drafts[selectedThread.id] ?? '' : '';
  const currentThreadIdRef = useRef<string | undefined>(undefined);
  currentThreadIdRef.current = selectedThread?.id;
  // Preserve history-reading position when a response or tool event arrives.
  // Only the active thread switch forces the transcript to its latest entry.
  useEffect(() => {
    setFollowLatest(true);
    const viewport = transcriptRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    // A different transcript must not reuse another thread's Git review.
    diffRequest.current += 1;
    setDiffVisible(false);
    closeAgentMenus(surfaceRef.current);
    // Focus the task entry only when this Agent view is actually visible.
    if (surfaceRef.current?.getClientRects().length) {
      composerTextRef.current?.focus({ preventScroll: true });
    }
  }, [selectedThread?.id]);
  useEffect(() => {
    const viewport = transcriptRef.current;
    if (viewport && followLatest) viewport.scrollTop = viewport.scrollHeight;
  }, [selectedThread?.messages.length, sending, toolProgress.length, followLatest]);
  useEffect(() => {
    const textarea = composerTextRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 192) + 'px';
    textarea.style.overflowY = textarea.scrollHeight > 192 ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => {
    // Empty drafts are not history. Keep them in the single local owner until
    // a first user message makes the thread a real conversation.
    const items = localConversationNavItems(activeThreads, drafts);
    onThreadsChange(items, items.some((item) => item.id === selectedThread?.id)
      ? selectedThread?.id : undefined, selectedThread?.projectRepoId);
  }, [activeThreads, drafts, selectedThread?.id, selectedThread?.projectRepoId, onThreadsChange]);

  useEffect(() => {
    if (!openThreadId) return;
    if (activeThreads.some((thread) => thread.id === openThreadId)) {
      setSelectedThreadId(openThreadId);
      setSendError(null);
    }
    onOpenThreadHandled();
  }, [openThreadId, activeThreads, onOpenThreadHandled]);

  const selectedProject = projects.find((project) => project.repoId === selectedThread?.projectRepoId);
  const selectedRepoId = selectedThread?.projectRepoId;
  const selectedWorkId = selectedThread?.workId;

  // An effect permission is for exactly one conversation context. It must not
  // carry into a different thread, Work, repository or registered checkout.
  useEffect(() => { setAllowEffects(false); },
    [selectedThread?.id, selectedRepoId, selectedThread?.checkoutId, selectedWorkId]);

  // Catalog load may complete after an empty draft was first created.
  // Never rewrite a conversation with messages or a provider resume handle.
  useEffect(() => {
    if (!selectedThread || !selectedProject?.checkoutId || selectedThread.checkoutId
      || selectedThread.messages.length || selectedThread.providerSessionId) return;
    setThreads((current) => current.map((thread) =>
      thread.id === selectedThread.id && !thread.messages.length && !thread.providerSessionId
        ? { ...thread, checkoutId: selectedProject.checkoutId } : thread));
  }, [selectedThread?.id, selectedThread?.checkoutId, selectedThread?.messages.length,
    selectedThread?.providerSessionId, selectedProject?.checkoutId]);

  // One canonical Repository Registry read; no desktop worktree authority.
  useEffect(() => {
    if (!selectedRepoId) {
      setCheckoutIndex([]); setCheckoutError(undefined); setCheckoutLoading(false);
      return;
    }
    let active = true;
    setCheckoutLoading(true);
    setCheckoutIndex([]);
    setCheckoutError(undefined);
    void invoke<{ repository?: { checkouts?: Array<{
      checkoutId: string; branch?: string; path?: string; active?: boolean; lifecycle?: string;
    }> } }>('read_project_repository', { repoId: selectedRepoId }).then((response) => {
      if (!active) return;
      if (!Array.isArray(response.repository?.checkouts)) throw Error('Forge 未返回检出目录');
      setCheckoutIndex(response.repository.checkouts.filter((checkout) =>
        checkout.checkoutId && checkout.lifecycle === 'active'
      ).map((checkout) => ({
        checkoutId: checkout.checkoutId, branch: checkout.branch,
        path: checkout.path, active: checkout.active === true,
      })));
    }).catch((cause: unknown) => {
      if (active) setCheckoutError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setCheckoutLoading(false); });
    return () => { active = false; };
  }, [selectedRepoId]);

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
  const checkoutBindingReady = !selectedRepoId || Boolean(selectedThread?.checkoutId
    && checkoutIndex.some((checkout) => checkout.checkoutId === selectedThread.checkoutId));
  const workBindingReady = !selectedWorkId
    || (workDetail?.repoId === selectedRepoId && workDetail?.workId === selectedWorkId);
  const apiSelected = apiSettings?.provider === 'api';
  const loopbackApi = Boolean(apiSettings && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(apiSettings.endpoint));
  const apiReady = Boolean(apiSettings?.model.trim() && (apiSettings?.hasKey || loopbackApi));
  const providerReady = (apiSelected ? apiReady : provider?.status === 'ready')
    && Boolean(onSend) && projectBindingReady && checkoutBindingReady && workBindingReady;

  const addThread = () => {
    const repoId = selectedThread?.projectRepoId ?? defaultProjectRepoId;
    const checkoutId = selectedThread?.checkoutId
      ?? projects.find((project) => project.repoId === repoId)?.checkoutId;
    const thread = createThread(selectedProvider, repoId, undefined, checkoutId);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
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
    const existing = newThreadContext?.workId
      ? findExistingWorkThread(threads, selectedProvider, newThreadContext.repoId, newThreadContext.workId,
        projects.find((project) => project.repoId === newThreadContext.repoId)?.checkoutId)
      : undefined;
    if (existing) {
      setSelectedThreadId(existing.id);
    } else {
      const repoId = newThreadContext?.repoId ?? defaultProjectRepoId;
      const thread = createThread(selectedProvider, repoId, newThreadContext?.workId,
        projects.find((project) => project.repoId === repoId)?.checkoutId);
      setThreads((current) => [thread, ...current]);
      setSelectedThreadId(thread.id);
    }
    setSendError(null);
    onNewThreadHandled();
  }, [newThreadRequested, selectedProvider, defaultProjectRepoId, newThreadContext,
    onNewThreadHandled, threads, selectedThreadId]);

  useEffect(() => {
    if (newThreadRequested || activeThreads.length > 0 || initialThreadProvisioned.current === selectedProvider) return;
    initialThreadProvisioned.current = selectedProvider;
    const thread = createThread(selectedProvider, defaultProjectRepoId, undefined,
      projects.find((project) => project.repoId === defaultProjectRepoId)?.checkoutId);
    setThreads((current) => current.some((entry) => !entry.archived && (entry.provider ?? 'codex') === selectedProvider)
      ? current : [thread, ...current]);
    setSelectedThreadId(thread.id);
  }, [activeThreads.length, selectedProvider, defaultProjectRepoId, newThreadRequested]);

  const updateSelected = (updater: (thread: LocalConversationThread) => LocalConversationThread) => {
    if (!selectedThread) return;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? updater(thread) : thread));
  };

  const changeProject = (nextRepoId?: string) => {
    if (!selectedThread || sending || committing || nextRepoId === selectedThread.projectRepoId) return;
    const choice = selectThreadRepository(selectedThread, selectedProvider, nextRepoId,
      projects.find((project) => project.repoId === nextRepoId)?.checkoutId);
    if (choice.created) {
      setThreads((current) => [choice.thread, ...current]);
      setSelectedThreadId(choice.thread.id);
      setDrafts((current) => ({ ...current,
        [choice.thread.id]: current[selectedThread.id] ?? '' }));
    } else updateSelected(() => choice.thread);
    setAllowEffects(false);
    setSendError(null);
    diffRequest.current += 1;
    setDiffVisible(false);
  };

  const changeCheckout = (nextId: string) => {
    if (!selectedThread || sending || committing
      || !checkoutIndex.some((checkout) => checkout.checkoutId === nextId)) return;
    const choice = selectThreadCheckout(selectedThread, selectedProvider, nextId);
    if (choice.created) {
      setThreads((current) => [choice.thread, ...current]);
      setSelectedThreadId(choice.thread.id);
      setDrafts((current) => ({ ...current,
        [choice.thread.id]: current[selectedThread.id] ?? '' }));
    } else updateSelected(() => choice.thread);
    setAllowEffects(false);
    setSendError(null);
    diffRequest.current += 1;
    setDiffVisible(false);
    setCommitSuccess(undefined);
    setCommitError(undefined);
  };

  const changeWork = (nextWorkId?: string) => {
    if (!selectedThread || !selectedRepoId || sending || committing || nextWorkId === selectedWorkId) return;
    if (selectedThread.messages.length || selectedThread.providerSessionId) {
      const next = createThread(selectedProvider, selectedRepoId, nextWorkId, selectedThread.checkoutId);
      setThreads((current) => [next, ...current]);
      setSelectedThreadId(next.id);
      setDrafts((current) => ({ ...current, [next.id]: current[selectedThread.id] ?? '' }));
    } else updateSelected((thread) => ({
      ...thread, workId: nextWorkId, providerSessionId: undefined,
      updatedAt: new Date().toISOString(),
    }));
    setAllowEffects(false);
    setSendError(null);
  };

  const archiveThread = () => {
    if (!selectedThread || sending || committing) return;
    updateSelected((thread) => ({ ...thread, archived: true, updatedAt: new Date().toISOString() }));
    setDrafts((current) => {
      const next = { ...current };
      delete next[selectedThread.id];
      return next;
    });
    setSelectedThreadId(activeThreads.find((thread) => thread.id !== selectedThread.id)?.id);
  };

  async function toggleDiff(forceRefresh = false, staged = diffStaged) {
    const repoId = selectedThread?.projectRepoId;
    if (!repoId || !checkoutBindingReady || !selectedThread) return;
    if (diffVisible && !forceRefresh && diffRepoId === repoId
      && diffCheckoutId === selectedThread.checkoutId && diffThreadId === selectedThread.id) {
      diffRequest.current += 1;
      setDiffVisible(false);
      return;
    }
    const request = ++diffRequest.current;
    setDiffStaged(staged);
    setDiffRepoId(repoId);
    setDiffCheckoutId(selectedThread.checkoutId);
    setDiffThreadId(selectedThread.id);
    setDiffVisible(true);
    setDiff(undefined);
    setDiffError(undefined);
    setDiffLoading(true);
    try {
      const response = await invoke<GitDiffReceipt>(
        'read_agent_git_diff', { repoId, checkoutId: selectedThread?.checkoutId, staged },
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

  const commitReviewedFiles = async (paths: string[], message: string) => {
    const thread = selectedThread;
    const reviewed = diff;
    if (!thread?.projectRepoId || !thread.checkoutId || !reviewed?.patch || !reviewed.head || !reviewed.branch
      || reviewed.checkoutId !== thread.checkoutId || reviewed.truncated || diffLoading || committing || sending
      || diffRepoId !== thread.projectRepoId || diffCheckoutId !== thread.checkoutId
      || diffThreadId !== thread.id
      || paths.length < 1 || paths.length > 32
      || !paths.every((path) => splitGitDiffFiles(reviewed.patch).some((file) => file.path === path))) return;
    if (!window.confirm(
      `通过 Forge 提交以下 ${paths.length} 个文件？\n\n分支：${reviewed.branch}\n检出：${thread.checkoutId}\n\n${paths.join('\n')}\n\n提交说明：${message}\n\n仅提交本地 Git，不推送远端。`
    )) return;
    setCommitError(undefined);
    setCommitSuccess(undefined);
    setCommitting(true);
    try {
      const result = await invoke<{ committed: boolean; head: string; checkoutId: string }>(
        'commit_agent_git_files', {
          repoId: thread.projectRepoId, checkoutId: thread.checkoutId,
          conversationId: thread.id, message, paths, staged: diffStaged,
          expectedPatch: reviewed.patch, expectedHead: reviewed.head, expectedBranch: reviewed.branch,
        },
      );
      if (!result.committed || result.checkoutId !== thread.checkoutId || !result.head) {
        throw Error('Forge 未确认 Git 提交结果，请检查仓库历史后再尝试。');
      }
      if (currentThreadIdRef.current === thread.id) {
        setCommitSuccess({ threadId: thread.id, head: result.head });
        void toggleDiff(true, diffStaged);
      }
    } catch (cause) {
      if (currentThreadIdRef.current === thread.id) {
        setCommitError('提交未确认：' + (cause instanceof Error ? cause.message : String(cause))
          + '。请先查看 Git 状态，不要直接重复提交。');
      }
    } finally {
      setCommitting(false);
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!selectedThread || !providerReady || !onSend || !prompt || sending || committing) return;
    const authorizedEffects = apiSelected && allowEffects && Boolean(selectedProject && checkoutBindingReady);
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
    setDrafts((current) => ({ ...current, [selectedThread.id]: '' }));
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
    <section ref={surfaceRef} className={'local-conversation' + (diffVisible && diffThreadId === selectedThread?.id ? ' with-diff' : '')} aria-label="本地会话">
      <div className="local-toolbar agent-chat-header">
        <div className="agent-chat-heading">
          <strong title={selectedThread ? threadLabel(selectedThread) : '新会话'}>
            {selectedThread ? threadLabel(selectedThread) : '新会话'}
          </strong>
        </div>
        <div className="agent-chat-header-actions">
          <span className="agent-provider-indicator"
            title={apiSelected ? (apiReady ? `API · ${apiSettings?.model}` : 'API 尚未配置')
              : providerError ?? provider?.detail ?? 'Codex CLI 状态待确认'}>
            <span className={'health-dot ' + ((apiSelected ? apiReady : provider?.status === 'ready')
              ? 'connected' : 'degraded')} aria-hidden="true" />
            <span>{apiSelected ? (apiReady ? 'API' : '未配置')
              : providerLoading ? '检测中' : provider?.status === 'ready' ? 'Codex' : '未连接'}</span>
          </span>
          <button className="agent-icon-button" type="button" disabled={!selectedThread?.projectRepoId || !checkoutBindingReady || committing}
            title={diffVisible && diffThreadId === selectedThread?.id ? '收起 Git 变更' : '查看 Git 变更'}
            aria-label={diffVisible && diffThreadId === selectedThread?.id ? '收起 Git 变更' : '查看 Git 变更'}
            aria-expanded={diffVisible && diffThreadId === selectedThread?.id}
            onClick={() => void toggleDiff()}><AgentControlIcon name="diff" /></button>
          <button className="agent-icon-button" type="button" title="新建会话" aria-label="新建会话"
            disabled={sending || committing} onClick={addThread}><AgentControlIcon name="plus" /></button>
          <details className="agent-header-menu" name="agent-chat-controls">
            <summary title="更多会话操作" aria-label="更多会话操作"><AgentControlIcon name="more" /></summary>
            <div className="agent-header-menu-panel" role="group" aria-label="会话操作">
              <button type="button" onClick={() => { closeAgentMenus(surfaceRef.current); onOpenProjects(); }}>
                <AgentControlIcon name="work" /> Work 与项目
              </button>
              <button type="button" onClick={() => { closeAgentMenus(surfaceRef.current); onOpenKnowledge(); }}>
                <AgentControlIcon name="book" /> 项目知识
              </button>
              <button type="button" onClick={() => { closeAgentMenus(surfaceRef.current); onOpenSettings(); }}>
                <AgentControlIcon name="settings" /> 模型与授权
              </button>
              {!apiSelected && <button type="button" disabled={providerLoading}
                onClick={() => { closeAgentMenus(surfaceRef.current); void onRefreshProvider(); }}>
                <AgentControlIcon name="refresh" /> 刷新 Codex 连接
              </button>}
              {selectedThread && <button type="button" disabled={sending || committing}
                onClick={() => { closeAgentMenus(surfaceRef.current); archiveThread(); }}>归档当前会话</button>}
            </div>
          </details>
        </div>
      </div>

      {!selectedThread ? (
        <div className="local-empty">
          <strong>开始一个本地会话</strong>
          <p>会话记录只属于桌面客户端；Requirement、Plan 和 Work 仍由 Forge 保持唯一权威。</p>
          <button className="plain-action" type="button" onClick={addThread}>新建会话</button>
        </div>
      ) : (
        <>
          {diffVisible && diffThreadId === selectedThread.id
            && diffRepoId === selectedThread.projectRepoId
            && diffCheckoutId === selectedThread.checkoutId && (
            <AgentGitReview key={`${selectedThread.id}:${diffStaged}`}
              diff={diff} staged={diffStaged} loading={diffLoading} error={diffError}
              canCommit={checkoutBindingReady && !sending && !committing}
              committing={committing} commitError={commitError}
              commitHead={commitSuccess?.threadId === selectedThread.id ? commitSuccess.head : undefined}
              onCommit={(paths, message) => { void commitReviewedFiles(paths, message); }}
              onStagedChange={(staged) => { void toggleDiff(true, staged); }}
              onRefresh={() => void toggleDiff(true)}
              onClose={() => { diffRequest.current += 1; setDiffVisible(false); }} />
          )}

          <div className="local-transcript" ref={transcriptRef} onScroll={(event) => {
            const viewport = event.currentTarget;
            setFollowLatest(transcriptIsNearBottom(
              viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight,
            ));
          }}>
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
                {message.role === 'assistant' && message.content.trim() && (
                  <div className="local-message-actions">
                    <CopyTextAction text={message.content} label="复制回复" />
                  </div>
                )}
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
                  <details className="agent-tool-activity" aria-label="本轮 Forge 工具进度">
                    <summary>
                      {toolProgress.some((event) => event.phase === 'failed') ? '有工具执行失败' : '工具调用记录'}
                      <span>{toolProgress.length} 项 · 展开详情</span>
                    </summary>
                    <div className="local-tool-progress-list">
                      {toolProgress.slice(-6).map((event, index) => (
                        <div className={'local-tool-progress-row ' + event.phase} key={index}>
                          <span>{event.name}</span>
                          <small>{event.phase === 'started' ? '执行中' : event.phase === 'completed' ? '已完成' : '失败'}</small>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                </div>
              </div>
            )}
          </div>
          {!followLatest && selectedThread.messages.length > 0 && (
            <button className="agent-jump-latest" type="button"
              onClick={() => {
                const viewport = transcriptRef.current;
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
                setFollowLatest(true);
              }}>
              跳转到最新消息 ↓
            </button>
          )}

          <div className="local-composer agent-chat-composer">
            <textarea
              ref={composerTextRef}
              rows={2}
              aria-label="本地会话消息"
              placeholder={sending ? '可以先编写下一条消息…'
                : committing ? 'Git 提交中，可先写下一条消息…'
                : providerReady ? '向 Forge 描述任务或提出问题…' : '配置模型或选择有效项目后开始…'}
              value={draft}
              onChange={(event) => {
                const threadId = selectedThread.id;
                const value = event.target.value;
                setDrafts((current) => ({ ...current, [threadId]: value }));
              }}
              onKeyDown={(event) => {
                if (shouldSubmitComposerKey(event.nativeEvent, sending || committing)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {(sendError || (!checkoutBindingReady && selectedRepoId)
              || (selectedWorkId && !workBindingReady) || !projectBindingReady
              || (!providerReady && !providerLoading && !sending)) && (
              <div className="agent-composer-notice" role={sendError ? 'alert' : 'status'}>
                {sendError
                  ?? (!projectBindingReady ? '项目已不在 Forge 注册目录中，请重新选择'
                    : !checkoutBindingReady && selectedRepoId ? 'Checkout 未核实，暂时禁止执行'
                    : selectedWorkId && !workBindingReady ? workDetailError ?? '正在核对 Work 归属…'
                    : apiSelected ? '请配置可用的 API 模型与密钥'
                    : providerError ?? 'Codex CLI 尚未就绪')}
              </div>
            )}
            <div className="agent-composer-toolbar">
              <div className="agent-composer-context">
                <details className="agent-context-menu" name="agent-chat-controls">
                  <summary title="选择项目" aria-label="选择项目">
                    <AgentControlIcon name="folder" />
                    <span>{selectedProject?.repository ?? '项目'}</span>
                    <AgentControlIcon name="chevron" />
                  </summary>
                  <div className="agent-context-panel">
                    <label>项目
                      <select aria-label="Agent 项目上下文" value={selectedThread.projectRepoId ?? ''}
                        disabled={sending || committing}
                        onChange={(event) => {
                          changeProject(event.target.value || undefined);
                          event.currentTarget.closest('details')?.removeAttribute('open');
                        }}>
                        <option value="">不附加项目（纯对话）</option>
                        {projects.map((project) => <option key={project.repoId} value={project.repoId}>
                          {project.name} · {project.repository}
                        </option>)}
                      </select>
                    </label>
                    <small>已存在的会话不会被重新绑定到另一个项目。</small>
                    {!projectBindingReady && <small role="alert">当前项目已不在 Forge 注册目录</small>}
                  </div>
                </details>
                {selectedRepoId && <details className="agent-context-menu" name="agent-chat-controls">
                  <summary title="选择执行分支和 Checkout" aria-label="选择执行分支和 Checkout">
                    <AgentControlIcon name="branch" />
                    <span>{checkoutIndex.find((entry) => entry.checkoutId === selectedThread.checkoutId)?.branch
                      ?? (checkoutLoading ? '读取分支…' : '检出')}</span>
                    <AgentControlIcon name="chevron" />
                  </summary>
                  <div className="agent-context-panel">
                    <label>Forge 已注册 Checkout
                      <select aria-label="Agent 执行的 Git Checkout" value={selectedThread.checkoutId ?? ''}
                        disabled={sending || committing || checkoutLoading || !!checkoutError || !checkoutIndex.length}
                        onChange={(event) => {
                          changeCheckout(event.target.value);
                          event.currentTarget.closest('details')?.removeAttribute('open');
                        }}>
                        {!checkoutBindingReady && <option value={selectedThread.checkoutId ?? ''}>
                          {checkoutLoading ? '正在读取 Forge 检出目录…' : '未核实的历史检出（只读）'}
                        </option>}
                        {checkoutIndex.map((checkout) => <option value={checkout.checkoutId}
                          key={checkout.checkoutId} title={checkout.path ?? checkout.checkoutId}>
                          {checkout.branch || 'Detached HEAD'} · {checkout.checkoutId.slice(0, 10)}
                          {checkout.active ? '（默认）' : ''}
                        </option>)}
                      </select>
                    </label>
                    {checkoutError && <small role="alert">检出目录读取失败：{checkoutError}</small>}
                    <small title={selectedThread.checkoutId}>切换 Checkout 将保留原会话历史，新的操作使用独立会话。</small>
                  </div>
                </details>}
                {selectedRepoId && <details className="agent-context-menu" name="agent-chat-controls">
                  <summary title="关联 Forge Work" aria-label="关联 Forge Work">
                    <AgentControlIcon name="work" />
                    <span>{selectedWorkId ? (workDetail?.objective.slice(0, 18) ?? '已关联 Work') : 'Work'}</span>
                    <AgentControlIcon name="chevron" />
                  </summary>
                  <div className="agent-context-panel">
                    <label>关联已有 Work（可选）
                      <select aria-label="会话关联的 Forge Work" value={selectedWorkId ?? ''}
                        disabled={sending || committing}
                        onChange={(event) => {
                          changeWork(event.target.value || undefined);
                          event.currentTarget.closest('details')?.removeAttribute('open');
                        }}>
                        <option value="">不关联 Work</option>
                        {selectedWorkId && !workIndex.some((work) => work.workId === selectedWorkId) && (
                          <option value={selectedWorkId}>{selectedWorkId} · 当前列表以外</option>
                        )}
                        {workIndex.map((work) => <option value={work.workId} key={work.workId}>
                          {work.state === 'open' ? '进行中' : '历史'} · {work.objective.slice(0, 72)}
                        </option>)}
                      </select>
                    </label>
                    {selectedWorkId && workBindingReady && workDetail && <div className="agent-context-work-links">
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
                    </div>}
                    {workIndexError && <small role="status">Work 列表读取失败：{workIndexError}</small>}
                    {selectedWorkId && !workBindingReady && <small role="alert">
                      {workDetailError ?? '正在核对 Forge Work 与项目归属…'}
                    </small>}
                  </div>
                </details>}
              </div>
              <div className="agent-composer-utilities">
                <button type="button" className="agent-model-control" title="选择模型与 API 设置"
                  aria-label="选择模型与 API 设置" onClick={onOpenSettings}>
                  <AgentControlIcon name="settings" />
                  <span>{apiSelected ? (apiSettings?.model || '兼容 API') : 'Codex'}</span>
                  <AgentControlIcon name="chevron" />
                </button>
                {apiSelected && selectedProject && <button type="button"
                  className={'agent-icon-button agent-permission-control' + (allowEffects && checkoutBindingReady ? ' active' : '')}
                  title={allowEffects && checkoutBindingReady ? '已允许本轮仓库写入，发送时仍会再次确认' : '允许本轮编辑文件和执行命令'}
                  aria-label="允许本轮编辑文件和执行命令"
                  aria-pressed={allowEffects && checkoutBindingReady}
                  disabled={sending || !checkoutBindingReady}
                  onClick={() => setAllowEffects((current) => !current)}>
                  <AgentControlIcon name="shield" />
                </button>}
                {sending && sendingThreadId === selectedThread.id ? (
                  <button className="local-send-button agent-stop-control" type="button"
                    aria-label={cancelRequested ? '已请求停止' : '请求停止当前 Agent 回复'}
                    title={apiSelected || provider?.cancellable === true
                      ? cancelRequested ? '正在等待停止确认' : '停止本轮回复'
                      : '当前模型提供方不支持停止'}
                    disabled={cancelRequested || !onCancel || (!apiSelected && provider?.cancellable !== true)}
                    onClick={() => void cancelTurn()}>
                    <AgentControlIcon name="stop" />
                  </button>
                ) : (
                  <button className="local-send-button" type="button"
                    aria-label={committing ? 'Git 提交中，暂不可发送' : '发送消息'}
                    title={committing ? '等待 Git 提交结束后发送' : '发送消息（Enter）'}
                    disabled={!providerReady || !draft.trim() || sending || committing} onClick={() => void send()}>
                    <AgentControlIcon name="arrow" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
