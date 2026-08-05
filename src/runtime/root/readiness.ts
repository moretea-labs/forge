import type { RuntimeCheckState, RuntimeLifecycle, RuntimeReadiness } from './types';

const CORE_CHECKS = ['database', 'scheduler', 'releaseCoherence', 'mcpEndToEnd'] as const;
type CoreCheck = (typeof CORE_CHECKS)[number];

export class RuntimeReadinessState {
  private lifecycle: RuntimeLifecycle = 'starting';
  private readonly reasons = new Set<string>();
  private readonly checks: Record<CoreCheck, RuntimeCheckState> = {
    database: 'unknown',
    scheduler: 'unknown',
    releaseCoherence: 'unknown',
    mcpEndToEnd: 'unknown',
  };

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  setLifecycle(lifecycle: RuntimeLifecycle): void {
    this.lifecycle = lifecycle;
  }

  setCheck(check: CoreCheck, state: RuntimeCheckState, reasonCode?: string): void {
    this.checks[check] = state;
    if (state === 'fail' && reasonCode) this.reasons.add(reasonCode);
  }

  addReason(reasonCode: string): void {
    if (reasonCode.trim()) this.reasons.add(reasonCode.trim());
  }

  snapshot(): RuntimeReadiness {
    const allCoreChecksPass = CORE_CHECKS.every((check) => this.checks[check] === 'pass');
    return {
      lifecycle: this.lifecycle,
      ready: this.lifecycle === 'running' && allCoreChecksPass,
      reasonCodes: [...this.reasons],
      checks: { ...this.checks },
      observedAt: this.now(),
    };
  }
}
