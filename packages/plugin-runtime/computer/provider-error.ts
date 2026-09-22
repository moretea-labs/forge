export type ComputerProviderEffectOutcome = 'failed' | 'outcome_unknown';

export interface ComputerProviderErrorOptions {
  retryable?: boolean;
  effectOutcome?: ComputerProviderEffectOutcome;
  details?: Record<string, unknown>;
}

export class ComputerProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly effectOutcome: ComputerProviderEffectOutcome;
  readonly details?: Record<string, unknown>;
  readonly detailMessage: string;

  constructor(code: string, message: string, options: ComputerProviderErrorOptions = {}) {
    const boundedMessage = message.slice(0, 1_000);
    super(`${code}: ${boundedMessage}`);
    this.name = 'ComputerProviderError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.effectOutcome = options.effectOutcome ?? 'failed';
    this.details = options.details;
    this.detailMessage = boundedMessage;
  }
}
