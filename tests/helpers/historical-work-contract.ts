import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { validateWorkSemantics } from '../../packages/kernel/work/domain/state-machine';
import { WORK_PHASES, type WorkContract, type WorkPhase, type WorkPhaseEvidenceMap } from '../../packages/kernel/work/domain/types';
import type { WorkContractStoreOptions } from '../../packages/kernel/work/ports/work-contract-store';

export type HistoricalWorkInput = Partial<WorkContract> & Pick<WorkContract, 'workId' | 'repoId' | 'objective'> & {
  allowedPaths?: string[];
  forbiddenPaths?: string[];
};

function scope(options: WorkContractStoreOptions): string {
  const value = options.scopeKey?.trim() || options.repoId?.trim() || '';
  if (!value) throw new Error('TEST_HISTORICAL_WORK_SCOPE_REQUIRED');
  return value;
}

function phaseEvidence(phase: WorkPhase, at: string, refs: WorkContract['evidenceRefs']): WorkPhaseEvidenceMap {
  const current = WORK_PHASES.indexOf(phase);
  return Object.fromEntries(WORK_PHASES.map((candidate, index) => [
    candidate,
    {
      state: index < current ? 'satisfied' : index === current ? 'active' : 'pending',
      source: 'recorded',
      summary: index < current
        ? `Historical fixture advanced past ${candidate}.`
        : index === current
          ? `Historical fixture recorded in ${candidate}.`
          : `Historical fixture waiting for ${candidate}.`,
      evidenceRefs: index <= current ? refs.slice(0, 20) : [],
      recordedAt: at,
    },
  ])) as WorkPhaseEvidenceMap;
}

function historicalContract(input: HistoricalWorkInput, at: string): WorkContract {
  const { allowedPaths: _allowedPaths, forbiddenPaths: _forbiddenPaths, ...historical } = input;
  const refs = input.evidenceRefs ?? [];
  const phase = input.phase ?? 'implementation';
  const defaults: WorkContract = {
    schemaVersion: 4,
    workId: input.workId,
    repoId: input.repoId,
    objective: input.objective,
    semanticRevision: 1,
    semanticUpdatedAt: at,
    semanticState: 'open',
    acceptanceCriteria: [],
    constraints: {},
    risk: 'medium',
    phase,
    phaseEvidence: phaseEvidence(phase, at, refs),
    workKind: 'repository_change',
    dispatchState: 'not_dispatched',
    evidenceState: 'none',
    createdAt: at,
    updatedAt: at,
    checks: [],
    worktreePolicy: { required: false },
    evidencePolicy: {
      defaultDetailLevel: 'summary',
      allowRawOptIn: true,
      maxEvidenceRefs: 20,
    },
    approvalPolicy: { required: false, reasons: [], confirmed: false },
    recoveryPolicy: {
      allowSelfHealing: false,
      maxInfrastructureRetries: 0,
      handoffOnAmbiguity: true,
    },
    requestedBy: 'chatgpt',
    evidenceRefs: [],
    handoffRefs: [],
    suggestedNextActions: [],
    policyDecisions: [],
    checkRefs: [],
    implementationReviews: [],
    reconciliations: [],
  };
  const value: WorkContract = {
    ...defaults,
    ...historical,
    workId: input.workId,
    repoId: input.repoId,
    objective: input.objective,
    semanticUpdatedAt: input.semanticUpdatedAt ?? at,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    constraints: input.constraints ?? {},
    phaseEvidence: input.phaseEvidence ?? phaseEvidence(phase, at, refs),
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
    checks: input.checks ?? [],
    evidenceRefs: refs,
    handoffRefs: input.handoffRefs ?? [],
    suggestedNextActions: input.suggestedNextActions ?? [],
    policyDecisions: input.policyDecisions ?? [],
    checkRefs: input.checkRefs ?? [],
    implementationReviews: input.implementationReviews ?? [],
    reconciliations: input.reconciliations ?? [],
  };
  return validateWorkSemantics(value);
}

/** Test fixture only: inserts one immutable historical Work row. */
export function seedHistoricalWorkContract(
  options: WorkContractStoreOptions,
  input: HistoricalWorkInput,
): WorkContract {
  const at = input.createdAt ?? input.updatedAt ?? options.now?.() ?? new Date().toISOString();
  const value = historicalContract(input, at);
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'work_contract',
    scope: scope(options),
    key: value.workId,
    schemaVersion: 4,
    value,
    action: 'test_seed_historical_work_contract',
    expectedRevision: null,
  });
  return value;
}

/** Test fixture only: replaces an existing historical Work row by exact SQLite revision. */
export function replaceHistoricalWorkContract(
  options: WorkContractStoreOptions,
  input: Partial<WorkContract> & Pick<WorkContract, 'workId'>,
): WorkContract {
  const record = readControlPlaneRecord<WorkContract>(
    options.controllerHome,
    'work_contract',
    scope(options),
    input.workId,
  );
  if (!record) throw new Error(`TEST_HISTORICAL_WORK_NOT_FOUND: ${input.workId}`);
  const at = input.updatedAt ?? options.now?.() ?? new Date().toISOString();
  const value = historicalContract({ ...record.value, ...input }, at);
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'work_contract',
    scope: scope(options),
    key: value.workId,
    schemaVersion: 4,
    value,
    action: 'test_replace_historical_work_contract',
    expectedRevision: record.revision,
  });
  return value;
}
