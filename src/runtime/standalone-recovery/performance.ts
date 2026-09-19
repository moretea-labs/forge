import { spawnSync } from 'node:child_process';

/** Release acceptance evidence, never a readiness/liveness or watchdog input. */
export interface RuntimePerformanceIdentity {
  releaseId: string;
  authorityRevision: number;
  runtimeInstanceId: string;
  pid: number;
  startedAt: string;
}

export interface RuntimePerformanceEvidence extends RuntimePerformanceIdentity {
  policy: 'idle-cpu-v1';
  measuredFrom: string;
  measuredUntil: string;
  warmupMs: number;
  durationMs: number;
  sampleCount: number;
  meanCpuPercent: number;
  p95CpuPercent: number;
}

export interface RuntimeCpuReading { cpuMs: number; processStartTime: string }

const PERFORMANCE_WINDOW_MS = 10_000;
const PERFORMANCE_MAX_WINDOW_MS = 15_000;
const PERFORMANCE_WARMUP_WINDOWS = 6;
const PERFORMANCE_SAMPLE_WINDOWS = 30;
const PERFORMANCE_WARMUP_MS = PERFORMANCE_WINDOW_MS * PERFORMANCE_WARMUP_WINDOWS;
const PERFORMANCE_DURATION_MS = PERFORMANCE_WINDOW_MS * PERFORMANCE_SAMPLE_WINDOWS;

/** Dependencies are in-process test seams; no transport accepts evidence or threshold overrides. */
export interface RuntimePerformanceDependencies {
  readCpu?: (pid: number) => RuntimeCpuReading;
  monotonicNow?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function readRuntimeCpu(pid: number): RuntimeCpuReading {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'time=', '-o', 'lstart='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096, env: { ...process.env, LC_ALL: 'C' },
  });
  const match = result.status === 0
    ? result.stdout.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.+)$/)
    : undefined;
  if (!match) throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: process CPU measurement unavailable');
  const cpuMs = (Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
    + Number(match[3]) * 60 + Number(match[4])) * 1000;
  return { cpuMs, processStartTime: match[5]! };
}

export function samePerformanceIdentity(a: RuntimePerformanceIdentity, b: RuntimePerformanceIdentity): boolean {
  return a.releaseId === b.releaseId && a.authorityRevision === b.authorityRevision
    && a.runtimeInstanceId === b.runtimeInstanceId && a.pid === b.pid && a.startedAt === b.startedAt;
}

export function assertRuntimePerformanceEvidence(
  evidence: RuntimePerformanceEvidence,
  identity: RuntimePerformanceIdentity,
  now = Date.now(),
): void {
  const age = now - Date.parse(evidence.measuredUntil);
  if (evidence.policy !== 'idle-cpu-v1' || !samePerformanceIdentity(evidence, identity)
    || !Number.isFinite(age) || age < 0 || age > 60_000
    || evidence.warmupMs < PERFORMANCE_WARMUP_MS || evidence.warmupMs > PERFORMANCE_MAX_WINDOW_MS * PERFORMANCE_WARMUP_WINDOWS
    || evidence.durationMs < PERFORMANCE_DURATION_MS || evidence.durationMs > PERFORMANCE_MAX_WINDOW_MS * PERFORMANCE_SAMPLE_WINDOWS || evidence.sampleCount !== PERFORMANCE_SAMPLE_WINDOWS
    || !Number.isFinite(evidence.meanCpuPercent) || evidence.meanCpuPercent < 0
    || !Number.isFinite(evidence.p95CpuPercent) || evidence.p95CpuPercent < 0) {
    throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: incomplete, stale or mismatched performance evidence');
  }
  if (evidence.meanCpuPercent > 5 || evidence.p95CpuPercent > 10) {
    throw new Error(`RECOVERY_PERFORMANCE_REJECTED: mean=${evidence.meanCpuPercent.toFixed(2)}% p95=${evidence.p95CpuPercent.toFixed(2)}%`);
  }
}

/** Observe 10 seconds of warmup followed by ten 5-second CPU-time delta windows. */
export async function measureRuntimePerformance(
  observeIdentity: () => RuntimePerformanceIdentity,
  dependencies: RuntimePerformanceDependencies = {},
): Promise<RuntimePerformanceEvidence> {
  const readCpu = dependencies.readCpu ?? readRuntimeCpu;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const wallNow = dependencies.wallNow ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const identity = observeIdentity();
  const initial = readCpu(identity.pid);
  const observe = () => {
    if (!samePerformanceIdentity(identity, observeIdentity())) {
      throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: Runtime or release authority changed');
    }
    const cpu = readCpu(identity.pid);
    if (cpu.processStartTime !== initial.processStartTime || !Number.isFinite(cpu.cpuMs)) {
      throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: process identity changed');
    }
    return cpu;
  };
  const warmingAt = monotonicNow();
  let previousWarmupAt = warmingAt;
  for (let i = 0; i < PERFORMANCE_WARMUP_WINDOWS; i++) {
    await sleep(PERFORMANCE_WINDOW_MS);
    observe();
    const nextWarmupAt = monotonicNow();
    const elapsed = nextWarmupAt - previousWarmupAt;
    if (elapsed < PERFORMANCE_WINDOW_MS || elapsed > PERFORMANCE_MAX_WINDOW_MS) {
      throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: interrupted CPU warmup window');
    }
    previousWarmupAt = nextWarmupAt;
  }
  const warmupMs = monotonicNow() - warmingAt;
  const measuredFrom = new Date(wallNow()).toISOString();
  let previousCpu = observe().cpuMs;
  let previousAt = monotonicNow();
  const startedAt = previousAt;
  let totalCpuMs = 0;
  const windows: number[] = [];
  for (let i = 0; i < PERFORMANCE_SAMPLE_WINDOWS; i++) {
    await sleep(PERFORMANCE_WINDOW_MS);
    const nextCpu = observe().cpuMs;
    const nextAt = monotonicNow();
    const elapsed = nextAt - previousAt;
    const cpuDelta = nextCpu - previousCpu;
    // Suspended/overloaded collectors cannot pass as ordinary sample windows.
    if (elapsed < PERFORMANCE_WINDOW_MS || elapsed > PERFORMANCE_MAX_WINDOW_MS || cpuDelta < 0) {
      throw new Error('RECOVERY_PERFORMANCE_UNKNOWN: interrupted CPU observation window');
    }
    windows.push(cpuDelta / elapsed * 100);
    totalCpuMs += cpuDelta;
    previousCpu = nextCpu;
    previousAt = nextAt;
  }
  const durationMs = previousAt - startedAt;
  windows.sort((a, b) => a - b);
  const evidence: RuntimePerformanceEvidence = {
    ...identity, policy: 'idle-cpu-v1', measuredFrom, measuredUntil: new Date(wallNow()).toISOString(),
    warmupMs, durationMs, sampleCount: windows.length,
    meanCpuPercent: totalCpuMs / durationMs * 100,
    p95CpuPercent: windows[Math.ceil(windows.length * 0.95) - 1]!,
  };
  assertRuntimePerformanceEvidence(evidence, observeIdentity(), wallNow());
  return evidence;
}
