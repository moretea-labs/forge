import type {
  RuntimeDiagnosticEvidence,
  RuntimeDiagnosticOutcome,
  RuntimeReadiness,
} from './types';

const DIAGNOSTICS = ['database', 'scheduler', 'releaseCoherence', 'mcpEndToEnd'] as const;
type RuntimeDiagnostic = (typeof DIAGNOSTICS)[number];

function notObserved(): RuntimeDiagnosticEvidence {
  return { outcome: 'not_observed' };
}

export class RuntimeReadinessState {
  private ready = false;
  private readonly reasons = new Set<string>();
  private readonly diagnostics: Record<RuntimeDiagnostic, RuntimeDiagnosticEvidence> = {
    database: notObserved(),
    scheduler: notObserved(),
    releaseCoherence: notObserved(),
    mcpEndToEnd: notObserved(),
  };

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  setDiagnostic(
    diagnostic: RuntimeDiagnostic,
    outcome: RuntimeDiagnosticOutcome,
    reasonCode?: string,
  ): void {
    this.diagnostics[diagnostic] = {
      outcome,
      ...(reasonCode ? { reasonCode } : {}),
    };
    if (outcome === 'fail' && reasonCode) this.reasons.add(reasonCode);
    if (outcome !== 'pass') this.ready = false;
  }

  markReady(): void {
    const incomplete = DIAGNOSTICS.filter((diagnostic) => this.diagnostics[diagnostic].outcome !== 'pass');
    if (incomplete.length > 0) {
      throw new Error(`RUNTIME_READINESS_INCOMPLETE: ${incomplete.join(',')}`);
    }
    this.ready = true;
  }

  markNotReady(reasonCode?: string): void {
    this.ready = false;
    if (reasonCode?.trim()) this.reasons.add(reasonCode.trim());
  }

  addReason(reasonCode: string): void {
    if (reasonCode.trim()) this.reasons.add(reasonCode.trim());
  }

  snapshot(): RuntimeReadiness {
    return {
      ready: this.ready,
      reasonCodes: [...this.reasons],
      diagnostics: {
        database: { ...this.diagnostics.database },
        scheduler: { ...this.diagnostics.scheduler },
        releaseCoherence: { ...this.diagnostics.releaseCoherence },
        mcpEndToEnd: { ...this.diagnostics.mcpEndToEnd },
      },
      observedAt: this.now(),
    };
  }
}
