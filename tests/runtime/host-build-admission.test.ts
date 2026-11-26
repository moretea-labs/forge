import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { acquireExecutionLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';
import {
  checkHostBuildCpu,
  setHostBuildCpuProbeForTest,
  hostBuildParallelism,
} from '../../src/runtime/resources/leases/host-build-admission';
afterEach(() => setHostBuildCpuProbeForTest(undefined));
describe('shared global iOS build CPU admission', () => {
  test('reserves interactive CPU headroom before full saturation', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 8 }));
    expect(checkHostBuildCpu()).toEqual({ allowed: false, reason: 'cpu_overloaded', ratio: 0.8 });
  });
  test('memory pressure blocks a build even when CPU has headroom', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 2.5, memoryFreePercent: 8 }));
    expect(checkHostBuildCpu()).toEqual({ allowed: false, reason: 'memory_pressure', ratio: 0.25 });
  });
  test('Xcode workers shrink and expand with host load', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 2.5 }));
    expect(hostBuildParallelism()).toBe(5);
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 6 }));
    expect(hostBuildParallelism()).toBe(2);
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 31 }));
    expect(hostBuildParallelism()).toBe(1);
  });
  test('10-core Mac admits new build below overload', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 2.5 }));
    expect(checkHostBuildCpu()).toEqual({ allowed: true, reason: 'headroom', ratio: 0.25 });
  });
  test('overloaded Mac denies only new compile lease', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 31 }));
    expect(checkHostBuildCpu()).toEqual({ allowed: false, reason: 'cpu_overloaded', ratio: 3.1 });
  });
  test('unavailable host signal fails closed', () => {
    setHostBuildCpuProbeForTest(() => ({ cpus: 0, load: NaN }));
    expect(checkHostBuildCpu()).toEqual({ allowed: false, reason: 'probe_unavailable', ratio: null });
  });

  test('canonical lease acquisition blocks overloaded native build but not independent work', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-host-cpu-admission-'));
    const options = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    try {
      ensureControllerHome(home);
      setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 31 }));
      const blocked = acquireExecutionLeases(
        home,
        'repo-admission',
        'new-build',
        [{ resourceKey: 'host-service:ios-build', mode: 'write' }],
        options,
      );
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockers[0]?.resourceKey).toBe('host-service:ios-build:cpu-pressure');

      const ordinary = acquireExecutionLeases(
        home,
        'repo-admission',
        'independent-read',
        [{ resourceKey: 'provider-resource:independent-read', mode: 'read' }],
        options,
      );
      expect(ordinary.acquired).toBe(true);
      if (ordinary.acquired)
        releaseExecutionLeases(home, 'repo-admission', 'independent-read', ordinary.leases, options);

      setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 2.5 }));
      const admitted = acquireExecutionLeases(
        home,
        'repo-admission',
        'new-build',
        [{ resourceKey: 'host-service:ios-build', mode: 'write' }],
        options,
      );
      expect(admitted.acquired).toBe(true);
      if (admitted.acquired) releaseExecutionLeases(home, 'repo-admission', 'new-build', admitted.leases, options);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
