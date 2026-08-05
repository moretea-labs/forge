import { createHash } from 'crypto';

export type GatewayOperationClass =
  | 'hot_read'
  | 'diagnostic'
  | 'mutation'
  | 'durable_handoff'
  | 'controller_lock';

export type GatewayLatencyPhase =
  | 'wall_clock'
  | 'queue'
  | 'lock_wait'
  | 'storage'
  | 'git_observation'
  | 'worker_process'
  | 'projection'
  | 'execution'
  | 'serialization';

export type GatewayMetricOutcome = 'success' | 'timeout' | 'contention' | 'failed' | 'queued';

export interface GatewayLatencySample {
  repositoryBucket: string;
  checkoutBucket: string;
  operationClass: GatewayOperationClass;
  phase: GatewayLatencyPhase;
  durationMs: number;
  outcome: GatewayMetricOutcome;
  observedAt: string;
}

export interface GatewayLatencySummary {
  repositoryBucket: string;
  checkoutBucket: string;
  operationClass: GatewayOperationClass;
  phase: GatewayLatencyPhase;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  timeoutRate: number;
  contentionRate: number;
}

const MAX_BUCKETS = 256;
const MAX_SAMPLES_PER_BUCKET = 512;
const samplesByKey = new Map<string, GatewayLatencySample[]>();

function bucket(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 24 * 60 * 60_000));
}

function keyOf(sample: Pick<GatewayLatencySample, 'repositoryBucket' | 'checkoutBucket' | 'operationClass' | 'phase'>): string {
  return [sample.repositoryBucket, sample.checkoutBucket, sample.operationClass, sample.phase].join(':');
}

export function recordGatewayLatency(input: {
  repoId?: string;
  checkoutId?: string;
  operationClass: GatewayOperationClass;
  phase: GatewayLatencyPhase;
  durationMs: number;
  outcome?: GatewayMetricOutcome;
  observedAt?: string;
}): GatewayLatencySample {
  const sample: GatewayLatencySample = {
    repositoryBucket: bucket(input.repoId, 'global'),
    checkoutBucket: bucket(input.checkoutId, 'none'),
    operationClass: input.operationClass,
    phase: input.phase,
    durationMs: boundedDuration(input.durationMs),
    outcome: input.outcome ?? 'success',
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
  const key = keyOf(sample);
  if (!samplesByKey.has(key) && samplesByKey.size >= MAX_BUCKETS) {
    const oldest = samplesByKey.keys().next().value as string | undefined;
    if (oldest) samplesByKey.delete(oldest);
  }
  const current = samplesByKey.get(key) ?? [];
  current.push(sample);
  if (current.length > MAX_SAMPLES_PER_BUCKET) current.splice(0, current.length - MAX_SAMPLES_PER_BUCKET);
  samplesByKey.set(key, current);
  return sample;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

export function gatewayLatencySummaries(): GatewayLatencySummary[] {
  return [...samplesByKey.values()].map((samples) => {
    const first = samples[0]!;
    const count = samples.length;
    const durations = samples.map((sample) => sample.durationMs);
    const rate = (outcome: GatewayMetricOutcome) => Math.round(
      (samples.filter((sample) => sample.outcome === outcome).length / count) * 10_000,
    ) / 10_000;
    return {
      repositoryBucket: first.repositoryBucket,
      checkoutBucket: first.checkoutBucket,
      operationClass: first.operationClass,
      phase: first.phase,
      count,
      p50Ms: percentile(durations, 0.50),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
      successRate: rate('success'),
      timeoutRate: rate('timeout'),
      contentionRate: rate('contention'),
    };
  }).sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
}

export function resetGatewayLatencyMetrics(): void {
  samplesByKey.clear();
}
