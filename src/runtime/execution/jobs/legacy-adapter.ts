import type { LocalBridgeJob } from '../../../cli/local-bridge/types';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS } from '../../../cli/controller/runtime-config';

const LEGACY_SETTLEMENT_GRACE_MS = 30_000;
const MAX_DURABLE_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;
/** Historical Agent-delegation records used a short parent acceptance deadline. */
const AGENT_DELEGATION_PARENT_TIMEOUT_MS = 120_000;

/**
 * Read-only compatibility helper for historical Local Bridge records.
 * New Local Bridge dispatch is retired and must not create an ExecutionJob.
 */
export function legacySettlementTimeoutMs(job: LocalBridgeJob): number {
  if (job.action === 'launch-task' || job.action === 'quick-agent-session') {
    return AGENT_DELEGATION_PARENT_TIMEOUT_MS;
  }
  const payload = job.payload as { timeoutMs?: unknown };
  const requested = typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
    ? Math.max(1_000, Math.min(payload.timeoutMs, MAX_AGENT_TIMEOUT_MS))
    : DEFAULT_AGENT_TIMEOUT_MS;
  return Math.min(requested + LEGACY_SETTLEMENT_GRACE_MS, MAX_DURABLE_EXECUTION_TIMEOUT_MS);
}
