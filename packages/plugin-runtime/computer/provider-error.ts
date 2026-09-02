export interface ComputerProviderErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class ComputerProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly detailMessage: string;

  constructor(code: string, message: string, options: ComputerProviderErrorOptions = {}) {
    const boundedMessage = message.slice(0, 1_000);
    super(`${code}: ${boundedMessage}`);
    this.name = 'ComputerProviderError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.detailMessage = boundedMessage;
  }
}
