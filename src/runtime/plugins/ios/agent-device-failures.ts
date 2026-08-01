import { AssistantPluginError, toAssistantPluginError } from '../errors';

export type AgentDeviceSessionFailureDisposition = 'preserve_session' | 'terminate_session' | 'fence_unknown';

export interface AgentDeviceFailureClassification {
  disposition: AgentDeviceSessionFailureDisposition;
  providerCode?: string;
  reason: string;
}

const PRESERVE_CODES = new Set([
  'ELEMENT_NOT_FOUND',
  'NO_SUCH_ELEMENT',
  'STALE_REF',
  'INVALID_SELECTOR',
  'INVALID_ARGS',
  'UNSUPPORTED_OPERATION',
  'WAIT_TIMEOUT',
  'ASSERTION_FAILED',
  'ELEMENT_NOT_EDITABLE',
  'ELEMENT_NOT_HITTABLE',
  'TARGET_NOT_INTERACTABLE',
  'TYPE_FAILED',
]);

const TERMINATE_CODES = new Set([
  'SESSION_NOT_FOUND',
  'RUNNER_DISCONNECTED',
  'RUNNER_NOT_READY',
  'TRANSPORT_ERROR',
  'DAEMON_UNAVAILABLE',
  'DEVICE_DISCONNECTED',
  'XCTEST_UNAVAILABLE',
]);

function detailString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}

export function classifyAgentDeviceFailure(error: unknown): AgentDeviceFailureClassification {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  const details = normalized.details && typeof normalized.details === 'object'
    ? normalized.details as Record<string, unknown>
    : {};
  const providerCode = typeof details.providerCode === 'string'
    ? details.providerCode
    : typeof details.code === 'string'
      ? details.code
      : undefined;
  if (providerCode && PRESERVE_CODES.has(providerCode)) {
    return { disposition: 'preserve_session', providerCode, reason: `provider:${providerCode}` };
  }
  if (providerCode && TERMINATE_CODES.has(providerCode)) {
    return { disposition: 'terminate_session', providerCode, reason: `provider:${providerCode}` };
  }

  const evidence = `${normalized.code}\n${normalized.message}\n${detailString(normalized.details)}`;
  if (/(?:stale\s+ref|element\s+not\s+found|no\s+such\s+element|invalid\s+selector|unsupported\s+operation|not\s+editable|not\s+hittable|not\s+interactable|cannot\s+type|failed\s+to\s+type|failed\s+to\s+fill|target\s+(?:is\s+)?covered|target\s+(?:is\s+)?disabled)/i.test(evidence)
    && !/(?:runner|transport|connection|socket|daemon|xctest|dtx|device\s+disconnect)/i.test(evidence)) {
    return { disposition: 'preserve_session', providerCode, reason: 'recoverable_semantic_failure' };
  }
  if (/(?:runner|transport|connection\s+(?:refused|lost|closed)|socket|daemon\s+unavailable|xctest|dtx|device\s+disconnect|broken\s+pipe|session\s+not\s+found)/i.test(evidence)) {
    return { disposition: 'terminate_session', providerCode, reason: 'provider_or_transport_failure' };
  }
  if (normalized.code === 'AGENT_DEVICE_COMMAND_TIMEOUT' || normalized.code === 'AGENT_DEVICE_COMMAND_CANCELLED') {
    return { disposition: 'fence_unknown', providerCode, reason: 'unknown_mutation_outcome' };
  }
  // A provider that returns a concrete failure has supplied a terminal outcome,
  // even if its error code is not yet normalized. Unknown is reserved for a
  // dispatched command whose completion evidence was lost.
  return { disposition: 'terminate_session', providerCode, reason: 'unclassified_provider_failure' };
}

export function preserveSessionFailure(error: unknown): never {
  const normalized = toAssistantPluginError(error, {
    code: 'AGENT_DEVICE_COMMAND_FAILED',
    message: 'The agent-device command failed.',
    retryable: false,
  });
  throw new AssistantPluginError(normalized.code, normalized.message, {
    retryable: normalized.retryable,
    details: {
      ...(normalized.details && typeof normalized.details === 'object' ? normalized.details as Record<string, unknown> : {}),
      sessionPreserved: true,
    },
  });
}
