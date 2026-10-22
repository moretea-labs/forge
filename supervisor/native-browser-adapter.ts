import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ComputerChatgptConversationIdentity,
  ComputerChatgptConversationObservation,
  ComputerChatgptConversationTarget,
  ComputerChatgptConversationTargetPort,
} from '../packages/plugin-runtime/computer';
import {
  CHATGPT_AUTOMATION_RATE_LIMITED,
  CHATGPT_AUTOMATION_CONVERSATION_LIMIT_REACHED,
  chatgptProviderBackpressureRemainingMs,
  chatgptProviderPageFailure,
  noteChatgptProviderBackpressure,
  withChatgptProviderDispatchLane,
} from '../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { WorkflowSupervisorControlPlane } from './control-plane';
import { hasCommittedSupervisorEnvelope, parseSupervisorCompletion, renderEffectMarker, sha256 } from './protocol';
import type { WorkflowSupervisorEphemeralDiscovery } from './server';
import type {
  WorkflowSupervisorBrowserCommand,
  WorkflowSupervisorBrowserTask,
  WorkflowSupervisorConsumerStatus,
  WorkflowSupervisorPreflightComposerObservation,
  WorkflowSupervisorSilentTurn,
} from './types';

const DEFAULT_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
const MAX_TRANSPORT_BACKOFF_MS = 60_000;
const MAX_TRANSPORT_BACKOFF_STEPS = 6;
const MAX_LOCAL_OBSERVATION_ATTEMPTS = 3;
const USER_VISIBLE_DEGRADED_AFTER_MS = 30_000;
/**
 * All task-local Chrome target/receiver failures reuse this existing bounded
 * retry cadence. Missing receiver and error-page errors must not spin once per
 * tick just because their provider wording is absent from an allowlist.
 * Consumer-wide inventory unavailability retains its own backoff boundary.
 * Observations alone never authorize a new provider Send.
 */
const TASK_TARGET_RETRY_BASE_MS = 30_000;
/** Slow read-only probe cadence for an applied turn whose bounded resume is exhausted. */
const AWAITING_RECEIPT_OBSERVATION_MS = 60_000;
// Give a fully idle conversation longer than the 60-second late-receipt probe
// cadence before releasing its disposable Chrome attachment. Under pressure
// only the eight most recently idle exact resources retain that grace.
const SUPERVISOR_IDLE_TAB_GRACE_MS = 5 * 60_000;
const SUPERVISOR_IDLE_TAB_RETAIN_LIMIT = 8;
const TASK_TARGET_RETRY_MAX_MS = 10 * 60_000;
// Preparation may inspect/change a local draft, but never sends to ChatGPT.
// Stop after bounded unsuccessful preflights; an unchanged failing provider
// must not become either an infinite UI loop or a spent send generation.
const SUPERVISOR_PRE_SEND_BLOCKED = 'WORKFLOW_SUPERVISOR_PRE_SEND_BLOCKED';

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
function preflightComposerObservation(snapshot: ComputerChatgptConversationObservation, effectId: string): WorkflowSupervisorPreflightComposerObservation {
  const value = snapshot.composerText;
  const selectorVersion = snapshot.composerSelectorVersion === 'visible-single-v2' ? snapshot.composerSelectorVersion : undefined;
  if (typeof value !== 'string') return { chars: 0, fingerprint: '', classification: 'unavailable', ...(selectorVersion ? { selectorVersion } : {}) };
  const marker = /^<<<FORGE_WORKFLOW_EFFECT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120})>>>/.exec(value);
  return {
    chars: value.length,
    fingerprint: sha256(`preflight-composer-v1:\0${value}`).slice(0, 24),
    classification: !value.trim() ? 'empty' : marker ? (marker[1] === effectId ? 'current_effect' : 'other_effect') : 'unattributed',
    ...(selectorVersion ? { selectorVersion } : {}),
  };
}
/**
 * Optional, single-effect operator backup: this records no draft by default.
 * A 0600 on-device authorization marker must name the exact blocked effect,
 * current task, project URL, and observed fingerprint before raw text is saved.
 * The file remains local; no transcript, plugin receipt, or logs carry text.
 * This never clears an editor or permits a Send.
 */
export function backupAuthorizedBlockedComposer(
  controllerHome: string,
  taskId: string,
  effectId: string,
  projectUrl: string,
  snapshot: ComputerChatgptConversationObservation,
): string | undefined {
  if (!/^supervisor:[a-z0-9]+$/.test(taskId) || !/^(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}$/.test(effectId)) return;
  if (snapshot.composerSelectorVersion !== 'visible-single-v2' || !snapshot.composerText?.trim()) return;
  if (preflightComposerObservation(snapshot, effectId).classification !== 'unattributed') return;
  let expectedUrl: URL;
  let actualUrl: URL;
  try { expectedUrl = new URL(projectUrl); actualUrl = new URL(snapshot.url); } catch { return; }
  const projectRoute = (url: URL): string | undefined =>
    /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (expectedUrl.origin !== 'https://chatgpt.com' || actualUrl.origin !== expectedUrl.origin
    || !projectRoute(expectedUrl) || projectRoute(actualUrl) !== projectRoute(expectedUrl)) return;
  const observation = preflightComposerObservation(snapshot, effectId);
  const base = join(controllerHome, 'supervisor', 'draft-backups');
  const authorization = join(base, `authorization-${effectId}.json`);
  let marker: unknown;
  try { marker = JSON.parse(readFileSync(authorization, 'utf8')); } catch { return; }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return;
  const expected = marker as Record<string, unknown>;
  if (expected.schemaVersion !== 1 || expected.taskId !== taskId
    || expected.effectId !== effectId || expected.projectUrl !== projectUrl
    || expected.fingerprint !== observation.fingerprint || expected.consent !== 'user-authorized-exact-backup') return;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const path = join(base, `composer-${effectId}-${observation.fingerprint}.json`);
  const payload = { schemaVersion: 1, taskId, effectId, projectUrl, observedUrl: snapshot.url,
    selectorVersion: snapshot.composerSelectorVersion, fingerprint: observation.fingerprint,
    composerText: snapshot.composerText };
  try {
    writeFileSync(path, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    // A repeated preflight must not overwrite the original evidence.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as typeof payload;
      if (existing.fingerprint !== payload.fingerprint || existing.composerText !== payload.composerText
        || existing.taskId !== taskId || existing.observedUrl !== snapshot.url) return;
    } catch { return; }
  }
  return path;
}

/** An explicit on-device authorization + verified backup permits exactly one
 * existing Chrome-extension editor replacement at prepare time. The dispatch
 * still uses the unmodified canonical effect prompt and sole provider writer.
 */
export function authorizedDraftReplacementPrompt(
  controllerHome: string, taskId: string, effectId: string, projectUrl: string,
  snapshot: ComputerChatgptConversationObservation, prompt: string,
): string | undefined {
  // Disk projection does not attest that this exact Chrome tab loaded the latest script.
  // Never spend a one-use authorization before a matching read-only contract receipt.
  if (snapshot.composerReplacementContract !== 'exact-backed-up-project-draft-v1') return;
  const backup = backupAuthorizedBlockedComposer(controllerHome, taskId, effectId, projectUrl, snapshot);
  if (!backup || !prompt.startsWith(`<<<FORGE_WORKFLOW_EFFECT_V1:${effectId}>>>`)) return;
  const observation = preflightComposerObservation(snapshot, effectId);
  let marker: unknown;
  try { marker = JSON.parse(readFileSync(join(controllerHome, 'supervisor', 'draft-backups', `authorization-${effectId}.json`), 'utf8')); }
  catch { return; }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return;
  const auth = marker as Record<string, unknown>;
  if (auth.taskId !== taskId || auth.effectId !== effectId || auth.projectUrl !== projectUrl
    || auth.fingerprint !== observation.fingerprint || auth.consent !== 'user-authorized-exact-backup'
    || typeof auth.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(auth.nonce)) return;
  // The authorization is a single-use physical mutation capability, not a
  // reusable password. Atomic exclusive creation remains durable across
  // Runtime/extension restarts and concurrent preflights. A failed prepare
  // consumes this token; the operator must explicitly authorize another one.
  const consumption = join(controllerHome, 'supervisor', 'draft-backups',
    `consumed-${effectId}-${auth.nonce}.json`);
  try {
    writeFileSync(consumption, JSON.stringify({ schemaVersion: 1, taskId, effectId,
      projectUrl, fingerprint: observation.fingerprint, nonce: auth.nonce }) + '\n',
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch { return; }
  return `<<<FORGE_DRAFT_REPLACE_V1:${observation.fingerprint}:${auth.nonce}>>>\n${prompt}`;
}

/**
 * An exact machine-owned draft can outlive its effect in a Project editor.
 * Already-applied effects may be reflected by ChatGPT in other Project tabs;
 * only the immutable full ledger prompt (allowing layout-only whitespace)
 * qualifies. For never-sent STOPPED effects retain the original stricter
 * preflight digest rule. Human, unknown-send and modified drafts never qualify.
 */
export function retiredBootstrapDraftReplacementPrompt(
  control: WorkflowSupervisorControlPlane,
  task: WorkflowSupervisorBrowserTask,
  snapshot: ComputerChatgptConversationObservation,
  prompt: string,
): string | undefined {
  if (snapshot.composerSelectorVersion !== 'visible-single-v2' || !snapshot.composerText
    || snapshot.isGenerating || !prompt.startsWith('<<<FORGE_WORKFLOW_EFFECT_V1:')) return;
  const draft = snapshot.composerText.replace(/\r\n?/g, '\n');
  const match = /^<<<FORGE_WORKFLOW_EFFECT_V1:((?:fx|crpe)_[a-zA-Z0-9_-]{8,120})>>>/.exec(draft);
  if (!match) return;
  const staleEffect = control.getEffect(match[1]!);
  if (!staleEffect || staleEffect.taskId === task.taskId) return;
  const alreadyApplied = control.store.effectApplied(staleEffect.effectId);
  // A live effect can only be retired after durable proof that its own Send
  // already applied. This never treats an unknown Send as a safe draft.
  if (alreadyApplied) {
    if (snapshot.composerReplacementContract !== 'exact-backed-up-project-draft-v1') return;
    let expected: URL; let actual: URL;
    try { expected = new URL(control.bootstrapProjectUrl(task.taskId)); actual = new URL(snapshot.url); }
    catch { return; }
    const projectRoute = (url: URL) => /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (expected.origin !== 'https://chatgpt.com' || actual.origin !== expected.origin
      || !projectRoute(expected) || projectRoute(actual) !== projectRoute(expected)) return;
    const canonical = staleEffect.prompt.replace(/\r\n?/g, '\n');
    if (draft.replace(/\s+/g, ' ').trim() !== canonical.replace(/\s+/g, ' ').trim()) return;
  } else {
    if (control.effectDispatchBudget(staleEffect.effectId).generations !== 0) return;
    const oldTask = control.getTask(staleEffect.taskId);
    const retired = oldTask && control.getTaskByConversationId(oldTask.conversationId);
    if (retired?.terminal !== 'STOPPED'
      || control.bootstrapProjectUrl(staleEffect.taskId) !== control.bootstrapProjectUrl(task.taskId)) return;
  }
  const attested = control.preSendComposerObservation(staleEffect.effectId);
  // Both proofs are exact: the immutable effect text, or the previously
  // attested pre-Send editor bytes. The older extension could synthesize an
  // extra newline inside a URL; the corrected extension reads the canonical
  // text without it. Require the persisted no-click preflight in either case.
  const fingerprint = sha256('preflight-composer-v1:\0' + draft).slice(0, 24);
  const exactSource = draft === staleEffect.prompt.replace(/\r\n?/g, '\n');
  const exactPreflight = attested?.fingerprint === fingerprint && attested.chars === draft.length;
  if (!alreadyApplied && (!attested || (!exactSource && !exactPreflight))) return;
  return '<<<FORGE_RETIRED_DRAFT_V1:' + staleEffect.effectId + ':' + fingerprint + '>>>\n' + prompt;
}

function exactConversation(snapshot: ComputerChatgptConversationObservation, task: WorkflowSupervisorBrowserTask): boolean {
  try { return parseChatgptConversationIdentity(snapshot.url).conversationId === task.conversationId; }
  catch { return false; }
}
function exactCanonicalConversationUrl(snapshot: ComputerChatgptConversationObservation, task: WorkflowSupervisorBrowserTask): boolean {
  try { return parseChatgptConversationIdentity(snapshot.url).canonicalUrl === parseChatgptConversationIdentity(task.conversationUrl).canonicalUrl; }
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
  private readonly observedAssistant = new Map<string, { fingerprint: string; receiptRejected: boolean }>();
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
  /** Derived from the tick's taskStall passes; the store remains the silence authority. */
  private projectedSilence?: WorkflowSupervisorSilentTurn & { taskId: string };
  /** Rebuildable idle-grace projection; Supervisor effects remain the sole authority. */
  private readonly idleResourceSinceMs = new Map<string, number>();

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

  private noteTaskFailure(code: string, task: WorkflowSupervisorBrowserTask, effectId?: string, recordFailure = true, verifiedEmptyShell = false): void {
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
    // Account-wide cooldown is not evidence that this *conversation* failed.
    if (!recordFailure || chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, nowMs) > 0) return;
    // Preflight rejections are already one durable failed attempt in the
    // Supervisor effect ledger; do not duplicate that diagnostic evidence.
    if (code !== SUPERVISOR_PRE_SEND_BLOCKED) {
      this.control.store.recordBrowserDeliveryAttemptFailure({
        taskId: task.taskId, conversationId: task.conversationId, code,
        ...(effectId ? { effectId } : {}), verifiedEmptyShell,
      });
    }
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
    // A user login/grant problem cannot be fixed by a different conversation.
    if (failure.humanAction) {
      this.noteTaskFailure(failure.code, task, effectId, false);
      this.deps.requestHumanAction?.({ taskId: task.taskId, ...(effectId ? { effectId } : {}), action: failure.humanAction, code: failure.code });
      return;
    }
    // Task-local failures are spaced independently of unrelated conversations.
    this.noteTaskFailure(failure.code, task, effectId);
  }

  private taskConversationContentAvailable(task: WorkflowSupervisorBrowserTask, snapshot: ComputerChatgptConversationObservation): boolean {
    if (!conversationContentAvailable(snapshot)) return false;
    // A hydrated composer is enough for a genuinely new enrollment, but not
    // evidence that an established conversation's history has loaded.
    // Avoid sending a continuation into a blank old shell after a completed
    // source turn. The canonical completion journal owns that distinction.
    if (snapshot.isGenerating || snapshot.latestUserText.trim() || snapshot.latestAssistantResponse.trim()) return true;
    return !this.control.store.hasCompletionInCurrentConversation(task.taskId);
  }

  private observeVerifiedEmptyShell(
    task: WorkflowSupervisorBrowserTask,
    effectId: string | undefined,
    command: { mode: string; dispatchGeneration?: number } | undefined,
    observation: ComputerChatgptConversationObservation,
  ): void {
    const code = 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE';
    const exactUrl = exactCanonicalConversationUrl(observation, task);
    const providerFailure = exactUrl && observation.providerFailureText
      ? chatgptProviderPageFailure(observation.providerFailureText) : undefined;
    if (providerFailure) noteChatgptProviderBackpressure(this.deps.providerScopeKey, providerFailure, this.deps.nowMs());
    const verified = exactUrl && !observation.providerFailureText.trim()
      && !this.taskConversationContentAvailable(task, observation)
      && !this.lastRunTransportUnavailable
      && this.conversations.some((conversation) => conversation.conversation_id === task.conversationId)
      && chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs()) === 0;
    if (!verified) {
      this.noteTargetUnavailable(task, effectId, { code: exactUrl
        ? 'WORKFLOW_SUPERVISOR_EMPTY_SHELL_EVIDENCE_UNVERIFIED'
        : 'WORKFLOW_SUPERVISOR_EMPTY_SHELL_IDENTITY_UNPROVEN' });
      return;
    }
    this.noteTaskFailure(code, task, effectId, true, true);
    const failure = this.taskTransportFailures.get(task.taskId);
    if (this.control.getTask(task.taskId)?.continuationPolicy.kind !== 'standalone_supervisor'
      || failure?.code !== code || failure.streak < 3
      || this.deps.nowMs() - failure.firstFailureAtMs < 2 * 60_000
      || command?.mode !== 'send' || command.dispatchGeneration !== 1
      || this.control.store.hasAppliedEffectAwaitingCompletion(task.taskId)
      || chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, this.deps.nowMs()) > 0) return;
    // The existing Supervisor CAS ledger is the only migration and send owner.
    this.control.migrateConversation({
      taskId: task.taskId, expectedConversationId: task.conversationId,
      fresh: true, requestId: `verified-unavailable:${task.conversationId}`,
      reason: 'exact_conversation_empty_shell_verified_across_spaced_browser_observations',
      authorizedBy: 'user-authorized-automatic-conversation-rotation',
    });
  }

  private handleVerifiedTerminalCapacity(
    task: WorkflowSupervisorBrowserTask,
    effectId: string | undefined,
    observation: ComputerChatgptConversationObservation,
  ): boolean {
    // A provider-owned terminal banner can be visible before historical turns
    // hydrate. The exact bound URL and live failure region are mandatory;
    // transcript/activity text alone is never sufficient for migration.
    if (!exactCanonicalConversationUrl(observation, task)
      || chatgptProviderPageFailure(observation.providerFailureText) !== CHATGPT_AUTOMATION_CONVERSATION_LIMIT_REACHED) return false;
    if (this.control.store.hasAppliedEffectAwaitingCompletion(task.taskId)) {
      this.noteTaskFailure('WORKFLOW_SUPERVISOR_CAPACITY_APPLIED_TURN_UNRESOLVED', task, effectId, false);
      return true;
    }
    // Supervisor's existing atomic CAS migration independently rejects any
    // unresolved/unknown Send or other still-owned effect.
    this.control.migrateConversation({
      taskId: task.taskId,
      expectedConversationId: task.conversationId,
      fresh: true,
      requestId: `capacity:${task.conversationId}`,
      reason: 'live_provider_conversation_capacity_exhausted',
      authorizedBy: 'user-authorized-automatic-conversation-rotation',
    });
    return true;
  }

  private syncTaskStallProjections(): void {
    const activeTaskIds = new Set<string>();
    const observedAt = new Date(this.deps.nowMs()).toISOString();
    let oldestSilence: (WorkflowSupervisorSilentTurn & { taskId: string }) | undefined;
    for (const task of this.control.listTasks(true)) {
      activeTaskIds.add(task.taskId);
      let stall: ReturnType<WorkflowSupervisorControlPlane['taskStall']>;
      try { stall = this.control.taskStall(task.taskId); }
      catch (error) { this.deps.onError(error); continue; }
      // Silence is reported from the same existing provider-state evidence the
      // tick already read. It never adds a target, a send or a durable state.
      const silentTurn = 'silentTurn' in stall ? stall.silentTurn : undefined;
      if (silentTurn && (!oldestSilence || silentTurn.elapsedMs > oldestSilence.elapsedMs)) {
        oldestSilence = { taskId: task.taskId, ...silentTurn };
      }
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
    this.projectedSilence = oldestSilence;
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
    // Elapsed is recomputed from the recorded observation instant so a read
    // between ticks cannot report a stale "still working" duration.
    const silenceSinceMs = this.projectedSilence ? Date.parse(this.projectedSilence.observedSince) : Number.NaN;
    const silence = this.projectedSilence && Number.isFinite(silenceSinceMs)
      ? { ...this.projectedSilence, elapsedMs: Math.max(0, nowMs - silenceSinceMs) }
      : undefined;
    return {
      enabled: true, running: Boolean(this.timer) && !this.closed, observedAt: new Date(nowMs).toISOString(),
      ...(isoTime(this.lastTickStartedAtMs) ? { lastTickStartedAt: isoTime(this.lastTickStartedAtMs) } : {}),
      ...(isoTime(this.lastTickCompletedAtMs) ? { lastTickCompletedAt: isoTime(this.lastTickCompletedAtMs) } : {}),
      ...(isoTime(this.lastCommandAttemptAtMs) ? { lastCommandAttemptAt: isoTime(this.lastCommandAttemptAtMs) } : {}),
      ...(this.nextRunAtMs > 0 ? { nextAttemptAt: new Date(this.nextRunAtMs).toISOString() } : {}),
      transportFailureStreak: this.transportFailureStreak,
      providerBackpressureMs: chatgptProviderBackpressureRemainingMs(this.deps.providerScopeKey, nowMs), stalled,
      ...(dueCommand ? { dueCommand } : {}),
      ...(silence ? { awaitingReceiptSilence: silence } : {}),
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
    this.observedAssistant.clear(); this.providerFailureSeen.clear(); this.providerFailureAwaitingClear.clear(); this.freshSendCheckedAt.clear(); this.taskTransportFailures.clear(); this.projectedTaskStalls.clear(); this.awaitingReceiptObservedAtMs.clear(); this.idleResourceSinceMs.clear();
  }

  async runOnce(): Promise<void> {
    if (this.closed) return;
    this.lastTickStartedAtMs = this.deps.nowMs();
    // Preserve fresh-send fairness across ticks. serviceFreshSend prunes
    // retired effect ids; resetting here repeatedly favors the first task.
    this.lastRunTransportUnavailable = false;
    // One Supervisor terminal-event authority. A Work closed while this
    // consumer was offline cannot keep delivering a stale effect on restart.
    this.control.reconcileTerminalWorkBoundTasks();
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
      // Partial cross-browser discovery is degraded evidence, but must not
      // throttle an independently healthy provider's exact-target delivery.
      this.lastRunTransportUnavailable = inventory.providerInventoryReady !== true;
      this.noteFailure('WORKFLOW_SUPERVISOR_NATIVE_INVENTORY_INCOMPLETE');
    } else if (inventory.complete) {
      this.clearTransportFailure();
    }
    // Retire only disposable provider attachments. The durable Supervisor
    // effect ledger (not textual DONE or a browser tab) proves protection: a
    // queued/reconciling command and an applied turn awaiting its receipt both
    // remain attached even during cooldown. A terminal task is absent here.
    const taskResourceKeys = new Set<string>();
    const protectedResourceKeys = new Set<string>();
    for (const task of this.control.listTasks(true)) {
      const key = task.conversationId.startsWith('bootstrap:')
        ? `chatgpt.bootstrap:${task.taskId}`
        : `chatgpt.conversation:${task.conversationId}`;
      taskResourceKeys.add(key);
      // Eligibility is time-dependent; an unresolved effect still owns its
      // exact attachment during retry spacing or a blocked preparation.
      if (this.control.store.currentUnappliedEffect(task.taskId)
        || this.control.store.hasAppliedEffectAwaitingCompletion(task.taskId)) protectedResourceKeys.add(key);
    }
    for (const key of this.idleResourceSinceMs.keys()) {
      if (!taskResourceKeys.has(key) || protectedResourceKeys.has(key)) this.idleResourceSinceMs.delete(key);
    }
    const now = this.deps.nowMs();
    for (const key of taskResourceKeys) {
      if (!protectedResourceKeys.has(key) && !this.idleResourceSinceMs.has(key)) this.idleResourceSinceMs.set(key, now);
    }
    // Enforce a bounded idle attachment budget. This does not cap truly active
    // effects: they cannot be retired merely because tab pressure is high.
    const graceKeys = [...this.idleResourceSinceMs.entries()]
      .filter(([key, since]) => taskResourceKeys.has(key) && now - since < SUPERVISOR_IDLE_TAB_GRACE_MS)
      .sort((left, right) => right[1] - left[1])
      .slice(0, SUPERVISOR_IDLE_TAB_RETAIN_LIMIT)
      .map(([key]) => key);
    const activeResourceKeys = [...new Set([...protectedResourceKeys, ...graceKeys])];
    await this.deps.targetPort.cleanup(activeResourceKeys).catch((error) => this.deps.onError(error));
    for (const task of tasks) {
      if (this.closed) break;
      await this.serviceFreshSend();
      // A fresh send can atomically migrate this task; the inventory snapshot
      // from the beginning of the tick must not poll or send its retired chat.
      if (this.control.getTask(task.taskId)?.conversationId !== task.conversationId) continue;
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
    // Derived from the durable effect log, not this adapter's process memory.
    const stall = this.control.taskStall(task.taskId);
    if (stall.state === 'spaced' && stall.reason === 'pre_send_infrastructure_blocked') {
      // A blocked new recovery cannot authorize a Send, but it must not hide
      // the completed final reply of its already-applied source effect.
      // Probe read-only at the existing bounded receipt cadence.
      if (!this.control.store.hasAppliedEffectAwaitingCompletion(task.taskId)) return;
      const checkedAt = this.awaitingReceiptObservedAtMs.get(task.taskId) ?? 0;
      if (this.deps.nowMs() - checkedAt < AWAITING_RECEIPT_OBSERVATION_MS) return;
      this.awaitingReceiptObservedAtMs.set(task.taskId, this.deps.nowMs());
    }
    if (transportFailure
      && transportFailure.code !== 'WORKFLOW_SUPERVISOR_NATIVE_INVENTORY_INCOMPLETE'
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
    // Prefer the exact pinned tab. When it is truly absent, a recorded exact
    // conversation URL may be reopened for READ-ONLY applied-turn observation;
    // this does not authorize another Send or spend a dispatch generation.
    // An unknown effect remains unknown until its own marker is verified.
    const ensured = await this.deps.targetPort.ensureExact(identityForTask(task), {
      createIfMissing: poll.command?.mode === 'send'
        || this.control.store.hasAppliedEffectAwaitingCompletion(task.taskId),
    });
    if (ensured.state !== 'ready') {
      if (ensured.observation && this.handleVerifiedTerminalCapacity(task, poll.command?.effectId, ensured.observation)) return;
      const verifiedEmpty = ensured.failure.code === 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE'
        && ensured.observation !== undefined
        && !this.taskConversationContentAvailable(task, ensured.observation);
      if (verifiedEmpty) {
        this.observeVerifiedEmptyShell(task, poll.command?.effectId, poll.command, ensured.observation!);
      } else {
        // An unverified URL, a heartbeat or a generic typed transport failure
        // never accumulates the durable early-rotation evidence.
        this.noteTargetUnavailable(task, poll.command?.effectId, {
          ...ensured.failure,
          code: ensured.failure.code === 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE'
            ? 'WORKFLOW_SUPERVISOR_EMPTY_SHELL_IDENTITY_UNPROVEN'
            : ensured.failure.code,
        });
      }
      return;
    }
    const target = ensured.target;
    const snapshot = ensured.observation ?? await target.observe({ includeUserHistory: false, includePageText: false });
    if (!exactConversation(snapshot, task)) { this.noteTargetUnavailable(task, poll.command?.effectId, { code: 'WORKFLOW_SUPERVISOR_EXACT_CONVERSATION_UNPROVEN' }); return; }
    if (this.handleVerifiedTerminalCapacity(task, poll.command?.effectId, snapshot)) return;
    if (!this.taskConversationContentAvailable(task, snapshot)) {
      this.observeVerifiedEmptyShell(task, poll.command?.effectId, poll.command, snapshot);
      return;
    }
    // Do not clear a pre-send failure merely because a conversation loaded:
    // only a successful provider preparation proves the obstacle is gone.
    if (transportFailure?.code !== SUPERVISOR_PRE_SEND_BLOCKED) this.clearTaskFailure(task.taskId, poll.command?.effectId);
    this.conversations.push({ conversation_id: task.conversationId, canonical_url: task.conversationUrl,
      ...(snapshot.title.trim() ? { title: snapshot.title.trim().slice(0, 512) } : {}), ...projectMetadataFromConversationUrl(snapshot.url) });
    const providerBusy = snapshot.isGenerating;
    const latestRoleStillUser = snapshot.latestTurnRole === 'user';
    // Capacity is only authoritative on dedicated live provider UI. A model
    // can quote the same phrase in an ordinary assistant turn; historical
    // transcript text must never trigger automatic conversation migration.
    const liveFailure = chatgptProviderPageFailure(snapshot.providerFailureText);
    const turnFailure = chatgptProviderPageFailure(snapshot.providerActivityText);
    const observedProviderFailureCode = liveFailure
      ?? (turnFailure === CHATGPT_AUTOMATION_CONVERSATION_LIMIT_REACHED ? undefined : turnFailure);
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
    let missingReceiptForAppliedTurn = false;
    // A queued, never-dispatched recovery still leaves its source reply eligible
    // for completion. Consume that reply before preparing an unnecessary Send.
    const unsentRecovery = poll.command?.mode === 'send'
      && poll.command.kind === 'recovery' && poll.command.dispatchGeneration === 1;
    if ((!poll.command || unsentRecovery) && !providerBusy && snapshot.latestTurnRole === 'assistant' && snapshot.latestAssistantResponse.trim()) {
      const pending = this.control.taskStall(task.taskId);
      const sourceEffect = this.control.store.latestAppliedEffectWithoutCompletion(task.taskId)
        ?? this.control.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
      // Receipt validation depends on the applied source as well as the text.
      // A stable invalid receipt must not be reparsed on every browser poll;
      // a different exact effect still gets an independent validation.
      const responseFingerprint = sha256(JSON.stringify({
        effectId: sourceEffect?.effectId ?? ('effectId' in pending ? pending.effectId : null),
        text: snapshot.latestAssistantResponse,
      }));
      const observed = this.observedAssistant.get(task.conversationId);
      // A different queued/unknown effect still owns delivery; an older applied
      // marker cannot authorize a recovery alongside that unresolved mutation.
      const exactAppliedTurn = Boolean(sourceEffect && 'effectId' in pending && pending.effectId === sourceEffect.effectId
        && targetMarkerPresent(snapshot.latestUserText, sourceEffect.effectId));
      // Text-only replies are not receipts. Observe their stable idle digest,
      // but avoid generating an identical parser error on every browser tick.
      missingReceiptForAppliedTurn = exactAppliedTurn && (!hasCommittedSupervisorEnvelope(snapshot.latestAssistantResponse)
        || (observed?.fingerprint === responseFingerprint && observed.receiptRejected));
      if (!missingReceiptForAppliedTurn && observed?.fingerprint !== responseFingerprint) {
        try {
          await this.control.browserObserveAssistant({ conversationId: task.conversationId, conversationUrl: task.conversationUrl, responseText: snapshot.latestAssistantResponse });
          this.observedAssistant.set(task.conversationId, { fingerprint: responseFingerprint, receiptRejected: false });
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('WORKFLOW_SUPERVISOR_')) {
            // Rejected response syntax/identity proves a missing valid receipt.
            // Storage failures and valid DONE contract rejection are distinct.
            let receiptRejected = message.startsWith('WORKFLOW_SUPERVISOR_RESPONSE_')
              || message === 'WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED';
            const receiptTask = this.control.getTask(task.taskId);
            if (!receiptRejected && sourceEffect && receiptTask) {
              try { parseSupervisorCompletion(snapshot.latestAssistantResponse, { task: receiptTask, effectId: sourceEffect.effectId, prompt: sourceEffect.prompt }); }
              catch { receiptRejected = true; }
            }
            this.observedAssistant.set(task.conversationId, { fingerprint: responseFingerprint, receiptRejected });
            missingReceiptForAppliedTurn = exactAppliedTurn && receiptRejected;
          }
          if (!message.includes('WORKFLOW_SUPERVISOR_TASK_TERMINAL')) this.deps.onError(error);
        }
      }
      poll = this.control.browserPoll({ conversationId: task.conversationId, conversationUrl: task.conversationUrl });
      if (poll.terminal) return;
    }
    // An exact applied user turn can stop without rendering any assistant
    // message. Only an idle provider and no unresolved successor permit the
    // existing stable-digest grace to recover it; this never replays its Send.
    if (!providerBusy && !poll.command && latestRoleStillUser
      && !this.control.store.currentUnappliedEffect(task.taskId)) {
      const source = this.control.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
      missingReceiptForAppliedTurn = Boolean(source && targetMarkerPresent(snapshot.latestUserText, source.effectId));
    }
    // A queued continuation must not hide a visible failure from the preceding
    // provider turn. Observe the error first so the existing bounded recovery
    // chain owns it instead of repeatedly attempting the queued send.
    if (!poll.command || providerFailureCode) {
      this.control.browserObserveProviderTurn({ conversationId: task.conversationId, conversationUrl: task.conversationUrl,
        generating: providerFailureCode ? false : providerBusy, latestAssistantResponse: snapshot.latestAssistantResponse,
        providerActivityText: snapshot.providerActivityText, receiptMissing: missingReceiptForAppliedTurn, providerFailureCode: providerFailureCode === CHATGPT_AUTOMATION_RATE_LIMITED ? undefined : providerFailureCode,
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
    // Bootstrap must originate on the Project/new-composer surface. A retained
    // provider tab can silently reopen the exhausted /c/<id>; sending there
    // burns a fresh effect and can make the migration bind its old source.
    // Reject before beginning an external effect, release the stale target and
    // retain the same unspent enrollment for a later exact-target attempt.
    const beforeSend = opened.observation ?? await target.observe({ includeUserHistory: false, includePageText: false });
    let preexistingConversation = false;
    try { parseChatgptConversationIdentity(beforeSend.url); preexistingConversation = true; }
    catch { /* A Project page without a conversation id is the expected entry. */ }
    if (preexistingConversation) {
      await this.deps.targetPort.release(target.targetId).catch(() => undefined);
      this.noteTargetUnavailable(task, command.effectId, {
        code: 'WORKFLOW_SUPERVISOR_BOOTSTRAP_EXISTING_CONVERSATION',
      });
      return;
    }
    if (preflightComposerObservation(beforeSend, command.effectId).classification === 'unattributed'
      && beforeSend.composerReplacementContract !== 'exact-backed-up-project-draft-v1') {
      // Not a draft conflict or a Send attempt: Chrome retained a stale content script.
      this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId,
        reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_LOADED_SCRIPT_STALE',
        composerObservation: preflightComposerObservation(beforeSend, command.effectId) });
      this.noteTaskFailure(SUPERVISOR_PRE_SEND_BLOCKED, task, command.effectId);
      return;
    }
    let prepared: Awaited<ReturnType<ComputerChatgptConversationTarget['prepare']>>;
    const exactReplacement = authorizedDraftReplacementPrompt(this.deps.providerScopeKey, task.taskId,
      command.effectId, this.control.bootstrapProjectUrl(task.taskId), beforeSend, command.prompt);
    const retiredReplacement = exactReplacement ? undefined
      : retiredBootstrapDraftReplacementPrompt(this.control, task, beforeSend, command.prompt);
    try {
      prepared = await target.prepare(exactReplacement ?? retiredReplacement ?? command.prompt);
      if (!prepared.ready && prepared.reasonCode === 'composer_not_empty'
        && !exactReplacement && !retiredReplacement) {
        // ChatGPT may hydrate an old Project draft after the initial tab-ready
        // observation. A refused prepare never clicked Send. Read the SAME
        // pinned target once more and offer a second prepare only when the
        // STOPPED effect's canonical ledger proves this exact editor safe.
        const hydrated = await target.observe({ includeUserHistory: false, includePageText: false }).catch(() => undefined);
        const verifiedRetirement = hydrated
          ? retiredBootstrapDraftReplacementPrompt(this.control, task, hydrated, command.prompt) : undefined;
        if (verifiedRetirement) prepared = await target.prepare(verifiedRetirement);
      }
    } catch (error) {
      this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId, reasonCode: consumerFailureCode(error, 'COMPUTER_PREPARE_FAILED'), composerObservation: preflightComposerObservation(beforeSend, command.effectId) });
      this.noteTaskFailure(SUPERVISOR_PRE_SEND_BLOCKED, task, command.effectId); this.deps.onError(error); return;
    }
    if (!prepared.ready) {
      if (prepared.reasonCode === 'provider_busy') {
        // A live provider turn is temporary backpressure, not a broken local
        // preflight. Keep the exact unsent effect and use task-local spacing;
        // do not consume the durable release/operator-repair allowance.
        this.noteTaskFailure('WORKFLOW_SUPERVISOR_PROVIDER_BUSY', task, command.effectId, false);
        return;
      }
      const observed = await target.observe({ includeUserHistory: false, includePageText: false }).catch(() => beforeSend);
      if (prepared.reasonCode === 'composer_not_empty') {
        // Snapshot backups require an exact, separately authorized fingerprint.
        backupAuthorizedBlockedComposer(this.deps.providerScopeKey, task.taskId, command.effectId,
          this.control.bootstrapProjectUrl(task.taskId), observed);
      }
      this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId, reasonCode: prepared.reasonCode, composerObservation: preflightComposerObservation(observed, command.effectId) });
      this.noteTaskFailure(SUPERVISOR_PRE_SEND_BLOCKED, task, command.effectId);
      this.deps.onError(new Error(prepared.reasonCode));
      return;
    }
    this.clearTaskFailure(task.taskId, command.effectId);
    if (!this.control.bootstrapBeginEffect({ taskId: task.taskId, effectId: command.effectId, dispatchId: `bootstrap-${randomUUID()}`, dispatchGeneration: command.dispatchGeneration })) return;
    try {
      const dispatch = await withChatgptProviderDispatchLane(this.deps.providerScopeKey, () => target.dispatch(command.prompt),
        (result) => result.mutation === 'attempted' ? { providerAccepted: result.confirmed === true } : { code: result.reasonCode, message: result.reasonCode });
      if (dispatch.mutation === 'not_attempted') {
        this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-${randomUUID()}`, outcome: 'not_applied', evidence: { dispatch_mutation: 'not_attempted', send_clicked: false, reason: dispatch.reasonCode } });
        this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId,
          reasonCode: dispatch.reasonCode ?? 'COMPUTER_CHATGPT_DISPATCH_NOT_ATTEMPTED', composerObservation: preflightComposerObservation(beforeSend, command.effectId) });
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
    // Marker recovery may already return a Computer target with this exact
    // conversation identity. Promoting it again would tombstone its own binding.
    // Only a still-bootstrap target needs the provider's identity transition.
    if (match.target.identity.namespace === 'chatgpt.conversation') {
      if (match.target.identity.conversationId !== identity.conversationId) {
        observeUnknown('bootstrap_reconcile_target_identity_mismatch'); return;
      }
    } else {
      const promoted = await this.deps.targetPort.promoteBootstrap(match.target.targetId, { namespace: 'chatgpt.conversation', conversationId: identity.conversationId, canonicalUrl: identity.canonicalUrl });
      if (promoted.state !== 'ready') { observeUnknown(promoted.failure.code); return; }
    }
    this.control.bindBootstrapConversation({ taskId: task.taskId, conversationId: identity.conversationId, conversationUrl: identity.canonicalUrl });
    this.control.bootstrapObserveEffect({ taskId: task.taskId, effectId: command.effectId, observationId: `bootstrap-reconcile-${randomUUID()}`, outcome: 'applied' });
    this.clearTaskFailure(task.taskId, command.effectId);
  }

  private async executeCommand(target: ComputerChatgptConversationTarget, command: WorkflowSupervisorBrowserCommand, task: WorkflowSupervisorBrowserTask): Promise<void> {
    let snapshot = await target.observe({ includeUserHistory: true, includePageText: true });
    if (!exactConversation(snapshot, task)) {
      this.noteTargetUnavailable(task, command.effectId, { code: 'WORKFLOW_SUPERVISOR_EXACT_CONVERSATION_UNPROVEN' });
      return;
    }
    if (!this.taskConversationContentAvailable(task, snapshot)) {
      this.observeVerifiedEmptyShell(task, command.effectId, command, snapshot);
      return;
    }
    if (command.mode === 'send' && snapshot.isGenerating && command.kind !== 'recovery') return;
    let mode = command.mode;
    if (mode === 'send') {
      let prepared: Awaited<ReturnType<ComputerChatgptConversationTarget['prepare']>>;
      try { prepared = await target.prepare(command.prompt, {
        ...(command.kind === 'recovery' ? { mode: 'recover' as const } : {}),
      }); }
      catch (error) {
      this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId, reasonCode: consumerFailureCode(error, 'COMPUTER_PREPARE_FAILED') });
      this.noteTaskFailure(SUPERVISOR_PRE_SEND_BLOCKED, task, command.effectId); this.deps.onError(error); return;
    }
      if (!prepared.ready) {
        // The exact recovery target still exposes its Stop control. That is a
        // provider-turn observation, not an infrastructure preparation failure:
        // preserve this one reserved recovery effect without spending a send
        // generation or the bounded preflight-failure budget.
        if (command.kind === 'recovery' && prepared.reasonCode === 'provider_recovery_stop_pending') return;
        if (prepared.reasonCode === 'provider_busy') {
          // A live or uncompleted provider turn is a read-only wait condition.
          // No Send was attempted; do not exhaust the release-fenced repair
          // budget and strand an otherwise intact Supervisor enrollment.
          this.noteTaskFailure('WORKFLOW_SUPERVISOR_PROVIDER_BUSY', task, command.effectId, false);
          return;
        }
        this.control.recordProviderPreparationFailure({ taskId: task.taskId, effectId: command.effectId, reasonCode: prepared.reasonCode });
        this.noteTaskFailure(SUPERVISOR_PRE_SEND_BLOCKED, task, command.effectId);
        this.deps.onError(new Error(prepared.reasonCode));
        return;
      }
      // Preparing the composer yields to the provider UI. The conversation
      // may have lost its hydrated history while that preparation was in
      // progress. Re-attest the exact target before spending a dispatch
      // generation or permitting Send, and use this fresh causal baseline.
      // Keep full user-message history for the existing reconcile fallback if
      // the dispatch generation is refused by a concurrent journal update.
      snapshot = await target.observe({ includeUserHistory: true, includePageText: false });
      if (!exactConversation(snapshot, task)) {
        this.noteTargetUnavailable(task, command.effectId, { code: 'WORKFLOW_SUPERVISOR_EXACT_CONVERSATION_UNPROVEN' });
        return;
      }
      if (!this.taskConversationContentAvailable(task, snapshot)) {
        this.observeVerifiedEmptyShell(task, command.effectId, command, snapshot);
        return;
      }
      if (command.kind !== 'recovery' && snapshot.isGenerating) return;
      this.clearTaskFailure(task.taskId, command.effectId);
      const begin = this.control.browserBeginEffect({ conversationId: command.conversationId, conversationUrl: command.conversationUrl, effectId: command.effectId,
        dispatchId: `computer-${randomUUID()}`, dispatchGeneration: command.dispatchGeneration,
        evidence: { surface: 'computer-chatgpt-target', target_id: target.targetId, latest_user_text: snapshot.latestUserText, latest_assistant_response: snapshot.latestAssistantResponse } });
      if (!begin.started) mode = 'reconcile';
    }
    if (mode === 'reconcile') {
      const exact = normalize(snapshot.latestUserText) === normalize(command.prompt.replace(/^@forge\s+(?=<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>)/, ''));
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
      dispatch = await withChatgptProviderDispatchLane(this.deps.providerScopeKey, () => target.dispatch(command.prompt, { ...(command.kind === 'recovery' ? { mode: 'recover' as const } : {}) }),
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
      exact = normalize(snapshot.latestUserText) === normalize(command.prompt.replace(/^@forge\s+(?=<<<FORGE_WORKFLOW_EFFECT_V1:(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}>>>)/, '')); markerPresent = snapshotTargetMarkerPresent(snapshot, command.effectId);
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
