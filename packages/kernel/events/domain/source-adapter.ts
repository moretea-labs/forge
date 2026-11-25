import type { EventEnvelopeV1 } from './event-envelope';

export interface EventSourceAdapterDescriptor {
  readonly source: string;
  readonly provider: string;
  readonly eventTypes: readonly string[];
}

export interface EventSourceAdapterContext {
  /**
   * Stable source-side receipt time. Adapters must reuse the original value
   * across delivery retries; never substitute the current retry time.
   */
  readonly receivedAt: string;
}

/**
 * Pure provider-to-envelope mapping only. Fetching, cursor ownership,
 * persistence, ACK/retry and execution remain with the existing source/runtime
 * owners and must not be implemented by an adapter.
 */
export interface EventSourceAdapter<TObservation = unknown> {
  readonly descriptor: EventSourceAdapterDescriptor;
  normalize(observation: TObservation, context: EventSourceAdapterContext): readonly EventEnvelopeV1[];
}
