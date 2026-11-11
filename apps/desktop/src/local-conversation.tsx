import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AgentGitReview, splitGitDiffFiles, type GitDiffReceipt } from './agent-git-review';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocalProviderStatusProjection } from './runtime-client';
import type { ProjectListItemProjection } from './runtime-projection';
import { isApiProvider, providerForNewThread, type LocalApiSettings, type LocalProviderChoice, type LocalApiToolEvent } from './local-api';
import { ForgeIcon as AgentControlIcon } from './ui-icons';

const LOCAL_THREADS_KEY = 'forge.desktop.local-threads.v1';
const LOCAL_DRAFTS_KEY = 'forge.desktop.local-drafts.v1';
const MAX_THREADS = 100;

export type LocalConversationRole = 'user' | 'assistant' | 'tool' | 'system';

export type LocalToolProgressPhase = 'started' | 'running' | 'output' | 'completed' | 'failed' | 'unknown';

export interface LocalToolProgress {
  conversationId: string;
  name: string;
  phase: LocalToolProgressPhase;
  sequence?: number;
  requestId?: string;
  toolCallId?: string;
  processId?: string;
  output?: string;
}

export interface LocalModelProgress {
  conversationId: string;
  sequence?: number;
  kind: 'round_start' | 'text_delta' | 'reasoning_summary_delta' | 'terminal' | 'error' | 'cancelled';
  delta?: string;
  round?: number;
  status?: string;
  error?: string;
}

export interface LocalPendingTurnState {
  cancelRequested: boolean;
  toolProgress: LocalToolProgress[];
  lastSequence: number;
  streamedText: string;
  reasoningSummary: string;
  round?: number;
  terminalStatus?: string;
  terminalError?: string;
}

export function createLocalPendingTurnState(): LocalPendingTurnState {
  return { cancelRequested: false, toolProgress: [], lastSequence: 0, streamedText: '', reasoningSummary: '' };
}

export function localPendingCopy(
  provider: LocalProviderChoice, cancelRequested: boolean, toolProgress: LocalToolProgress[], hasStreamedText = false,
): string {
  if (cancelRequested) return '已请求停止；如果 Forge 工具正在运行，将在收到结果后结束…';
  if (provider === 'codex') return 'Codex CLI 正在处理请求；运行期间不提供工具进度；支持时可使用停止。';
  if (toolProgress.some((event) => event.phase === 'unknown')) return '工具操作结果待核对…';
  if (toolProgress.some((event) => event.phase === 'started' || event.phase === 'running')) return 'Agent 正在使用 Forge 工具…';
  if (hasStreamedText) return '正在生成回复…';
  return toolProgress.length > 0 ? '工具调用已返回，正在整理回复…' : 'Agent 正在处理请求…';
}

/** Reconcile each tool call by its stable call/request identity, not by display name alone. */
export function advanceLocalToolProgress(
  events: LocalToolProgress[], event: LocalToolProgress,
): LocalToolProgress[] {
  const matchesCall = (entry: LocalToolProgress): boolean => entry.conversationId === event.conversationId
    && (event.toolCallId ? entry.toolCallId === event.toolCallId
      : event.requestId ? entry.requestId === event.requestId : entry.name === event.name);
  const isOpen = (phase: LocalToolProgressPhase): boolean =>
    phase === 'started' || phase === 'running' || phase === 'output';
  let index = -1;
  for (let cursor = events.length - 1; cursor >= 0; cursor -= 1) {
    const entry = events[cursor];
    if (entry && matchesCall(entry) && isOpen(entry.phase)) { index = cursor; break; }
  }
  if (index < 0) return [...events, event].slice(-12);
  return events.map((entry, cursor) => cursor === index ? {
    ...entry, ...event,
    requestId: event.requestId ?? entry.requestId,
    toolCallId: event.toolCallId ?? entry.toolCallId,
    processId: event.processId ?? entry.processId,
    output: event.output ?? entry.output,
  } : entry);
}

/** A shared per-turn sequence prevents late model/tool events from regressing visible state. */
export function advanceLocalPendingProgress(
  state: LocalPendingTurnState,
  source: 'model' | 'tool',
  event: LocalModelProgress | LocalToolProgress,
): LocalPendingTurnState {
  const sequence = event.sequence;
  if (typeof sequence === 'number' && (!Number.isSafeInteger(sequence) || sequence <= state.lastSequence)) return state;
  const lastSequence = typeof sequence === 'number' ? sequence : state.lastSequence;
  if (source === 'tool') {
    return { ...state, lastSequence, toolProgress: advanceLocalToolProgress(state.toolProgress, event as LocalToolProgress) };
  }
  const progress = event as LocalModelProgress;
  switch (progress.kind) {
    case 'text_delta':
      return { ...state, lastSequence, streamedText: (state.streamedText + (progress.delta ?? '')).slice(-30_000) };
    case 'reasoning_summary_delta':
      return { ...state, lastSequence, reasoningSummary: (state.reasoningSummary + (progress.delta ?? '')).slice(-4_000) };
    case 'round_start':
      return { ...state, lastSequence, round: progress.round };
    case 'terminal':
      return { ...state, lastSequence, terminalStatus: progress.status ?? 'completed' };
    case 'error':
      return { ...state, lastSequence, terminalStatus: 'error', terminalError: progress.error };
    case 'cancelled':
      return { ...state, lastSequence, terminalStatus: 'cancelled', terminalError: progress.error };
    default:
      return state;
  }
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
  provider: LocalProviderChoice, projectRepoId?: string, checkoutId?: string,
): LocalConversationThread {
  const timestamp = new Date().toISOString();
  return {
    id: localId('thread'),
    title: '新会话',
    provider,
    ...(projectRepoId ? { projectRepoId } : {}),
    ...(projectRepoId && checkoutId ? { checkoutId } : {}),
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
    return { thread: createThread(provider, thread.projectRepoId, checkoutId), created: true };
  }
  return {
    thread: { ...thread, checkoutId, providerSessionId: undefined,
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
    return { thread: createThread(provider, nextRepoId, nextCheckoutId), created: true };
  }
  return {
    thread: {
      ...thread, projectRepoId: nextRepoId, checkoutId: nextCheckoutId,
      providerSessionId: undefined, updatedAt: new Date().toISOString(),
    },
    created: false,
  };
}

function loadThreads(): LocalConversationThread[] {
  try {
    const raw = localStorage.getItem(LOCAL_THREADS_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((thread): thread is LocalConversationThread & { workId?: unknown } => Boolean(
        thread && typeof thread === 'object'
        && typeof (thread as LocalConversationThread).id === 'string'
        && typeof (thread as LocalConversationThread).title === 'string'
        && Array.isArray((thread as LocalConversationThread).messages),
      ))
      .map((thread) => {
        const { workId: _legacyWorkId, ...current } = thread;
        return current;
      })
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
  projectRepoId?: string;
  running?: boolean;
  draft?: boolean;
}

/** The existing sidebar is the navigation authority for sent and unsent threads. */
export function localConversationNavItems(
  threads: LocalConversationThread[], drafts: Record<string, string>,
  runningIds: ReadonlySet<string> = new Set(),
): LocalConversationNavItem[] {
  return threads.filter((thread) => !thread.archived
    && (thread.messages.length > 0 || Boolean(drafts[thread.id]?.trim())))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({
      id: thread.id,
      title: thread.messages.length ? threadLabel(thread) : drafts[thread.id]!.trim().slice(0, 52),
      updatedAt: thread.updatedAt,
      provider: thread.provider ?? 'codex',
      ...(thread.projectRepoId ? { projectRepoId: thread.projectRepoId } : {}),
      ...(runningIds.has(thread.id) ? { running: true } : {}),
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

type ContextOption = { value: string; label: string; title?: string; disabled?: boolean };

/** Native buttons keep Tab/Enter/Space behavior; arrows move among available choices. */
export function contextOptionIndex(key: string, index: number, count: number): number | undefined {
  if (!count) return undefined;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (index + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

export function ContextOptionList({ label, options, value, disabled, onSelect }: {
  label: string; options: ContextOption[]; value: string; disabled?: boolean;
  onSelect: (value: string) => void;
}) {
  return <div className="agent-context-options" role="group" aria-label={label}
    onKeyDown={(event) => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      const next = contextOptionIndex(event.key, index, buttons.length);
      if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    }}>
    {options.map((option) => <button type="button" aria-pressed={option.value === value}
      key={option.value} title={option.title} disabled={disabled || option.disabled}
      onClick={(event) => {
        const menu = event.currentTarget.closest('details');
        if (menu) { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true }); }
        onSelect(option.value);
      }}>
      <span>{option.label}</span><span className="agent-context-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
    </button>)}
  </div>;
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
  onSend?: (input: { thread: LocalConversationThread; prompt: string }) => Promise<LocalConversationReply>;
  onCancel?: (thread: LocalConversationThread) => Promise<void>;
}) {
  const [threads, setThreads] = useState<LocalConversationThread[]>(() => loadThreads());
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(() => loadThreads().find((thread) => !thread.archived)?.id);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  // Each conversation owns one in-flight turn. Independent repositories can
  // progress together; Forge remains responsible for checkout/process locks.
  const [pendingTurns, setPendingTurns] = useState<Record<string, LocalPendingTurnState>>({});
  const pendingTurnIds = useRef(new Set<string>());
  const [sendErrors, setSendErrors] = useState<Record<string, string | null>>({});
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
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      closeAgentMenus(surfaceRef.current,
        target?.closest('details.agent-context-menu,details.agent-header-menu') ?? null);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [diffVisible, committing]);

  // Ordered native progress is observational only; durable messages and receipts
  // still come exclusively from the completed native command response.
  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void listen<LocalToolProgress>('forge-agent-tool-progress', (event) => {
      const id = event.payload.conversationId;
      if (stopped || !pendingTurnIds.current.has(id)) return;
      setPendingTurns((current) => {
        const turn = current[id];
        if (!turn) return current;
        const next = advanceLocalPendingProgress(turn, 'tool', event.payload);
        return next === turn ? current : { ...current, [id]: next };
      });
    }).then((unlisten) => { if (stopped) unlisten(); else unsubscribe = unlisten; })
      .catch(() => { /* Codex CLI or browser-only preview has no native tool events. */ });
    return () => { stopped = true; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void listen<LocalModelProgress>('forge-agent-model-progress', (event) => {
      const id = event.payload.conversationId;
      if (stopped || !pendingTurnIds.current.has(id)) return;
      setPendingTurns((current) => {
        const turn = current[id];
        if (!turn) return current;
        const next = advanceLocalPendingProgress(turn, 'model', event.payload);
        return next === turn ? current : { ...current, [id]: next };
      });
    }).then((unlisten) => { if (stopped) unlisten(); else unsubscribe = unlisten; })
      .catch(() => { /* Providers without native model streaming still complete through the command response. */ });
    return () => { stopped = true; unsubscribe?.(); };
  }, []);

  // Settings determine the provider for NEW sessions only. Existing Codex/API
  // conversations retain their own provider, history, checkout and resume ID.
  const defaultProvider = providerForNewThread(apiSettings);
  const activeThreads = useMemo(() => threads.filter((thread) => !thread.archived), [threads]);
  const selectedThread = activeThreads.find((thread) => thread.id === selectedThreadId) ?? activeThreads[0];
  const selectedThreadProvider: LocalProviderChoice = selectedThread?.provider ?? 'codex';
  const pendingTurn = selectedThread ? pendingTurns[selectedThread.id] : undefined;
  const sending = Boolean(pendingTurn);
  const selectedCheckoutTurnPending = Boolean(selectedThread?.projectRepoId && selectedThread.checkoutId
    && threads.some((thread) => pendingTurns[thread.id]
      && thread.projectRepoId === selectedThread.projectRepoId
      && thread.checkoutId === selectedThread.checkoutId));
  const toolProgress = pendingTurn?.toolProgress ?? [];
  const cancelRequested = Boolean(pendingTurn?.cancelRequested);
  const sendError = selectedThread ? sendErrors[selectedThread.id] ?? null : null;
  const setSendError = (value: string | null) => {
    if (!selectedThread) return;
    setSendErrors((current) => ({ ...current, [selectedThread.id]: value }));
  };
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
    const items = localConversationNavItems(activeThreads, drafts, new Set(Object.keys(pendingTurns)));
    onThreadsChange(items, items.some((item) => item.id === selectedThread?.id)
      ? selectedThread?.id : undefined, selectedThread?.projectRepoId);
  }, [activeThreads, drafts, pendingTurns, selectedThread?.id, selectedThread?.projectRepoId, onThreadsChange]);

  useEffect(() => {
    if (!openThreadId) return;
    if (activeThreads.some((thread) => thread.id === openThreadId)) {
      // A conversation's unconfirmed error must remain visible on return.
      setSelectedThreadId(openThreadId);
    }
    onOpenThreadHandled();
  }, [openThreadId, activeThreads, onOpenThreadHandled]);

  const selectedProject = projects.find((project) => project.repoId === selectedThread?.projectRepoId);
  const selectedRepoId = selectedThread?.projectRepoId;

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

  const projectBindingReady = !selectedRepoId || Boolean(selectedProject);
  const checkoutBindingReady = !selectedRepoId || Boolean(selectedThread?.checkoutId
    && checkoutIndex.some((checkout) => checkout.checkoutId === selectedThread.checkoutId));
  const apiSelected = isApiProvider(selectedThreadProvider);
  const joyCodeSelected = selectedThreadProvider === 'joycode';
  const externalSelected = apiSelected || joyCodeSelected;
  const selectedApiProfile = apiSettings?.profiles?.find((profile) => selectedThreadProvider === `api:${profile.id}`);
  const loopbackApi = Boolean(selectedApiProfile && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(selectedApiProfile.endpoint));
  // When Codex is the new-session default, the settings read deliberately
  // does not query the API Keychain. A historical API thread can still send:
  // the native API command checks the exact saved secret at execution time.
  const apiCredentialDeferred = apiSelected && apiSettings?.provider !== 'api' && !loopbackApi;
  const credentialDeferredForProfile = Boolean(apiCredentialDeferred && selectedApiProfile?.credentialRef
    && apiSettings?.defaultProvider === selectedThreadProvider);
  const apiReady = Boolean(selectedApiProfile?.model.trim()
    && (selectedApiProfile.hasKey || loopbackApi || credentialDeferredForProfile));
  const joyCodeReady = Boolean(apiSettings?.joyCodeReady && apiSettings?.joyCodeModel.trim());
  const providerReady = (joyCodeSelected ? joyCodeReady : apiSelected ? apiReady : provider?.status === 'ready')
    && Boolean(onSend) && projectBindingReady && checkoutBindingReady;

  const addThread = () => {
    const repoId = selectedThread?.projectRepoId ?? defaultProjectRepoId;
    const checkoutId = selectedThread?.checkoutId
      ?? projects.find((project) => project.repoId === repoId)?.checkoutId;
    const thread = createThread(defaultProvider, repoId, checkoutId);
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
    const repoId = newThreadContext?.repoId ?? defaultProjectRepoId;
    const thread = createThread(defaultProvider, repoId,
      projects.find((project) => project.repoId === repoId)?.checkoutId);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
    setSendError(null);
    onNewThreadHandled();
  }, [newThreadRequested, defaultProvider, defaultProjectRepoId, newThreadContext,
    onNewThreadHandled, threads, selectedThreadId]);

  useEffect(() => {
    if (newThreadRequested || activeThreads.length > 0 || initialThreadProvisioned.current === defaultProvider) return;
    initialThreadProvisioned.current = defaultProvider;
    const thread = createThread(defaultProvider, defaultProjectRepoId,
      projects.find((project) => project.repoId === defaultProjectRepoId)?.checkoutId);
    setThreads((current) => current.some((entry) => !entry.archived)
      ? current : [thread, ...current]);
    setSelectedThreadId(thread.id);
  }, [activeThreads.length, defaultProvider, defaultProjectRepoId, newThreadRequested]);

  const updateSelected = (updater: (thread: LocalConversationThread) => LocalConversationThread) => {
    if (!selectedThread) return;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? updater(thread) : thread));
  };

  const changeProject = (nextRepoId?: string) => {
    if (!selectedThread || sending || committing || nextRepoId === selectedThread.projectRepoId) return;
    const choice = selectThreadRepository(selectedThread, selectedThreadProvider, nextRepoId,
      projects.find((project) => project.repoId === nextRepoId)?.checkoutId);
    if (choice.created) {
      setThreads((current) => [choice.thread, ...current]);
      setSelectedThreadId(choice.thread.id);
      setDrafts((current) => ({ ...current,
        [choice.thread.id]: current[selectedThread.id] ?? '' }));
    } else updateSelected(() => choice.thread);
    setSendError(null);
    diffRequest.current += 1;
    setDiffVisible(false);
  };

  const changeCheckout = (nextId: string) => {
    if (!selectedThread || sending || committing
      || !checkoutIndex.some((checkout) => checkout.checkoutId === nextId)) return;
    const choice = selectThreadCheckout(selectedThread, selectedThreadProvider, nextId);
    if (choice.created) {
      setThreads((current) => [choice.thread, ...current]);
      setSelectedThreadId(choice.thread.id);
      setDrafts((current) => ({ ...current,
        [choice.thread.id]: current[selectedThread.id] ?? '' }));
    } else updateSelected(() => choice.thread);
    setSendError(null);
    diffRequest.current += 1;
    setDiffVisible(false);
    setCommitSuccess(undefined);
    setCommitError(undefined);
  };

  const deleteThread = () => {
    if (!selectedThread || sending || committing) return;
    const deletedId = selectedThread.id;
    // Local conversation state has one owner; deleting must not create hidden history.
    setThreads((current) => current.filter((thread) => thread.id !== deletedId));
    setDrafts((current) => {
      const next = { ...current };
      delete next[deletedId];
      return next;
    });
    setSendErrors((current) => {
      const next = { ...current };
      delete next[deletedId];
      return next;
    });
    setSelectedThreadId(activeThreads.find((thread) => thread.id !== deletedId)?.id);
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
      || reviewed.checkoutId !== thread.checkoutId || reviewed.truncated || diffLoading || committing || selectedCheckoutTurnPending
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
    if (!selectedThread || !providerReady || !onSend || !prompt || sending || committing
      || pendingTurnIds.current.has(selectedThread.id)) return;
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
    pendingTurnIds.current.add(selectedThread.id);
    setPendingTurns((current) => ({
      ...current, [selectedThread.id]: createLocalPendingTurnState(),
    }));
    try {
      const reply = await onSend({ thread: pendingThread, prompt });
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
      pendingTurnIds.current.delete(selectedThread.id);
      setPendingTurns((current) => {
        const next = { ...current };
        delete next[selectedThread.id];
        return next;
      });
    }
  };

  const cancelTurn = async () => {
    if (!(externalSelected || provider?.cancellable === true) || !sending || !selectedThread
      || !onCancel || cancelRequested) return;
    const id = selectedThread.id;
    setPendingTurns((current) => current[id] ? {
      ...current, [id]: { ...current[id], cancelRequested: true },
    } : current);
    setSendError(null);
    try {
      await onCancel(selectedThread);
    } catch (cause) {
      // No success claim: the turn may have completed in the time between
      // clicking and the native cancel request.
      setPendingTurns((current) => current[id] ? {
        ...current, [id]: { ...current[id], cancelRequested: false },
      } : current);
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
            title={joyCodeSelected
              ? (joyCodeReady ? `JoyCode · ${apiSettings?.joyCodeModel}` : 'JoyCode 尚未就绪')
              : apiSelected ? (apiReady
                ? `API · ${selectedApiProfile?.model}${credentialDeferredForProfile ? ' · 发送时校验钥匙串' : ''}`
                : selectedThreadProvider === 'api' ? '历史 API 会话未绑定固定 Provider'
                  : !selectedApiProfile ? '会话绑定的 API Provider 不存在' : 'API 尚未配置')
                : providerError ?? provider?.detail ?? 'Codex CLI 状态待确认'}>
            <span className={'health-dot ' + ((joyCodeSelected ? joyCodeReady
              : apiSelected ? (apiReady && !credentialDeferredForProfile) : provider?.status === 'ready')
              ? 'connected' : 'degraded')} aria-hidden="true" />
            <span>{joyCodeSelected ? (joyCodeReady ? 'JoyCode' : '未配置')
              : apiSelected ? (apiReady ? 'API' : '未配置')
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
                <AgentControlIcon name="folder" /> 项目与记录
              </button>
              <button type="button" onClick={() => { closeAgentMenus(surfaceRef.current); onOpenKnowledge(); }}>
                <AgentControlIcon name="book" /> 项目知识
              </button>
              <button type="button" onClick={() => { closeAgentMenus(surfaceRef.current); onOpenSettings(); }}>
                <AgentControlIcon name="settings" /> 模型与授权
              </button>
              {!externalSelected && <button type="button" disabled={providerLoading}
                onClick={() => { closeAgentMenus(surfaceRef.current); void onRefreshProvider(); }}>
                <AgentControlIcon name="refresh" /> 刷新 Codex 连接
              </button>}
              {selectedThread && <button type="button" disabled={sending || committing}
                onClick={() => { closeAgentMenus(surfaceRef.current); deleteThread(); }}>删除当前会话</button>}
            </div>
          </details>
        </div>
      </div>

      {!selectedThread ? (
        <div className="local-empty">
          <strong>开始一个本地会话</strong>
          <p>会话记录只属于桌面客户端；Requirement 与 Plan 由 Forge 持久化，历史 Work 仅兼容读取，开发进度以 GitHub Issue / Project 为准。</p>
          <button className="plain-action" type="button" onClick={addThread}>新建会话</button>
        </div>
      ) : (
        <>
          {diffVisible && diffThreadId === selectedThread.id
            && diffRepoId === selectedThread.projectRepoId
            && diffCheckoutId === selectedThread.checkoutId && (
            <AgentGitReview key={`${selectedThread.id}:${diffStaged}`}
              diff={diff} staged={diffStaged} loading={diffLoading} error={diffError}
              canCommit={checkoutBindingReady && !selectedCheckoutTurnPending && !committing}
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
            {sending && (
              <div className="local-pending-message" role="status">
                <span className="local-pending-indicator" />
                <div className="local-pending-content">
                <span>{localPendingCopy(selectedThreadProvider, cancelRequested, toolProgress, Boolean(pendingTurn?.streamedText))}</span>
                {pendingTurn?.streamedText && (
                  <div className="local-pending-stream" aria-live="off">
                    <LocalMessageBody content={pendingTurn.streamedText} />
                  </div>
                )}
                {pendingTurn?.reasoningSummary && (
                  <details className="local-pending-summary">
                    <summary>模型摘要</summary>
                    <LocalMessageBody content={pendingTurn.reasoningSummary} />
                  </details>
                )}
                {toolProgress.length > 0 && (
                  <details className="agent-tool-activity" aria-label="本轮 Forge 工具进度">
                    <summary>
                      {toolProgress.some((event) => event.phase === 'unknown') ? '有工具结果待核对'
                        : toolProgress.some((event) => event.phase === 'failed') ? '有工具执行失败' : '工具调用记录'}
                      <span>{toolProgress.length} 项 · 展开详情</span>
                    </summary>
                    <div className="local-tool-progress-list">
                      {toolProgress.slice(-6).map((event, index) => (
                        <div className={'local-tool-progress-row ' + event.phase}
                          key={event.toolCallId ?? event.requestId ?? `${event.name}-${index}`}>
                          <span>{event.name}</span>
                          <small>{event.phase === 'started' || event.phase === 'running' ? '执行中'
                            : event.phase === 'output' ? '已返回输出'
                            : event.phase === 'completed' ? '已完成'
                            : event.phase === 'unknown' ? '结果待核对' : '失败'}</small>
                          {event.output && <details><summary>查看工具输出</summary><pre>{event.output}</pre></details>}
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
            {(sendError || (!checkoutBindingReady && selectedRepoId) || !projectBindingReady
              || (!providerReady && !providerLoading && !sending)) && (
              <div className="agent-composer-notice" role={sendError ? 'alert' : 'status'}>
                {sendError
                  ?? (!projectBindingReady ? '项目已不在 Forge 注册目录中，请重新选择'
                    : !checkoutBindingReady && selectedRepoId ? 'Checkout 未核实，暂时禁止执行'
                    : joyCodeSelected ? '请先登录 JoyCode 并配置可用模型'
                    : apiSelected && selectedThreadProvider === 'api' ? '历史 API 会话未绑定固定 Provider，请新建会话'
                    : apiSelected && !selectedApiProfile ? '会话绑定的 API Provider 不存在，请恢复配置或新建会话'
                    : apiSelected ? '请配置会话绑定的 API 模型与密钥'
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
                    <ContextOptionList label="Agent 项目上下文" value={selectedThread.projectRepoId ?? ''}
                      disabled={sending || committing} onSelect={(value) => changeProject(value || undefined)}
                      options={[{ value: '', label: '不附加项目（纯对话）' },
                        ...projects.map((project) => ({ value: project.repoId, label: `${project.name} · ${project.repository}` }))]} />
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
                    <ContextOptionList label="Agent 执行的 Git Checkout" value={selectedThread.checkoutId ?? ''}
                      disabled={sending || committing || checkoutLoading || !!checkoutError || !checkoutIndex.length}
                      onSelect={changeCheckout} options={[
                        ...(!checkoutBindingReady ? [{ value: selectedThread.checkoutId ?? '',
                          label: checkoutLoading ? '正在读取 Forge 检出目录…' : '未核实的历史检出（只读）', disabled: true }] : []),
                        ...checkoutIndex.filter((checkout) => checkoutBindingReady || checkout.checkoutId !== selectedThread.checkoutId)
                          .map((checkout) => ({ value: checkout.checkoutId, title: checkout.path ?? checkout.checkoutId,
                            label: `${checkout.branch || 'Detached HEAD'} · ${checkout.checkoutId.slice(0, 10)}${checkout.active ? '（默认）' : ''}` })),
                      ]} />
                    {checkoutError && <small role="alert">检出目录读取失败：{checkoutError}</small>}
                    <small title={selectedThread.checkoutId}>切换 Checkout 将保留原会话历史，新的操作使用独立会话。</small>
                  </div>
                </details>}
              </div>
              <div className="agent-composer-utilities">
                <button type="button" className="agent-model-control"
                  title="配置新会话默认模型；当前会话的执行引擎保持不变"
                  aria-label="选择模型与 API 设置" onClick={onOpenSettings}>
                  <AgentControlIcon name="settings" />
                  <span>{joyCodeSelected ? (apiSettings?.joyCodeModel || 'JoyCode')
                    : apiSelected ? (selectedApiProfile?.model || '兼容 API') : 'Codex'}</span>
                  <AgentControlIcon name="chevron" />
                </button>
                {sending ? (
                  <button className="local-send-button agent-stop-control" type="button"
                    aria-label={cancelRequested ? '已请求停止' : '请求停止当前 Agent 回复'}
                    title={externalSelected || provider?.cancellable === true
                      ? cancelRequested ? '正在等待停止确认' : '停止本轮回复'
                      : '当前模型提供方不支持停止'}
                    disabled={cancelRequested || !onCancel || (!externalSelected && provider?.cancellable !== true)}
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
