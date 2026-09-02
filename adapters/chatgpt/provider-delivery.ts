import { createHash } from 'crypto';

export const DEFAULT_CHATGPT_AUTOMATION_MODEL = 'gpt-5.6';
export const DEFAULT_CHATGPT_AUTOMATION_REASONING = 'high';
export const DEFAULT_CHATGPT_AUTOMATION_TAB_POLICY = 'auto';
export const CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN = 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN';

export type ChatgptAutomationReasoning = 'medium' | 'high' | 'xhigh';
export type ChatgptAutomationTabPolicy = 'auto' | 'reuse' | 'new';
export type ChatgptAutomationTabCleanupStatus = 'closed' | 'preserved_user_owned' | 'session_closed' | 'failed';

export type ChatgptProviderFailureDisposition = 'outcome_unknown' | 'wait_for_user' | 'failed';
export type ChatgptProviderDeliveryStatus = 'dispatch_confirmed' | ChatgptProviderFailureDisposition;
export type ChatgptProviderKind = 'controller-browser' | 'chatgpt-bridge';

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
  if (normalized.includes('OUTCOME_UNKNOWN')) return 'outcome_unknown';
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

export function chatgptProviderError(error: unknown, fallbackCode: string): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && error.message.includes(':')
    ? error.message.split(':', 1)[0]
    : fallbackCode;
  return { code, message };
}
