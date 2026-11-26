import { cpus, loadavg } from 'os';
import { spawnSync } from 'child_process';

/** Shared native-work capacity; leave headroom for the interactive Runtime. */
type Sample = { cpus: number; load: number; memoryFreePercent?: number };
let testProbe: (() => Sample) | undefined;
export function setHostBuildCpuProbeForTest(probe?: () => Sample): void {
  testProbe = probe;
}
export function checkHostBuildCpu(): { allowed: boolean; reason: string; ratio: number | null } {
  if (process.platform !== 'darwin' && !testProbe) return { allowed: true, reason: 'non_macos', ratio: null };
  try {
    const sample = testProbe?.() ?? { cpus: cpus().length, load: loadavg()[0] ?? NaN };
    if (!Number.isInteger(sample.cpus) || sample.cpus < 1 || !Number.isFinite(sample.load) || sample.load < 0)
      return { allowed: false, reason: 'probe_unavailable', ratio: null };
    const ratio = sample.load / sample.cpus;
    const measuredRatio = Number(ratio.toFixed(3));
    // Admission is host-wide, independent of repository or Writer identity.
    if (ratio >= 0.8) return { allowed: false, reason: 'cpu_overloaded', ratio: measuredRatio };
    const memory = testProbe ? (sample.memoryFreePercent ?? 100) : readHostMemoryFreePercent();
    if (memory === undefined) return { allowed: false, reason: 'probe_unavailable', ratio: measuredRatio };
    return { allowed: memory >= 12, reason: memory >= 12 ? 'headroom' : 'memory_pressure', ratio: measuredRatio };
  } catch {
    return { allowed: false, reason: 'probe_unavailable', ratio: null };
  }
}

function readHostMemoryFreePercent(): number | undefined {
  const result = spawnSync('/usr/bin/memory_pressure', ['-Q'], {
    encoding: 'utf8',
    timeout: 500,
    maxBuffer: 4096,
  });
  const match = result.stdout?.match(/System-wide memory free percentage:\s*([\d.]+)\s*%/);
  const value = match ? Number(match[1]) : NaN;
  return result.status === 0 && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

export function assertHostWorkCapacity(): void {
  const capacity = checkHostBuildCpu();
  if (!capacity.allowed) {
    throw new Error(`HOST_RESOURCE_PRESSURE: ${capacity.reason}; defer heavy work until host headroom recovers`);
  }
}

/** Bound Xcode's workers by current headroom, rather than a fixed -jobs value. */
export function hostBuildParallelism(): number {
  const sample = testProbe?.() ?? { cpus: cpus().length, load: loadavg()[0] ?? NaN };
  if (!Number.isFinite(sample.load) || !Number.isInteger(sample.cpus) || sample.cpus < 1) return 1;
  return Math.max(1, Math.floor(sample.cpus * 0.8 - Math.max(0, sample.load)));
}
