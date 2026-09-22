export type AssistantPluginEffectOutcome = 'failed' | 'outcome_unknown';

export interface AssistantPluginErrorOptions {
  retryable?: boolean;
  effectOutcome?: AssistantPluginEffectOutcome;
  details?: Record<string, unknown>;
}

export class AssistantPluginError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly effectOutcome: AssistantPluginEffectOutcome;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: AssistantPluginErrorOptions = {}) {
    super(`${code}: ${message}`);
    this.name = 'AssistantPluginError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.effectOutcome = options.effectOutcome ?? 'failed';
    this.details = options.details;
  }
}

export function isAssistantPluginError(error: unknown): error is AssistantPluginError {
  return error instanceof AssistantPluginError;
}

export function toAssistantPluginError(
  error: unknown,
  fallback: { code: string; message: string; retryable?: boolean; effectOutcome?: AssistantPluginEffectOutcome; details?: Record<string, unknown> },
): AssistantPluginError {
  if (isAssistantPluginError(error)) return error;
  if (error instanceof Error) {
    return new AssistantPluginError(fallback.code, error.message, {
      retryable: fallback.retryable,
      effectOutcome: fallback.effectOutcome,
      details: fallback.details,
    });
  }
  return new AssistantPluginError(fallback.code, fallback.message, {
    retryable: fallback.retryable,
    effectOutcome: fallback.effectOutcome,
    details: fallback.details,
  });
}
