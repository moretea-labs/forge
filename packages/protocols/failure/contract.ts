export const FAILURE_CLASSES = [
  'controller_unavailable',
  'connector_stale',
  'infrastructure_failure',
  'acceptance_failure',
  'invalid_check_id',
  'approval_required',
  'handoff_required',
  'timeout',
  'policy_denied',
  'not_found',
  'unknown_failure',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type FailureRetryDisposition = 'never' | 'transient' | 'after_user_action' | 'reconcile_before_retry';
export type FailureCodeProvenance = 'typed_code' | 'legacy_code_prefix' | 'fallback';

export interface FailureDescriptor {
  schemaVersion: 1;
  code: string;
  class: FailureClass;
  retryDisposition: FailureRetryDisposition;
  message: string;
  provenance: FailureCodeProvenance;
  httpStatus?: number;
}

export interface DescribeFailureOptions {
  fallbackCode?: string;
  fallbackHttpStatus?: number;
  retryable?: boolean;
}

const FAILURE_CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,127}$/;
const TRANSIENT_FAILURE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function text(value: unknown): string {
  return value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? '');
}

function typedFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  const normalized = code.trim().toUpperCase();
  return FAILURE_CODE_TOKEN.test(normalized) ? normalized : undefined;
}

function legacyFailureCodePrefix(message: string): string | undefined {
  const match = /^([A-Z][A-Z0-9_]{1,127})(?::|\s|$)/.exec(message.trim());
  return match && FAILURE_CODE_TOKEN.test(match[1]!) ? match[1] : undefined;
}

export function failureCodeFromUnknown(
  error: unknown,
  fallbackCode = 'UNKNOWN_FAILURE',
): { code: string; provenance: FailureCodeProvenance } {
  const typed = typedFailureCode(error);
  if (typed) return { code: typed, provenance: 'typed_code' };
  const legacy = legacyFailureCodePrefix(text(error));
  if (legacy) return { code: legacy, provenance: 'legacy_code_prefix' };
  const fallback = fallbackCode.trim().toUpperCase();
  return {
    code: FAILURE_CODE_TOKEN.test(fallback) ? fallback : 'UNKNOWN_FAILURE',
    provenance: 'fallback',
  };
}

export function classifyFailureCode(rawCode: unknown): FailureClass {
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (!FAILURE_CODE_TOKEN.test(code)) return 'unknown_failure';
  if (code.includes('ACCEPTANCE') || code.includes('VALID_FAIL') || code.includes('CHECK_FAILED')) return 'acceptance_failure';
  if (code.includes('INVALID_CHECK') || code.includes('CHECK_ID_INVALID') || code.includes('CHECK_NOT_FOUND')) return 'invalid_check_id';
  if (code.includes('APPROVAL_REQUIRED') || code.includes('AUTHORIZATION_REQUIRED') || code.includes('WAITING_FOR_APPROVAL')) return 'approval_required';
  if (code.includes('HANDOFF') || code.includes('NEEDS_REVIEW') || code.includes('HUMAN_ATTENTION')) return 'handoff_required';
  if (code.includes('TIMED_OUT') || code.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout';
  if (code.includes('CONNECTOR_STALE') || code.includes('CLIENT_SCHEMA_STALE') || code.includes('TOOL_SURFACE_STALE')) return 'connector_stale';
  if (code.includes('CONTROLLER_UNAVAILABLE') || code.includes('RUNTIME_NOT_READY') || code === 'ECONNREFUSED') return 'controller_unavailable';
  if (code.includes('SCOPE_DENIED') || code.includes('POLICY_DENIED') || code.includes('FORBIDDEN') || code.includes('NOT_ALLOWED')) return 'policy_denied';
  if (code.includes('INFRASTRUCTURE') || code.includes('RUNTIME_STORAGE') || code.includes('WORKER_') || code.includes('SPAWN_') || code === 'ENOENT') return 'infrastructure_failure';
  if (code.includes('NOT_FOUND')) return 'not_found';
  return 'unknown_failure';
}

/**
 * Compatibility-only presentation classifier for failures whose producer has
 * not yet emitted a machine-readable code. Retry, authorization, placement,
 * and persistence decisions must never call this function.
 */
export function classifyLegacyFailureMessage(rawMessage: unknown): FailureClass {
  const message = typeof rawMessage === 'string' ? rawMessage.trim().toLowerCase() : '';
  if (!message) return 'unknown_failure';
  if (message.includes('acceptance') || message.includes('valid_fail') || message.includes('check failed') || message.includes('] failed') || (message.includes('expected ') && message.includes(' got '))) return 'acceptance_failure';
  if ((message.includes('check not found') || message.includes('check_id')) && (message.includes('invalid') || message.includes('not found') || message.includes('not registered'))) return 'invalid_check_id';
  if (message.includes('approval required') || message.includes('requires approval') || message.includes('awaiting approval') || message.includes('authorization required') || message.includes('confirm authorization')) return 'approval_required';
  if (message.includes('handoff') || message.includes('needs_review') || message.includes('human_attention')) return 'handoff_required';
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('stale connector') || message.includes('tool surface') || message.includes('fingerprint') || message.includes('reconnect')) return 'connector_stale';
  if (message.includes('daemon') || message.includes('controller unavailable') || message.includes('not ready') || message.includes('econnrefused')) return 'controller_unavailable';
  if (message.includes('denied') || message.includes('policy') || message.includes('forbidden') || message.includes('not allowed')) return 'policy_denied';
  if (message.includes('infrastructure') || message.includes('runtime_storage') || message.includes('worker') || message.includes('spawn') || message.includes('enoent')) return 'infrastructure_failure';
  if (message.includes('not found') || message.includes('not_found')) return 'not_found';
  return 'unknown_failure';
}

export function retryDispositionForFailureCode(
  rawCode: unknown,
  explicitRetryable?: boolean,
): FailureRetryDisposition {
  if (explicitRetryable === true) return 'transient';
  if (explicitRetryable === false) return 'never';
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (code.includes('OUTCOME_UNKNOWN')) return 'reconcile_before_retry';
  return TRANSIENT_FAILURE_CODES.has(code) ? 'transient' : 'never';
}

export function httpStatusForFailureCode(rawCode: unknown, fallback = 400): number {
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (code.includes('RATE_LIMITED')) return 429;
  if (code.includes('SCOPE_DENIED') || code.includes('POLICY_DENIED') || code.includes('FORBIDDEN')) return 403;
  if (/^MOBILE_INTENT_(?:TOKEN|SIGNATURE|REPLAY|TIMESTAMP|NONCE|DEVICE)_/.test(code)) return 401;
  if (code.includes('NOT_FOUND')) return 404;
  return fallback;
}

export function describeFailure(error: unknown, options: DescribeFailureOptions = {}): FailureDescriptor {
  const message = text(error);
  const identity = failureCodeFromUnknown(error, options.fallbackCode);
  const explicitRetryable = typeof options.retryable === 'boolean'
    ? options.retryable
    : error && typeof error === 'object' && typeof (error as { retryable?: unknown }).retryable === 'boolean'
      ? (error as { retryable: boolean }).retryable
      : undefined;
  return {
    schemaVersion: 1,
    code: identity.code,
    class: classifyFailureCode(identity.code),
    retryDisposition: retryDispositionForFailureCode(identity.code, explicitRetryable),
    message,
    provenance: identity.provenance,
    ...(options.fallbackHttpStatus !== undefined
      ? { httpStatus: httpStatusForFailureCode(identity.code, options.fallbackHttpStatus) }
      : {}),
  };
}
