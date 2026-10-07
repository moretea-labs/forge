import { randomUUID } from 'node:crypto';
import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
} from '../packages/plugin-runtime/computer';
import {
  CHATGPT_AUTOMATION_RATE_LIMITED,
  chatgptProviderBackpressureRemainingMs,
  chatgptProviderPageFailure,
  noteChatgptProviderBackpressure,
  withChatgptProviderDispatchLane,
} from '../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { renderEffectMarker, sha256 } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type {
  WorkflowSupervisorBrowserCommand,
  WorkflowSupervisorBrowserTask,
  WorkflowSupervisorConsumerStatus,
} from './types';

const DEFAULT_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
const MAX_TRANSPORT_BACKOFF_MS = 60_000;
const MAX_TRANSPORT_BACKOFF_STEPS = 6;
const MAX_LOCAL_OBSERVATION_ATTEMPTS = 3;
const USER_VISIBLE_DEGRADED_AFTER_MS = 30_000;
/**
 * A task-local target/conversation failure must space its *own* retries. The
 * exact conversation is a provider resource: re-navigating or replacing its tab
 * on every tick is what produced conversation-read 429s, and a 429 is answered
 * by sending fewer requests, never by opening another conversation.
 *
 * Only failures about *this exact conversation or target* are spaced here.
 * Provider-wide unavailability already backs off the whole consumer, so spacing
 * it again would delay a legitimate resume without reducing any request volume.
 * A new exact-conversation failure code must be added to this mechanical
 * retry-spacing classification.
 */
const TASK_TARGET_RETRY_BASE_MS = 30_000;
/** Slow read-only probe cadence for an applied turn whose bounded resume is exhausted. */
const AWAITING_RECEIPT_OBSERVATION_MS = 60_000;
const TASK_TARGET_RETRY_MAX_MS = 10 * 60_000;
export const TASK_TARGET_SPACED_FAILURE_CODES: ReadonlySet<string> = new Set([
  'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE',
  'WORKFLOW_SUPERVISOR_EXACT_CONVERSATION_UNPROVEN',
  'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN',
  'COMPUTER_CHATGPT_EXACT_TARGET_AMBIGUOUS',
  'COMPUTER_CHATGPT_EXTENSION_EXACT_TARGET_AMBIGUOUS',
  'COMPUTER_CHATGPT_RESTORED_TARGET_UNPROVEN',
  'COMPUTER_CHATGPT_TARGET_RESTORE_FAILED',
  'COMPUTER_CHATGPT_BOOTSTRAP_TARGET_UNAVAILABLE',
  'COMPUTER_CHATGPT_EXTENSION_TARGET_OPEN_OUTCOME_UNKNOWN',
  'COMPUTER_CHATGPT_EXTENSION_BOOTSTRAP_OPEN_OUTCOME_UNKNOWN',
]);
function taskTargetRetryDelayMs(streak: number): number {
  const exponent = Math.max(0, Math.min(6, Math.trunc(streak) - 1));
  return Math.min(TASK_TARGET_RETRY_MAX_MS, TASK_TARGET_RETRY_BASE_MS * 2 ** exponent);
}

type ObservedConversation = {
  conversation_id: string;
  canonical_url: string;
  title?: string;
  projectTitle?: string;
  projectUrl?: string;
  is_current?: boolean;
};

type TaskTransportFailure = {
  code: string;
  observedAtMs: number;
  firstFailureAtMs: number;
  effectId?: string;
  projectionVisible: boolean;
  /** Consecutive identical failures; drives this task's own retry spacing. */
  streak: number;
};

export interface WorkflowSupervisorTransportProjection {
  taskId?: string;
  effectId?: string;
  state: 'degraded' | 'recovered';
  code?: string;
  firstFailureAt?: string;
  observedAt: string;
}

export interface WorkflowSupervisorStallProjection {
  taskId: string;
  effectId: string;
  state: 'exhausted' | 'recovered';
  stallKind: 'retryable' | 'provider_resume_exhausted';
  generations?: number;
  maxGenerations?: number;
  observedAt: string;
}

export interface WorkflowSupervisorComputerBrowserDependencies {
  targetPort: ComputerChatgptConversationTargetPort;
  nowMs(): number;
  providerIdleGraceMs: number;
  providerScopeKey: string;
  sleep(ms: number): Promise<void>;
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  onError(error: unknown): void;
  reportTransportState?(projection: WorkflowSupervisorTransportProjection): void;
  reportTaskStall?(projection: WorkflowSupervisorStallProjection): void;
  requestHumanAction?(input: {
    taskId: string;
    effectId?: string;
    action: 'login' | 'grant_permission';
    code: string;
  }): void;
}

export interface WorkflowSupervisorNativeBrowserHandle {
  readonly adapter: WorkflowSupervisorNativeBrowserAdapter;
  status(): WorkflowSupervisorConsumerStatus;
  close(): Promise<void>;
}

function normalize(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function localObservationDelayMs(completedAttempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(completedAttempts) - 1));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
function consumerFailureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = message.split(':', 1)[0]?.trim() ?? '';
  return /^[A-Z][A-Z0-9_]+$/.test(candidate) ? candidate : fallback;
}
function isoTime(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}
function targetMarkerPresent(text: string, effectId: string): boolean { return text.includes(renderEffectMarker(effectId)); }
function snapshotTargetMarkerPresent(snapshot: ComputerChatgptConversationObservation, effectId: string): boolean {
  return targetMarkerPresent(snapshot.latestUserText, effectId)
    || snapshot.userMessages?.some((message) => targetMarkerPresent(message, effectId)) === true;
}
function unknownObservationFingerprint(effectId: string, reason: string, snapshot: ComputerChatgptConversationObservation): string {
  return sha256(JSON.stringify({
    effectId,
    reason,
    url: snapshot.url,
    latestUserText: normalize(snapshot.latestUserText),
    latestAssistantResponse: normalize(snapshot.latestAssistantResponse),
    composerText: snapshot.composerText === undefined ? null : normalize(snapshot.composerText),
    latestTurnRole: snapshot.latestTurnRole ?? null,
    isGenerating: snapshot.isGenerating,
  }));
}
function exactConversation(snapshot: ComputerChatgptConversationObservation, task: WorkflowSupervisorBrowserTask): boolean {
  try { return parseChatgptConversationIdentity(snapshot.url).conversationId === task.conversationId; }
  catch { return false; }
}
function identityForTask(task: WorkflowSupervisorBrowserTask): ComputerChatgptConversationIdentity {
  const parsed = parseChatgptConversationIdentity(task.conversationUrl);
  if (parsed.conversationId !== task.conversationId) throw new Error('WORKFLOW_SUPERVISOR_CONVERSATION_IDENTITY_MISMATCH');
  return { namespace: 'chatgpt.conversation', conversationId: parsed.conversationId, canonicalUrl: parsed.canonicalUrl };
}
function conversationContentAvailable(snapshot: ComputerChatgptConversationObservation): boolean {
  // Navigation can commit the exact URL before ChatGPT loads the conversation.
  // An empty/error shell is transport evidence, never evidence about a send or
  // about whether the model stopped working.
  return snapshot.composerText !== undefined || snapshot.isGenerating
    || Boolean(snapshot.latestUserText.trim() || snapshot.latestAssistantResponse.trim() || snapshot.providerActivityText.trim());
}
function projectMetadataFromConversationUrl(value: string): { projectTitle?: string; projectUrl?: string } {
  try {
    const parsed = new URL(value);
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?\/c\/[a-z0-9-]+\/?$/i.exec(parsed.pathname);
    if (!match?.[1]) return {};
    const slug = match[2]?.trim();
    return {
      ...(slug ? { projectTitle: slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() } : {}),
      projectUrl: `https://chatgpt.com/g/${match[1]}/project`,
    };
  } catch { return {}; }
}

export class WorkflowSupervisorNativeBrowserAdapter {
  private readonly observedAssistant = new Map<string, string>();
  private readonly providerFailureSeen = new Map<string, string>();
  /** A recovery sent while an error surface is still visible must not inherit that stale error as its own failure. */
  private readonly providerFailureAwaitingClear = new Map<string, string>();
  private readonly freshSendCheckedAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<void>;
  private closed = false;
  private nextRunAtMs = 0;
  private lastRunHadTasks = false;
  private lastRunTransportUnavailable = false;
  private transportFailureStreak = 0;
  private servicingFreshSend = false;
  private conversations: ObservedConversation[] = [];
  private lastTickStartedAtMs?: number;
  private lastTickCompletedAtMs?: number;
  private lastCommandAttemptAtMs?: number;
  private lastFailure?: { code: string; observedAtMs: number; taskId?: string; effectId?: string };
  private firstTransportFailureAtMs?: number;
  private transportProjectionVisible = false;
  private readonly taskTransportFailures = new Map<string, TaskTransportFailure>();
  /** Derived projection cache only; Supervisor store remains the stall authority. */
  private readonly projectedTaskStalls = new Map<string, Omit<WorkflowSupervisorStallProjection, 'taskId' | 'state' | 'observedAt'>>();
  /** Spacing for read-only observation of a turn whose bounded resume is exhausted. */
  private readonly awaitingReceiptObservedAtMs = new Map<string, number>();

  constructor(
    private readonly control: WorkflowSupervisorControlPlane,
    private readonly discovery: WorkflowSupervisorEphemeralDiscovery,
    private readonly deps: WorkflowSupervisorComputerBrowserDependencies,
  ) {}

  private noteFailure(code: string, task?: WorkflowSupervisorBrowserTask, effectId?: string): void {
    const nowMs = this.deps.nowMs();
    this.lastFailure = { code, observedAtMs: nowMs, ...(task ? { taskId: task.taskId } : {}), ...(effectId ? { effectId } : {}) };
    this.firstTransportFailureAtMs ??= nowMs;
    if (!this.transportProjectionVisible && nowMs - this.firstTransportFailureAtMs >= USER_VISIBLE_DEGRADED_AFTER_MS) {
      this.transportProjectionVisible = true;
      this.deps.reportTransportState?.({
        state: 'degraded', code,
        ...(task ? { taskId: task.taskId } : {}), ...(effectId ? { effectId } : {}),
        firstFailureAt: new Date(this.firstTransportFailureAtMs).toISOString(), observedAt: new Date(nowMs).toISOString(),
      });
    }
  }

  private clearTransportFailure(): void {
    this.lastFailure = undefined;
    if (this.firstTransportFailureAtMs !== undefined) {
      const nowMs = this.deps.nowMs();
      if (this.transportProjectionVisible) this.deps.reportTransportState?.({ state: 'recovered', observedAt: new Date(nowMs).toISOString() });
      this.firstTransportFailureAtMs = undefined;
      this.transportProjectionVisible = false;
    }
  }

  private noteTaskFailure(code: string, task: WorkflowSupervisorBrowserTask, effectId?: string): void {
    const nowMs = this.deps.nowMs();
    const previous = this.taskTransportFailures.get(task.taskId);
    const failure: TaskTransportFailure = {
      code,
      observedAtMs: nowMs,
      firstFailureAtMs: previous?.code === code ? previous.firstFailureAtMs : nowMs,
      ...(effectId ? { effectId } : previous?.effectId ? { effectId: previous.effectId } : {}),
      projectionVisible: previous?.projectionVisible ?? false,
      // A materially different failure reason is new evidence and restarts the
      // spacing; an unchanged one keeps growing it.
      streak: previous?.code === code ? previous.streak + 1 : 1,
    };
    if (!failure.projectionVisible && nowMs - failure.firstFailureAtMs >= USER_VISIBLE_DEGRADED_AFTER_MS) {
      failure.projectionVisible = true;
      this.deps.reportTransportState?.({
        state: 'degraded', code, taskId: task.taskId,
        ...(failure.effectId ? { effectId: failure.effectId } : {}),
        firstFailureAt: new Date(failure.firstFailureAtMs).toISOString(), observedAt: new Date(nowMs).toISOString(),
      });
    }
    this.taskTransportFailures.set(task.taskId, failure);
  }

  private clearTaskFailure(taskId: string, effectId?: string): void {
    const failure = this.taskTransportFailures.get(taskId);
    if (!failure) return;
    this.taskTransportFailures.delete(taskId);
    const recoveredEffectId = effectId ?? failure.effectId;
    if (failure.projectionVisible) this.deps.reportTransportState?.({
      state: 'recovered', taskId,
      ...(recoveredEffectId ? { effectId: recoveredEffectId } : {}),
      observedAt: new Date(this.deps.nowMs()).toISOString(),
    });
  }

  private noteTargetUnavailable(task: WorkflowSupervisorBrowserTask, effectId: string | undefined, failure: { code: string; humanAction?: 'login' | 'grant_permission' }): void {
    // Exact-target failure is task-local. It must not back off unrelated
    // Supervisor conversations; only provider-wide inventory/backpressure does.
    this.noteTaskFailure(failure.code, task, effectId);
    if (failure.humanAction) this.deps.requestHumanAction?.({ taskId: task.taskId, ...(effectId ? { effectId } : {}), action: failure.humanAction, code: failure.code });
  }

  private syncTaskStallProjections(): void {
    const activeTaskIds = new Set<string>();
    const observedAt = new Date(this.deps.nowMs()).toISOString();
    for (const task of this.control.listTasks(true)) {
      activeTaskIds.add(task.taskId);
      let stall: ReturnType<WorkflowSupervisorControlPlane['taskStall']>;
      try { stall = this.control.taskStall(task.taskId); }
      catch (error) { this.deps.onError(error); continue; }
      if (stall.state === 'retryable' || stall.state === 'provider_resume_exhausted') {
        const next = {
          effectId: stall.effectId,
          stallKind: stall.state,
          ...(stall.state === 'retryable' ? { generations: stall.generations, maxGenerations: stall.maxGenerations } : {}),
        } as Omit<WorkflowSupervisorStallProjection, 'taskId' | 'state' | 'observedAt'>;
        const prior = this.projectedTaskStalls.get(task.taskId);
        const unchanged = prior?.effectId === next.effectId
          && prior.stallKind === next.stallKind
          && prior.generations === next.generations
          && prior.maxGenerations === next.maxGenerations;
        if (!unchanged) {
          try { this.deps.reportTaskStall?.({ taskId: task.taskId, state: 'exhausted', observedAt, ...next }); }
          catch (error) { this.deps.onError(error); }
          this.projectedTaskStalls.set(task.taskId, next);
        }
        continue;
      }
      const prior = this.projectedTaskStalls.get(task.taskId);
      if (prior) {
        try { this.deps.reportTaskStall?.({ taskId: task.taskId, state: 'recovered', observedAt, ...prior }); }
        catch (error) { this.deps.onError(error); }
        this.projectedTaskStalls.delete(task.taskId);
      }
    }
    for (const [taskId, prior] of this.projectedTaskStalls) {
      if (activeTaskIds.has(taskId)) continue;
      try { this.deps.reportTaskStall?.({ taskId, state: 'recovered', observedAt, ...prior }); }
      catch (error) { this.deps.onError(error); }
      this.projectedTaskStalls.delete(taskId);
    }
  }

  private dueCommand(nowMs: number): WorkflowSupervisorConsumerStatus['dueCommand'] {
    const candidates: NonNullable<WorkflowSupervisorConsumerStatus['dueCommand']>[] = [];
    for (const task of this.control.browserTasks()) {
      try {
        const poll = task.conversationId.startsWith('bootstrap:') ? this.control.bootstrapPoll(task.taskId) : this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        const command = poll.command;
        if (!command) continue;
        const effect = this.control.getEffect(command.effectId);
        const createdAtMs = effect?.createdAt ? Date.parse(effect.createdAt) : Number.NaN;
        candidates.push({ taskId: task.taskId, conversationId: task.conversationId, effectId: command.effectId, mode: command.mode, kind: command.kind,
          ...(effect?.createdAt ? { createdAt: effect.createdAt } : {}), ...(Number.isFinite(createdAtMs) ? { ageMs: Math.max(0, nowMs - createdAtMs) } : {}) });
      } catch { /* read projection only */ }
    }
    candidates.sort((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1));
    return candidates[0];
  }

  status(): WorkflowSupervisorConsumerStatus {
    const nowMs = this.deps.nowMs();
    const dueCommand = this.dueCommand(nowMs);
    const dueTaskFailure = dueCommand ? this.taskTransportFailures.get(dueCommand.taskId) : undefined;
    const projectedFailure = dueTaskFailure
      ? { code: dueTaskFailure.code, observedAtMs: dueTaskFailure.observedAtMs, taskId: dueCommand!.taskId, ...(dueTaskFailure.effectId ? { effectId: dueTaskFailure.effectId } : {}) }
      : this.lastFailure;
    const stalled = Boolean(this.inflight && this.lastTickStartedAtMs !== undefined && nowMs - this.lastTickStartedAtMs > MAX_TRANSPORT_BACKOFF_MS + 10_000);
    return {
      enabled: true, running: Boolean(this.timer) && !this.closed, observedAt: new Date(nowMs).toISOString(),
      ...(isoTime(this.lastTickStartedAtMs) ? { lastTickStartedAt: isoTime(this.lastTickStartedAtMs) } : {}),
      ...(isoTime(this.lastTickCompletedAtMs) ? { lastTickCompletedAt: isoTime(this.lastTickCompletedAtMs) } : {}),
      ...(isoTime(this.lastCommandAttemptAtMs) ? { lastCommandAttemptAt: isoTime(this.lastCommandAttemptAtMs) } : {}),
      ...(this.nextRunAtMs > 0 ? { nextAttemptAt: new Date(this.nextRunAtMs).toISOString() } : {}),
      transportFailureStreak: this.transportFailureStreak,
      providerBackpressureMs: chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, nowMs), stalled,
      ...(dueCommand ? { dueCommand } : {}),
      ...(projectedFailure ? { lastFailure: { code: projectedFailure.code, observedAt: new Date(projectedFailure.observedAtMs).toISOString(),
        ...(projectedFailure.taskId ? { taskId: projectedFailure.taskId } : {}), ...(projectedFailure.effectId ? { effectId: projectedFailure.effectId } : {}) } } : {}),
    };
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer || this.closed) return;
    const activeIntervalMs = Math.max(1, Math.trunc(intervalMs));
    const idleIntervalMs = Math.max(activeIntervalMs, IDLE_INTERVAL_MS);
    const tick = () => {
      if (this.inflight || this.closed || this.deps.nowMs() < this.nextRunAtMs) return;
      this.inflight = this.runOnce().catch((error) => { this.noteFailure(consumerFailureCode(error, 'WORKFLOW_SUPERVISOR_COMPUTER_TARGET_CONSUMER_FAILED')); this.deps.onError(error); }).finally(() => {
        const baseIntervalMs = this.lastRunHadTasks ? activeIntervalMs : idleIntervalMs;
        this.nextRunAtMs = this.deps.nowMs() + (this.lastRunTransportUnavailable
          ? Math.min(baseIntervalMs * 2 ** Math.min(this.transportFailureStreak, MAX_TRANSPORT_BACKOFF_STEPS), MAX_TRANSPORT_BACKOFF_MS)
          : baseIntervalMs);
        this.inflight = undefined;
      });
    };
    tick();
    // This consumer is part of the persistent canonical Runtime, not optional
    // background cleanup. Keep the timer referenced so provider continuation
    // cannot silently stop while the Runtime and MCP listener remain healthy.
    this.timer = this.deps.setInterval(tick, activeIntervalMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) this.deps.clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight?.catch(() => undefined);
    await this.deps.targetPort.close().catch(() => undefined);
    this.observedAssistant.clear(); this.providerFailureSeen.clear(); this.providerFailureAwaitingClear.clear(); this.freshSendCheckedAt.clear(); this.taskTransportFailures.clear(); this.projectedTaskStalls.clear(); this.awaitingReceiptObservedAtMs.clear();
  }

  async runOnce(): Promise<void> {
    if (this.closed) return;
    this.lastTickStartedAtMs = this.deps.nowMs();
    this.freshSendCheckedAt.clear(); this.lastRunTransportUnavailable = false;
    this.syncTaskStallProjections();
    const tasks = this.control.browserTasks();
    this.lastRunHadTasks = tasks.length > 0;
    let inventory;
    try { inventory = await this.deps.targetPort.inventory(); }
    catch (error) {
      this.lastRunTransportUnavailable = true;
      this.noteFailure(consumerFailureCode(error, 'WORKFLOW_SUPERVISOR_COMPUTER_TARGET_INVENTORY_UNAVAILABLE'));
      this.transportFailureStreak = Math.min(this.transportFailureStreak + 1, MAX_TRANSPORT_BACKOFF_STEPS);
      this.lastTickCompletedAtMs = this.deps.nowMs();
      throw error;
    }
    this.conversations = inventory.conversations.map((conversation) => ({ conversation_id: conversation.conversationId, canonical_url: conversation.canonicalUrl,
      ...(conversation.title ? { title: conversation.title } : {}), ...(conversation.projectTitle ? { projectTitle: conversation.projectTitle } : {}),
      ...(conversation.projectUrl ? { projectUrl: conversation.projectUrl } : {}), ...(conversation.isCurrent ? { is_current: true } : {}) }));
    if (!inventory.complete && tasks.length > 0) {
      this.lastRunTransportUnavailable = true;
      this.noteFailure('WORKFLOW_SUPERVISOR_NATIVE_INVENTORY_INCOMPLETE');
    } else if (inventory.complete) {
      this.clearTransportFailure();
    }
    // Due-work omits tasks during observation/retry spacing. Retention follows
    // task lifetime; otherwise every cooldown closes the tab and the next
    // observation reloads the same conversation from the provider.
    const activeResourceKeys = this.control.listTasks(true).map((task) => task.conversationId.startsWith('bootstrap:') ? `chatgpt.bootstrap:${task.taskId}` : `chatgpt.conversation:${task.conversationId}`);
    await this.deps.targetPort.cleanup(activeResourceKeys).catch((error) => this.deps.onError(error));
    for (const task of tasks) {
      if (this.closed) break;
      await this.serviceFreshSend();
      try {
        const poll = task.conversationId.startsWith('bootstrap:') ? this.control.bootstrapPoll(task.taskId) : this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        if (poll.terminal || poll.command?.mode === 'send') continue;
        await this.processTask(task);
      } catch (error) {
        this.noteTaskFailure(consumerFailureCode(error, 'WORKFLOW_SUPERVISOR_COMPUTER_TARGET_COMMAND_FAILED'), task);
        this.deps.onError(error);
      }
    }
    await this.serviceFreshSend();
    this.discovery.update(this.conversations, 'computer-browser');
    this.control.recordBrowserDiscovery('computer-browser', this.discovery.sourceConversations('computer-browser'));
    this.transportFailureStreak = this.lastRunTransportUnavailable ? Math.min(this.transportFailureStreak + 1, MAX_TRANSPORT_BACKOFF_STEPS) : 0;
    this.lastTickCompletedAtMs = this.deps.nowMs();
  }

  private async serviceFreshSend(excludeTaskId?: string): Promise<void> {
    if (this.closed || this.servicingFreshSend) return;
    const nowMs = this.deps.nowMs();
    const eligible = this.control.browserTasks().flatMap((task) => {
      if (task.taskId === excludeTaskId) return [];
      try {
        const poll = task.conversationId.startsWith('bootstrap:') ? this.control.bootstrapPoll(task.taskId) : this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
        if (poll.command?.mode !== 'send') return [];
        return [{ task, effectId: poll.command.effectId, checkedAt: this.freshSendCheckedAt.get(poll.command.effectId) }];
      } catch { return []; }
    });
    const pending = new Set(eligible.map(({ effectId }) => effectId));
    for (const effectId of this.freshSendCheckedAt.keys()) if (!pending.has(effectId)) this.freshSendCheckedAt.delete(effectId);
    eligible.sort((left, right) => (left.checkedAt ?? 0) - (right.checkedAt ?? 0));
    const next = eligible.find(({ checkedAt }) => checkedAt === undefined || nowMs - checkedAt >= DEFAULT_INTERVAL_MS);
    if (!next) return;
    this.freshSendCheckedAt.set(next.effectId, nowMs); this.lastCommandAttemptAtMs = nowMs; this.servicingFreshSend = true;
    try { await this.processTask(next.task); }
    catch (error) { this.noteTaskFailure(consumerFailureCode(error, 'WORKFLOW_SUPERVISOR_COMPUTER_TARGET_COMMAND_FAILED'), next.task, next.effectId); this.deps.onError(error); }
    finally { this.servicingFreshSend = false; }
  }

  private async processTask(task: WorkflowSupervisorBrowserTask): Promise<void> {
    // Retry spacing is task-local and covers every exact-target/conversation
    // failure, not just an unloaded page: the retained tab is re-observed at a
    // growing interval instead of being closed, re-opened, and reloaded.
    const transportFailure = this.taskTransportFailures.get(task.taskId);
    if (transportFailure
      && TASK_TARGET_SPACED_FAILURE_CODES.has(transportFailure.code)
      && this.deps.nowMs() - transportFailure.observedAtMs < taskTargetRetryDelayMs(transportFailure.streak)) return;
    if (task.conversationId.startsWith('bootstrap:')) { await this.bootstrapTask(task); return; }
    let poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
    if (poll.terminal) return;
    if (poll.command) this.lastCommandAttemptAtMs = this.deps.nowMs();
    // A turn whose bounded resume is exhausted keeps one slow read-only probe so
    // late evidence can still land, without polling an unchanged surface at the
    // active tick rate and without minting any new provider turn.
    if (!poll.command && this.control.taskStall(task.taskId).state === 'provider_resume_exhausted') {
      const observedAt = this.awaitingReceiptObservedAtMs.get(task.taskId) ?? 0;
      if (this.deps.nowMs() - observedAt < AWAITING_RECEIPT_OBSERVATION_MS) return;
      this.awaitingReceiptObservedAtMs.set(task.taskId, this.deps.nowMs());
    }
    // Acquiring a conversation the inventory does not already expose is a
    // provider navigation/history read, not local observation. The ChatGPT rate
    // limit is account-wide, so while explicit backpressure is active the answer
    // is strictly fewer requests: keep an already-retained surface observable and
    // never open another one. Cooldown is transient, so this defers rather than
    // strands the task.
    if (chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs()) > 0
      && !this.conversations.some((conversation) => conversation.conversation_id === task.conversationId)) return;
    const ensured = await this.deps.targetPort.ensureExact(identityForTask(task));
    if (ensured.state !== 'ready') { this.noteTargetUnavailable(task, poll.command?.effectId, ensured.failure); return; }
    const target = ensured.target;
    const snapshot = ensured.observation ?? await target.observe({ includeUserHistory: false, includePageText: false });
    if (!exactConversation(snapshot, task)) { this.noteTargetUnavailable(task, poll.command?.effectId, { code: 'WORKFLOW_SUPERVISOR_EXACT_CONVERSATION_UNPROVEN' }); return; }
    if (!conversationContentAvailable(snapshot)) { this.noteTargetUnavailable(task, poll.command?.effectId, { code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' }); return; }
    this.clearTaskFailure(task.taskId, poll.command?.effectId);
    this.conversations.push({ conversation_id: task.conversationId, canonical_url: task.conversationUrl,
      ...(snapshot.title.trim() ? { title: snapshot.title.trim().slice(0, 512) } : {}), ...projectMetadataFromConversationUrl(snapshot.url) });
    const providerBusy = snapshot.isGenerating;
    const latestRoleStillUser = snapshot.latestTurnRole === 'user';
    const observedProviderFailureCode = chatgptProviderPageFailure([
      snapshot.providerFailureText,
      snapshot.providerActivityText,
    ].filter(Boolean).join('\n'));
    const providerFailureAwaitingClear = this.providerFailureAwaitingClear.get(task.conversationId);
    if (!observedProviderFailureCode) this.providerFailureAwaitingClear.delete(task.conversationId);
    const providerFailureCode = observedProviderFailureCode && observedProviderFailureCode !== providerFailureAwaitingClear
      ? observedProviderFailureCode
      : undefined;
    const priorProviderFailure = this.providerFailureSeen.get(task.conversationId);
    if (!observedProviderFailureCode) this.providerFailureSeen.delete(task.conversationId);
    else if (priorProviderFailure !== observedProviderFailureCode) { noteChatgptProviderBackpressure(this.deps.providerScopeKey, observedProviderFailureCode, this.deps.nowMs()); this.providerFailureSeen.set(task.conversationId, observedProviderFailureCode); }
    let providerBackpressureMs = chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs());
    if (poll.command?.mode !== 'reconcile' && providerFailureCode === CHATGPT_AUTOMATION_RATE_LIMITED && providerBackpressureMs > 0) return;
    if (!poll.command && !providerBusy && snapshot.latestTurnRole === 'assistant' && snapshot.latestAssistantResponse.trim()) {
      const responseFingerprint = sha256(snapshot.latestAssistantResponse);
      if (this.observedAssistant.get(task.conversationId) !== responseFingerprint) {
        try { await this.control.browserObserveAssistant({ conversationId: task.conversationId, conversationUrl: task.conversationUrl, responseText: snapshot.latestAssistantResponse }); this.observedAssistant.set(task.conversationId, responseFingerprint); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('WORKFLOW_SUPERVISOR_') && !message.includes('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH')) this.observedAssistant.set(task.conversationId, responseFingerprint);
          if (!message.includes('WORKFLOW_SUPERVISOR_TASK_TERMINAL')) this.deps.onError(error);
        }
      }
      poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
      if (poll.terminal) return;
    }
    // A queued continuation must not hide a visible failure from the preceding
    // provider turn. Observe the error first so the existing bounded recovery
    // chain owns it instead of repeatedly attempting the queued send.
    if (!poll.command || providerFailureCode) {
      this.control.browserObserveProviderTurn({ conversationId: task.conversationId, conversationUrl: task.conversationUrl,
        generating: providerFailureCode ? false : providerBusy || latestRoleStillUser, latestAssistantResponse: snapshot.latestAssistantResponse,
        providerActivityText: snapshot.providerActivityText, providerFailureCode: providerFailureCode === CHATGPT_AUTOMATION_RATE_LIMITED ? undefined : providerFailureCode,
        observedAtMs: this.deps.nowMs(), graceMs: this.deps.providerIdleGraceMs });
      poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
      const staleTurnRecovery = poll.command?.kind === 'recovery';
      if (providerBusy && !providerFailureCode && !staleTurnRecovery) return;
      if (latestRoleStillUser && !providerFailureCode && !staleTurnRecovery) return;
    }
    providerBackpressureMs = chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs());
    const completedSource = poll.command ? Boolean(this.control.getEffect(poll.command.effectId)?.sourceCompletionFingerprint) : false;
    const staleTurnRecovery = poll.command?.kind === 'recovery';
    const commandMutationBlocked = providerBackpressureMs > 0
      || (providerBusy && !providerFailureCode && !staleTurnRecovery)
      || (latestRoleStillUser && !providerFailureCode && !completedSource && !staleTurnRecovery);
    if (poll.command?.mode === 'send' && commandMutationBlocked) return;
    if (poll.command) {
      if (poll.command.kind === 'recovery' && observedProviderFailureCode) {
        this.providerFailureAwaitingClear.set(task.conversationId, observedProviderFailureCode);
      }
      await this.executeCommand(target, poll.command, task);
    }
  }

  private async bootstrapTask(task: WorkflowSupervisorBrowserTask): Promise<void> {
    const poll = this.control.bootstrapPoll(task.taskId);
    const command = poll.command;
    if (!command) return;
    if (command.mode === 'reconcile') { await this.reconcileBootstrapTask(task, command); return; }
    if (command.mode !== 'send') return;
    // Bootstrap opens a provider project surface and then submits the first
    // prompt. Both are provider requests, so account-wide backpressure defers the
    // whole attempt instead of racing it against an explicit rate limit.
    if (chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs()) > 0) return;
    const opened = await this.deps.targetPort.openBootstrap(this.control.bootstrapProjectUrl(task.taskId), task.taskId);
    if (opened.state !== 'ready') { this.noteTargetUnavailable(task, command.effectId, opened.failure); return; }
    const target = opened.target;
    if (!this.control.bootstrapBeginEffect({ taskId: task.taskId, effectId: command.effectId, dispatchId: `bootstrap-${randomUUID()}`, dispatchGeneration: command.dispatchGeneration })) return;
    try {
      const dispatch = await withChatgptProviderDispatchLane(this.deps.providerScopeKey, () => target.dispatch(command.prompt),
        (result) => result.mutation === 'attempted' ? { providerAccepted: result.confirmed === true } : { code: result.reasonCode, message: result.reasonCode });
      if (dispatch.mutation === 'not_attempted') {
        this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'not_applied', evidence: { pre_send_rejection: true, reason: dispatch.reasonCode } });
        await this.deps.targetPort.release(target.targetId).catch(() => undefined);
        return;
      }
      let reason = 'bootstrap_outbound_not_confirmed';
      for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
        try {
          const snapshot = await target.observe({ includeUserHistory: true, includePageText: false });
          const identity = parseChatgptConversationIdentity(snapshot.url);
          if (!snapshotTargetMarkerPresent(snapshot, command.effectId)) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_EFFECT_MARKER_NOT_OBSERVED');
          const promoted = await this.deps.targetPort.promoteBootstrap(target.targetId, { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl });
          if (promoted.state !== 'ready') throw new Error(promoted.failure.code);
          this.control.bindBootstrapConversation({ taskId: task.taskId, conversationId: identity.conversationId, conversationUrl: identity.canonicalUrl });
          this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'applied' });
          this.clearTaskFailure(task.taskId, command.effectId);
          return;
        } catch (error) { reason = error instanceof Error ? error.message : String(error); if (attempt < MAX_LOCAL_OBSERVATION_ATTEMPTS) await this.deps.sleep(localObservationDelayMs(attempt, 1_000, 4_000)); }
      }
      this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'unknown', evidence: { reconciliation: true, reason } });
    } catch (error) {
      this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'unknown', evidence: { reconciliation: true, reason: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  private async reconcileBootstrapTask(task: WorkflowSupervisorBrowserTask, command: WorkflowSupervisorBrowserCommand): Promise<void> {
    const matches = await this.deps.targetPort.findBySubmittedMarker(
      renderEffectMarker(command.effectId),
      task.taskId,
      async () => { await this.serviceFreshSend(task.taskId); },
    );
    const ready = matches.filter((result): result is Extract<typeof result, { state: 'ready' }> => result.state === 'ready');
    const observeUnknown = (reason: string): void => this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-reconcile-${randomUUID()}`, outcome: 'unknown', evidence: { reconciliation: true, reason } });
    if (ready.length === 0) { observeUnknown('bootstrap_target_not_observed'); return; }
    if (ready.length !== 1) { observeUnknown('bootstrap_reconcile_ambiguous'); return; }
    const match = ready[0]!;
    const snapshot = match.observation ?? await match.target.observe({ includeUserHistory: true, includePageText: false });
    let identity;
    try { identity = parseChatgptConversationIdentity(snapshot.url); } catch { observeUnknown('bootstrap_conversation_identity_unavailable'); return; }
    if (!snapshotTargetMarkerPresent(snapshot, command.effectId)) { observeUnknown('bootstrap_effect_marker_not_observed'); return; }
    const promoted = await this.deps.targetPort.promoteBootstrap(match.target.targetId, { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl });
    if (promoted.state !== 'ready') { observeUnknown(promoted.failure.code); return; }
    this.control.bindBootstrapConversation({ taskId: task.taskId, conversationId: identity.conversationId, conversationUrl: identity.canonicalUrl });
    this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-reconcile-${randomUUID()}`, outcome: 'applied' });
    this.clearTaskFailure(task.taskId, command.effectId);
  }

  private async executeCommand(target: ComputerChatgptConversationTarget, command: WorkflowSupervisorBrowserCommand, task: WorkflowSupervisorBrowserTask): Promise<void> {
    let snapshot = await target.observe({ includeUserHistory: true, includePageText: true });
    if (!exactConversation(snapshot, task) || !conversationContentAvailable(snapshot)) {
      this.noteTargetUnavailable(task, command.effectId, { code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' });
      return;
    }
    if (command.mode === 'send' && snapshot.isGenerating && command.kind !== 'recovery') return;
    let mode = command.mode;
    if (mode === 'send') {
      const begin = this.control.browserBeginEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        dispatchId: `computer-${randomUUID()}`, dispatchGeneration: command.dispatchGeneration,
        evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, latest_user_text: snapshot.latestUserText, latest_assistant_response: snapshot.latestAssistantResponse } });
      if (!begin.started) mode = 'reconcile';
    }
    if (mode === 'reconcile') {
      const exact = normalize(snapshot.latestUserText) === normalize(command.prompt);
      const markerPresent = snapshotTargetMarkerPresent(snapshot, command.effectId);
      if (exact || markerPresent) {
        this.control.browserObserveEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
          observationId: `computer-observe-${randomUUID()}`, outcome: 'applied',
          evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, exact_user_message: exact, reconciliation: true, target_marker_present: markerPresent } });
        return;
      }
      const reason = 'submission_not_observed';
      this.control.browserObserveEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        observationId: `computer-observe-${randomUUID()}`, outcome: 'unknown',
        evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, reconciliation: true, target_marker_present: false, reason,
          observation_fingerprint: unknownObservationFingerprint(command.effectId, reason, snapshot) } });
      return;
    }
    let dispatch: Awaited<ReturnType<ComputerChatgptConversationTarget['dispatch']>>;
    try {
      dispatch = await withChatgptProviderDispatchLane(this.deps.providerScopeKey, () => target.dispatch(command.prompt, command.kind === 'recovery' ? { mode: 'recover' } : undefined),
        (result) => result.mutation === 'attempted' ? { providerAccepted: result.confirmed === true } : { code: result.reasonCode, message: result.reasonCode });
    } catch (error) {
      this.control.browserObserveEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        observationId: `computer-observe-${randomUUID()}`, outcome: 'unknown',
        evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, reconciliation: true, reason: consumerFailureCode(error, 'provider_dispatch_exception') } });
      throw error;
    }
    if (dispatch.mutation === 'not_attempted') {
      this.control.browserObserveDispatchFailure({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        observationId: `computer-observe-${randomUUID()}`, dispatchGeneration: command.dispatchGeneration, reason: dispatch.reasonCode });
      return;
    }
    if (dispatch.confirmed) {
      this.control.browserObserveEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        observationId: `computer-observe-${randomUUID()}`, outcome: 'applied', evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, provider_confirmed: true } });
      return;
    }
    let exact = false; let markerPresent = false;
    for (let attempt = 1; attempt <= MAX_LOCAL_OBSERVATION_ATTEMPTS; attempt += 1) {
      snapshot = await target.observe({ includeUserHistory: true, includePageText: true });
      exact = normalize(snapshot.latestUserText) === normalize(command.prompt); markerPresent = snapshotTargetMarkerPresent(snapshot, command.effectId);
      if (exact || markerPresent || attempt >= MAX_LOCAL_OBSERVATION_ATTEMPTS) break;
      await this.deps.sleep(localObservationDelayMs(attempt, 1_000, 4_000));
    }
    this.control.browserObserveEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
      observationId: `computer-observe-${randomUUID()}`, outcome: exact || markerPresent ? 'applied' : 'unknown',
      evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, exact_user_message: exact, target_marker_present: markerPresent,
        ...(!exact && !markerPresent ? { reason: 'outbound_not_confirmed', observation_fingerprint: unknownObservationFingerprint(command.effectId, 'outbound_not_confirmed', snapshot) } : {}) } });
  }
}

export function startWorkflowSupervisorNativeBrowserAdapter(
  control: WorkflowSupervisorControlPlane,
  discovery: WorkflowSupervisorEphemeralDiscovery,
  dependencies: WorkflowSupervisorComputerBrowserDependencies,
): WorkflowSupervisorNativeBrowserHandle {
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, discovery, dependencies);
  adapter.start();
  return { adapter, status: () => adapter.status(), close: async () => { await adapter.close(); } };
}
