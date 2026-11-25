import type { StructuredModelDecisionRequestV1 } from '../../../packages/kernel/models';

export type StructuredDecisionFailure =
  | 'unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response'
  | 'provider_error';

export interface StructuredDecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costMicros?: number;
}

export type StructuredDecisionProviderResult =
  | { ok: true; output: unknown; usage?: StructuredDecisionUsage }
  | { ok: false; failure: StructuredDecisionFailure; message: string; retryAfterMs?: number };

export interface StructuredDecisionProviderAdapter {
  readonly providerId: string;
  readonly protocols: ReadonlyArray<'chat_completions' | 'responses'>;
  execute(request: StructuredModelDecisionRequestV1, signal: AbortSignal): Promise<StructuredDecisionProviderResult>;
}

export interface StructuredDecisionExecutionReceipt {
  schemaVersion: 1;
  requestId: string;
  providerId: string;
  modelId: string;
  profileId: string;
  result: StructuredDecisionProviderResult;
  safety: {
    toolCalling: false;
    actionExecution: false;
    authorizationOwner: 'forge';
  };
}

function validateRequestBoundary(request: StructuredModelDecisionRequestV1): void {
  if (request.schemaVersion !== 1 || !request.requestId || !request.model?.profileId || !request.model.providerId)
    throw new Error('STRUCTURED_DECISION_REQUEST_INVALID');
  if (
    request.safety.toolCalling !== false ||
    request.safety.actionExecution !== false ||
    request.safety.rawPayloadIncluded !== false ||
    request.safety.authorizationOwner !== 'forge'
  )
    throw new Error('STRUCTURED_DECISION_SAFETY_BOUNDARY_INVALID');
  if (request.budget.timeoutMs < 100 || request.budget.timeoutMs > 120_000)
    throw new Error('STRUCTURED_DECISION_TIMEOUT_INVALID');
}

function timeoutResult(): StructuredDecisionProviderResult {
  return { ok: false, failure: 'timeout', message: 'Structured decision provider timed out.' };
}

/**
 * Provider-neutral one-shot model execution. The adapter receives no Forge
 * tools and cannot authorize or execute the Action proposed by its output.
 */
export async function executeStructuredDecision(
  request: StructuredModelDecisionRequestV1,
  adapter: StructuredDecisionProviderAdapter,
  parentSignal?: AbortSignal,
): Promise<StructuredDecisionExecutionReceipt> {
  validateRequestBoundary(request);
  if (adapter.providerId !== request.model.providerId) throw new Error('STRUCTURED_DECISION_PROVIDER_MISMATCH');
  if (!adapter.protocols.includes(request.model.protocol)) throw new Error('STRUCTURED_DECISION_PROTOCOL_UNSUPPORTED');

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('STRUCTURED_DECISION_TIMEOUT'));
  }, request.budget.timeoutMs);

  let result: StructuredDecisionProviderResult;
  try {
    result = await adapter.execute(request, controller.signal);
  } catch (error) {
    if (timedOut) result = timeoutResult();
    else if (controller.signal.aborted) {
      result = { ok: false, failure: 'unavailable', message: 'Structured decision execution aborted.' };
    } else {
      result = {
        ok: false,
        failure: 'provider_error',
        message: error instanceof Error ? error.message.slice(0, 500) : 'Structured decision provider failed.',
      };
    }
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }

  return {
    schemaVersion: 1,
    requestId: request.requestId,
    providerId: request.model.providerId,
    modelId: request.model.modelId,
    profileId: request.model.profileId,
    result,
    safety: { toolCalling: false, actionExecution: false, authorizationOwner: 'forge' },
  };
}
