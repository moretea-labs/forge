import { createHash } from 'crypto';

export const DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6';
export const DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high';
export const DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY = 'auto';
export const CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN = 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN';
export const CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT = 'CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT';
export const CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE = 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE';
export const CHATGPT_AUTOMATION_RATE_LIMITED = 'CHATGPT_AUTOMATION_RATE_LIMITED';
export const CHATGPT_AUTOMATION_RATE_LIMITED_AFTER_SUBMIT = 'CHATGPT_AUTOMATION_RATE_LIMITED_AFTER_SUBMIT';

export type ChatgptProviderPageFailureCode =
  | typeof CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT
  | typeof CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE
  | typeof CHATGPT_AUTOMATION_RATE_LIMITED;

function normalizeChatgptProviderPageText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Shared provider-page failure detection used by both direct delivery and durable Supervisor observation. */
export function chatgptProviderPageFailure(
  bodyText: string | undefined,
): ChatgptProviderPageFailureCode | undefined {
  const normalized = normalizeChatgptProviderPageText(bodyText ?? '');
  if (
    normalized.includes('resume stream unavailable')
    || normalized.includes('tokenless_resume_unavailable')
    || normalized.includes('stream recovery polling timed out')
    || normalized.includes('连接已中断，正在等待完整答复')
    || normalized.includes('connection interrupted, waiting for the full response')
    // A standalone current status is termination evidence. The same words in
    // ordinary chat prose or a historical whole-page transcript are not.
    || /^(?:已分析\s+)?(?:分析已暂停|analysis paused)(?:\s+(?:分析已暂停|analysis paused))*$/.test(normalized)
  ) {
    return CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE;
  }
  if (
    normalized.includes('too many requests')
    || normalized.includes('rate limit exceeded')
    || (normalized.includes('http 429') && normalized.includes('rate limit'))
  ) {
    return CHATGPT_AUTOMATION_RATE_LIMITED;
  }
  return ((normalized.includes('message delivery timed out') && normalized.includes('please try again'))
    || (normalized.includes('消息传输超时') && normalized.includes('请重试')))
    ? CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT
    : undefined;
}

export type ChatgptAutomationReasoning = 'medium' | 'high' | 'xhigh';
export type ChatgptAutomationTabPolicy = 'auto' | 'reuse' | 'new';
export type ChatgptAutomationTabCleanupStatus = 'closed' | 'preserved_user_owned' | 'session_closed' | 'failed';

export type ChatgptProviderFailureDisposition = 'outcome_unknown' | 'wait_for_user' | 'failed';
export type ChatgptProviderDeliveryStatus = 'dispatch_confirmed' | ChatgptProviderFailureDisposition;
export type ChatgptProviderKind = 'controller-browser' | 'chatgpt-bridge';

export class ChatgptProviderDeliveryError extends Error {
  readonly code: string;
  readonly conversationUrl?: string;

  constructor(code: string, message: string, options: { conversationUrl?: string } = {}) {
    super(message);
    this.name = 'ChatgptProviderDeliveryError';
    this.code = code;
    this.conversationUrl = options.conversationUrl;
  }
}

export interface ChatgptProviderErrorEvidence {
  code: string;
  message: string;
  conversationUrl?: string;
}

export interface ChatgptProviderDeliveryInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  prompt: string;
  browserSessionId: string;
  targetUrl: string;
  model: string;
  reasoning: 'medium' | 'high' | 'xhigh';
  timeoutMs?: number;
}

export interface ChatgptProviderDeliveryResult {
  status: ChatgptProviderDeliveryStatus;
  provider: ChatgptProviderKind;
  browserSessionId: string;
  conversationUrl?: string;
  executionPreferenceVerified: boolean;
  error?: { code: string; message: string };
}

/** Provider delivery owns browser/bridge mutation and confirmation, never semantic Work authority. */
export interface ChatgptProviderDeliveryHost {
  dispatch(input: ChatgptProviderDeliveryInput): Promise<ChatgptProviderDeliveryResult>;
}

interface ChatgptProviderDispatchGate {
  tail: Promise<void>;
  queued: number;
  pressureLevel: number;
  cooldownUntilMs: number;
}

const CHATGPT_PROVIDER_BACKPRESSURE_BASE_MS = 2_000;
const CHATGPT_PROVIDER_BACKPRESSURE_MAX_MS = 30_000;
const CHATGPT_PROVIDER_EXPLICIT_RETRY_MAX_MS = 120_000;
const chatgptProviderDispatchGates = new Map<string, ChatgptProviderDispatchGate>();

function providerGateKey(controllerHome: string): string {
  return controllerHome.trim() || 'forge-controller';
}

function chatgptProviderDispatchGate(controllerHome: string): ChatgptProviderDispatchGate {
  const key = providerGateKey(controllerHome);
  let gate = chatgptProviderDispatchGates.get(key);
  if (!gate) {
    gate = { tail: Promise.resolve(), queued: 0, pressureLevel: 0, cooldownUntilMs: 0 };
    chatgptProviderDispatchGates.set(key, gate);
  }
  return gate;
}

function retryAfterDelayMs(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match = message.match(/\bretry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?)?\b/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const milliseconds = match[2]?.toLowerCase().startsWith('m') ? amount : amount * 1_000;
  return Math.max(1_000, Math.min(CHATGPT_PROVIDER_EXPLICIT_RETRY_MAX_MS, Math.round(milliseconds)));
}

/** Deterministic jitter keeps concurrent callers from reconverging on one provider boundary after cooldown. */
export function chatgptProviderBackoffDelayMs(
  pressureLevel: number,
  key = 'chatgpt',
  message?: string,
): number {
  const explicit = retryAfterDelayMs(message);
  if (explicit !== undefined) return explicit;
  const exponent = Math.max(0, Math.min(8, Math.trunc(pressureLevel) - 1));
  const base = Math.min(CHATGPT_PROVIDER_BACKPRESSURE_MAX_MS, CHATGPT_PROVIDER_BACKPRESSURE_BASE_MS * 2 ** exponent);
  const jitterByte = createHash('sha256').update(`${key}\n${pressureLevel}`).digest()[0] ?? 128;
  const jitter = 0.8 + (jitterByte / 255) * 0.4;
  return Math.max(1_000, Math.min(CHATGPT_PROVIDER_BACKPRESSURE_MAX_MS, Math.round(base * jitter)));
}

export function chatgptProviderFailureRequiresBackpressure(
  status: ChatgptProviderDeliveryStatus | undefined,
  code?: string,
  message?: string,
): boolean {
  if (status === 'outcome_unknown') return true;
  const normalized = `${code ?? ''}\n${message ?? ''}`.toUpperCase();
  return normalized.includes('RATE_LIMITED')
    || normalized.includes('TOO MANY REQUESTS')
    || normalized.includes('HTTP 429')
    || normalized.includes('TOKENLESS_RESUME_UNAVAILABLE')
    || normalized.includes('RESPONSE_STREAM_UNAVAILABLE')
    || normalized.includes('MESSAGE_DELIVERY_TIMED_OUT');
}

export function noteChatgptProviderBackpressure(
  controllerHome: string,
  message?: string,
  nowMs = Date.now(),
): number {
  const key = providerGateKey(controllerHome);
  const gate = chatgptProviderDispatchGate(controllerHome);
  gate.pressureLevel += 1;
  const delayMs = chatgptProviderBackoffDelayMs(gate.pressureLevel, key, message);
  gate.cooldownUntilMs = Math.max(gate.cooldownUntilMs, nowMs + delayMs);
  return delayMs;
}

export function chatgptProviderBackpressureRemainingMs(
  controllerHome: string,
  nowMs = Date.now(),
): number {
  const gate = chatgptProviderDispatchGates.get(providerGateKey(controllerHome));
  return gate ? Math.max(0, gate.cooldownUntilMs - nowMs) : 0;
}

export interface ChatgptProviderDispatchOutcome {
  status?: ChatgptProviderDeliveryStatus;
  code?: string;
  message?: string;
  /**
   * True only when the provider actually accepted this submission. A local
   * transport failure (foreground required, composer missing, transport
   * unavailable) is neither acceptance nor provider backpressure, so it must
   * not clear pressure that a real provider limit established.
   */
  providerAccepted?: boolean;
}

/**
 * One active Runtime owns one transient ChatGPT provider dispatch lane. This is
 * deliberately mechanical and in-memory: ControllerRound effect identity remains
 * the durable replay fence across Runtime rotation, while provider pressure must
 * not become Work/Plan lifecycle state.
 *
 * Provider rate limiting is an account-level resource, so *every* transport that
 * can submit a provider prompt through this Runtime must enter the same lane and
 * obey the same cooldown. A separate lane that only reads the cooldown still
 * submits concurrently with this one, which is exactly how one ChatGPT account
 * observes request concurrency that no single session produced.
 */
export async function withChatgptProviderDispatchLane<T>(
  controllerHome: string,
  operation: () => Promise<T>,
  outcomeOf: (result: T) => ChatgptProviderDispatchOutcome | undefined,
): Promise<T> {
  const key = providerGateKey(controllerHome);
  const gate = chatgptProviderDispatchGate(controllerHome);

  const predecessor = gate.tail;
  let release!: () => void;
  gate.tail = new Promise<void>((resolve) => { release = resolve; });
  gate.queued += 1;
  await predecessor;

  try {
    const waitMs = gate.cooldownUntilMs - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    const result = await operation();
    const outcome = outcomeOf(result);
    if (outcome && chatgptProviderFailureRequiresBackpressure(outcome.status, outcome.code, outcome.message)) {
      noteChatgptProviderBackpressure(controllerHome, outcome.message);
    } else if (outcome?.providerAccepted === true) {
      gate.pressureLevel = 0;
      gate.cooldownUntilMs = 0;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (chatgptProviderFailureRequiresBackpressure(undefined, undefined, message)) {
      noteChatgptProviderBackpressure(controllerHome, message);
    }
    throw error;
  } finally {
    gate.queued -= 1;
    release();
    if (gate.queued === 0 && gate.pressureLevel === 0 && gate.cooldownUntilMs <= Date.now()) {
      chatgptProviderDispatchGates.delete(key);
    }
  }
}

/** Controller-relay delivery: one serialized provider prompt submission lane. */
export async function dispatchWithChatgptProviderBackpressure(
  controllerHome: string,
  dispatch: () => Promise<ChatgptProviderDeliveryResult>,
): Promise<ChatgptProviderDeliveryResult> {
  return await withChatgptProviderDispatchLane(controllerHome, dispatch, (result) => (
    chatgptProviderFailureRequiresBackpressure(result.status, result.error?.code, result.error?.message)
      ? { code: result.error?.code, message: result.error?.message }
      : { providerAccepted: result.status === 'dispatch_confirmed' }
  ));
}

const CHATGPT_WAIT_FOR_USER_MARKERS = [
  'LOGIN_REQUIRED',
  'AUTH_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'USER_ACTION_REQUIRED',
  'PERMISSION_REQUIRED',
  'CONSENT_REQUIRED',
] as const;

/** Classify provider failure without turning delivery/session details into Kernel authority. */
export function classifyChatgptProviderFailure(
  code?: string,
  message?: string,
): ChatgptProviderFailureDisposition {
  const normalized = `${code ?? ''}\n${message ?? ''}`.toUpperCase();
  if (
    normalized.includes('OUTCOME_UNKNOWN')
    || normalized.includes('MESSAGE_DELIVERY_TIMED_OUT')
    || normalized.includes('RESPONSE_STREAM_UNAVAILABLE')
    || normalized.includes('RATE_LIMITED_AFTER_SUBMIT')
  ) return 'outcome_unknown';
  if (CHATGPT_WAIT_FOR_USER_MARKERS.some((marker) => normalized.includes(marker))) return 'wait_for_user';
  return 'failed';
}


export function chatgptProviderDispatchReceiptId(input: {
  repoId: string;
  workId: string;
  relayScopeId: string;
  controllerAuthorityId: string;
  provider: ChatgptProviderKind;
}): string {
  const digest = createHash('sha256').update([
    input.repoId,
    input.workId,
    input.relayScopeId,
    input.controllerAuthorityId,
    input.provider,
  ].join('\n')).digest('hex').slice(0, 32);
  return `chatgpt-dispatch:${digest}`;
}

export function chatgptProviderError(error: unknown, fallbackCode: string): ChatgptProviderErrorEvidence {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ChatgptProviderDeliveryError
    ? error.code
    : error instanceof Error && error.message.includes(':')
      ? error.message.split(':', 1)[0]
      : fallbackCode;
  return {
    code,
    message,
    ...(error instanceof ChatgptProviderDeliveryError && error.conversationUrl
      ? { conversationUrl: error.conversationUrl }
      : {}),
  };
}
