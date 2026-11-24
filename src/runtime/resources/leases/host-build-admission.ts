import { cpus, loadavg } from 'os';

/** CPU-only fail-closed new-build admission; existing lease owners are never preempted. */
type Sample = { cpus: number; load: number };
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
    return {
      allowed: ratio < 1.15,
      reason: ratio < 1.15 ? 'headroom' : 'cpu_overloaded',
      ratio: Number(ratio.toFixed(3)),
    };
  } catch {
    return { allowed: false, reason: 'probe_unavailable', ratio: null };
  }
}
