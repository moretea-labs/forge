import { mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  normalizePlanScopeKey,
  resolvePlanAdmission,
  withPlanAdmissionLock,
  withPlanAdmissionLockAsync,
  type PlanAdmissionRelation,
  type PlanAdmissionResolution,
} from './semantic-admission';
import {
  listControlPlaneRecords,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../persistence/sqlite-store';
import { readRequirement } from '../persistence/requirement-store';
import {
  isTerminalPlanContractStatus,
  type EvidenceRef,
  type PlanContract,
  type PlanContractStatus,
  type PlanContractStore,
  type PlanStep,
  type WorkContract,
} from './types';

export interface PlanContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface PlanContractStoreOptions extends PlanContractStoreLocation {
  now?: () => string;
}

export interface CreatePlanContractInput {
  planId: string;
  repoId: string;
  requirementId?: string;
  scopeKey: string;
  sourceRevision: string;
  goal: string;
  nonGoals?: string[];
  assumptions?: string[];
  resolvedDecisions?: string[];
  stopConditions?: string[];
  replanConditions?: string[];
  integrationStrategy?: string;
  steps: Array<Omit<PlanStep, 'status' | 'evidenceRefs'> & Partial<Pick<PlanStep, 'status' | 'evidenceRefs'>>>;
  evidenceRefs?: EvidenceRef[];
}

export interface AdmitPlanContractInput extends CreatePlanContractInput {
  planRelation?: PlanAdmissionRelation;
  relatedPlanId?: string;
}

export type AdmitPlanContractResult = PlanAdmissionResolution;

export interface PlanContractSummary {
  planId: string;
  repoId: string;
  requirementId?: string;
  scopeKey: string;
  sourceRevision: string;
  goal: string;
  status: PlanContractStatus;
  stepCount: number;
  completedSteps: number;
  updatedAt: string;
}

function nowIso(options: PlanContractStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function bounded(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] {
  return (values ?? []).map((value) => String(value).trim()).filter(Boolean).slice(0, limit).map((value) => value.slice(0, maxLength));
}

function normalizeScopeKey(value: string): string {
  return normalizePlanScopeKey(value) || 'unknown';
}

function normalizeStep(step: CreatePlanContractInput['steps'][number]): PlanStep {
  return {
    id: sanitizeFileComponent(step.id).slice(0, 120),
    objective: String(step.objective ?? '').trim().slice(0, 1_000),
    dependencies: bounded(step.dependencies, 30, 120).map(sanitizeFileComponent),
    authoritativeFiles: bounded(step.authoritativeFiles, 50),
    allowedPaths: bounded(step.allowedPaths, 50),
    forbiddenPaths: bounded(step.forbiddenPaths, 50),
    checks: bounded(step.checks, 30, 200),
    acceptanceCriteria: bounded(step.acceptanceCriteria, 20),
    status: step.status ?? 'pending',
    // A legacy PlanStep may already carry its materialized Work link. Keep the
    // link on read; Work remains the only execution authority and this is only
    // a relationship/projection field.
    workId: step.workId?.trim() || undefined,
    evidenceRefs: (step.evidenceRefs ?? []).slice(0, 20),
  };
}

function updatePlanContract(
  options: PlanContractStoreOptions,
  planId: string,
  mutate: (current: PlanContract) => PlanContract,
): PlanContract {
  const apply = (): PlanContract => {
    const store = readPlanContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
    if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
    const next = mutate(store.contracts[index]);
    const contracts = [...store.contracts];
    contracts[index] = next;
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: next.updatedAt, contracts });
    return next;
  };
  if (!options.controllerHome || !options.repoId) return apply();
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `plan-${sanitizeFileComponent(planId)}` },
    'plan-contract-store',
    apply,
    15_000,
  );
}

function assertRequirementReference(options: PlanContractStoreOptions, requirementId: string | undefined): void {
  const normalized = requirementId?.trim();
  if (!normalized || !options.controllerHome) return;
  if (!readRequirement({ controllerHome: options.controllerHome, now: options.now }, normalized)) {
    throw new Error(`PLAN_REQUIREMENT_NOT_FOUND: ${normalized}`);
  }
}

export function planContractRoot(location: PlanContractStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('plan contract store requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'plan-contracts');
  mkdirSync(root, { recursive: true });
  return root;
}

export function planContractStorePath(location: PlanContractStoreLocation): string {
  return join(planContractRoot(location), 'index.json');
}

export function emptyPlanContractStore(updatedAt: string): PlanContractStore {
  return { schemaVersion: 1, updatedAt, contracts: [] };
}
function sqliteBacked(options: PlanContractStoreOptions): options is PlanContractStoreOptions & { controllerHome: string; repoId: string } {
  return Boolean(!options.root && options.controllerHome?.trim() && options.repoId?.trim());
}

export function readPlanContractStore(options: PlanContractStoreOptions): PlanContractStore {
  if (!sqliteBacked(options)) {
    return readJsonFile<PlanContractStore>(planContractStorePath(options), emptyPlanContractStore(nowIso(options)));
  }
  const records = listControlPlaneRecords<PlanContract>(options.controllerHome, {
    namespace: 'plan_contract',
    scope: options.repoId,
    limit: 5_000,
  });
  if (records.length > 0) {
    return {
      schemaVersion: 1,
      updatedAt: records[0]?.updatedAt ?? nowIso(options),
      contracts: records.map((record) => record.value),
    };
  }

  // One-time migration from the old JSON index. Runtime reads do not keep a
  // fallback once a per-plan SQLite row exists.
  const legacy = readJsonFile<PlanContractStore>(planContractStorePath(options), emptyPlanContractStore(nowIso(options)));
  if (legacy.contracts.length > 0) {
    withControlPlaneTransaction(options.controllerHome, (database) => {
      for (const contract of legacy.contracts) {
        if (readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, contract.planId)) continue;
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'plan_contract',
          scope: options.repoId,
          key: contract.planId,
          schemaVersion: 1,
          value: contract,
          action: 'plan_contract_legacy_import',
          expectedRevision: null,
        });
      }
    });
  }
  return legacy;
}

function writePlanContractStore(options: PlanContractStoreOptions, store: PlanContractStore): PlanContractStore {
  if (!sqliteBacked(options)) {
    writeJsonAtomic(planContractStorePath(options), store);
    return store;
  }
  withControlPlaneTransaction(options.controllerHome, (database) => {
    for (const contract of store.contracts) {
      const current = readControlPlaneRecordWithinTransaction<PlanContract>(
        database,
        'plan_contract',
        options.repoId,
        contract.planId,
      );
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract',
        scope: options.repoId,
        key: contract.planId,
        schemaVersion: 1,
        value: contract,
        action: 'plan_contract_write',
        expectedRevision: current?.revision ?? null,
      });
    }
  });
  return store;
}

function createPlanContractUnlocked(options: PlanContractStoreOptions, input: CreatePlanContractInput): PlanContract {
  assertRequirementReference(options, input.requirementId);
  const at = nowIso(options);
  const planId = sanitizeFileComponent(input.planId);
  if (!String(input.planId ?? '').trim() || planId === 'unknown') throw new Error('plan_id is required');
  const plan: PlanContract = {
    schemaVersion: 1,
    planId,
    repoId: input.repoId,
    requirementId: input.requirementId?.trim().slice(0, 160) || undefined,
    scopeKey: normalizeScopeKey(input.scopeKey),
    sourceRevision: String(input.sourceRevision ?? '').trim().slice(0, 200),
    goal: String(input.goal ?? '').trim().slice(0, 2_000),
    nonGoals: bounded(input.nonGoals, 20),
    assumptions: bounded(input.assumptions, 30),
    resolvedDecisions: bounded(input.resolvedDecisions, 30),
    stopConditions: bounded(input.stopConditions, 20),
    replanConditions: bounded(input.replanConditions, 20),
    integrationStrategy: input.integrationStrategy?.trim().slice(0, 1_000),
    status: 'draft',
    steps: input.steps.slice(0, 30).map(normalizeStep),
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 20),
    createdAt: at,
    updatedAt: at,
  };
  const store = readPlanContractStore(options);
  if (store.contracts.some((existing) => existing.planId === plan.planId)) {
    throw new Error(`plan contract already exists: ${plan.planId}`);
  }
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts: [plan, ...store.contracts] });
  return plan;
}

export function createPlanContract(options: PlanContractStoreOptions, input: CreatePlanContractInput): PlanContract {
  return withPlanAdmissionLock(options, () => {
    const store = readPlanContractStore(options);
    const planId = sanitizeFileComponent(input.planId);
    if (store.contracts.some((existing) => existing.planId === planId)) {
      throw new Error(`plan contract already exists: ${planId}`);
    }
    const scopeKey = normalizeScopeKey(input.scopeKey);
    const existingScopeAuthority = scopeKey === 'unknown' ? undefined : store.contracts.find((existing) =>
      !isTerminalPlanContractStatus(existing.status) && existing.scopeKey === scopeKey);
    if (existingScopeAuthority) {
      throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${scopeKey}:${existingScopeAuthority.planId}`);
    }
    return createPlanContractUnlocked(options, input);
  });
}

function admitPlanContractUnlocked(options: PlanContractStoreOptions, input: AdmitPlanContractInput): AdmitPlanContractResult {
  assertRequirementReference(options, input.requirementId);
  const activePlans = listPlanContracts({ ...options, status: 'active', limit: 100 });
  const resolution = resolvePlanAdmission(activePlans, {
    requirementId: input.requirementId,
    scopeKey: input.scopeKey,
    planRelation: input.planRelation,
    relatedPlanId: input.relatedPlanId,
  });
  if (resolution.admissionDecision !== 'create_new') return resolution;
  return { ...resolution, plan: createPlanContractUnlocked(options, input) };
}

export function admitPlanContract(options: PlanContractStoreOptions, input: AdmitPlanContractInput): AdmitPlanContractResult {
  return withPlanAdmissionLock(options, () => admitPlanContractUnlocked(options, input));
}

export async function admitPlanContractAsync(options: PlanContractStoreOptions, input: AdmitPlanContractInput): Promise<AdmitPlanContractResult> {
  return await withPlanAdmissionLockAsync(options, () => admitPlanContractUnlocked(options, input));
}

export function getPlanContract(options: PlanContractStoreOptions, planId: string): PlanContract | undefined {
  return readPlanContractStore(options).contracts.find((contract) => contract.planId === sanitizeFileComponent(planId));
}

export function listPlanContracts(options: PlanContractStoreOptions & { status?: PlanContractStatus | 'active' | 'all'; limit?: number }): PlanContract[] {
  const status = options.status ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return readPlanContractStore(options).contracts
    .filter((contract) => status === 'all' || (status === 'active' ? !isTerminalPlanContractStatus(contract.status) : contract.status === status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function summarizePlanContract(plan: PlanContract): PlanContractSummary {
  return {
    planId: plan.planId,
    repoId: plan.repoId,
    requirementId: plan.requirementId,
    scopeKey: plan.scopeKey,
    sourceRevision: plan.sourceRevision,
    goal: plan.goal.slice(0, 240),
    status: plan.status,
    stepCount: plan.steps.length,
    completedSteps: plan.steps.filter((step) => step.status === 'completed').length,
    updatedAt: plan.updatedAt,
  };
}

function approvalErrors(plan: PlanContract, allPlans: readonly PlanContract[]): string[] {
  const errors: string[] = [];
  if (!plan.sourceRevision) errors.push('source_revision is required before approval');
  if (!plan.scopeKey || plan.scopeKey === 'unknown') errors.push('scope_key is required before approval');
  if (!plan.goal) errors.push('goal is required before approval');
  if (plan.steps.length === 0) errors.push('at least one plan step is required before approval');
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id || step.id === 'unknown') errors.push('every plan step needs an id');
    else if (ids.has(step.id)) errors.push(`duplicate plan step id: ${step.id}`);
    else ids.add(step.id);
    if (!step.objective) errors.push(`step ${step.id || 'unknown'} needs an objective`);
    if (step.checks.length === 0) errors.push(`step ${step.id || 'unknown'} needs at least one machine-checkable check`);
    if (step.acceptanceCriteria.length === 0) errors.push(`step ${step.id || 'unknown'} needs acceptance criteria`);
    if (step.status !== 'pending') errors.push(`step ${step.id || 'unknown'} must be pending before approval`);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      const dependencyStep = plan.steps.find((candidate) => candidate.id === dependency);
      if (!dependencyStep) errors.push(`step ${step.id} references unknown dependency ${dependency}`);
      else if (dependencyStep.status !== 'pending') errors.push(`step ${step.id} dependency ${dependency} must be pending before approval`);
    }
  }
  const scopeIsCommitted = (status: PlanContractStatus): boolean => [
    'approved',
    'executing',
    'replanning',
    'verifying',
    'ready_to_finalize',
  ].includes(status);
  if (allPlans.some((existing) => existing.planId !== plan.planId && existing.scopeKey === plan.scopeKey && scopeIsCommitted(existing.status))) {
    errors.push(`active plan already owns scope_key ${plan.scopeKey}`);
  }
  return [...new Set(errors)];
}

function approvePlanContractUnlocked(options: PlanContractStoreOptions, planId: string): PlanContract {
  const store = readPlanContractStore(options);
  const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
  if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
  const current = store.contracts[index];
  assertRequirementReference(options, current.requirementId);
  if (current.status !== 'draft' && current.status !== 'reviewing') throw new Error(`plan contract ${current.planId} cannot be approved from ${current.status}`);
  const errors = approvalErrors(current, store.contracts);
  if (errors.length > 0) throw new Error(`plan contract ${current.planId} cannot be approved: ${errors.join('; ')}`);
  const at = nowIso(options);
  const next = { ...current, status: 'approved' as const, updatedAt: at };
  const contracts = [...store.contracts];
  contracts[index] = next;
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
  return next;
}

export function approvePlanContract(options: PlanContractStoreOptions, planId: string): PlanContract {
  return withPlanAdmissionLock(options, () => approvePlanContractUnlocked(options, planId));
}

export async function approvePlanContractAsync(options: PlanContractStoreOptions, planId: string): Promise<PlanContract> {
  return await withPlanAdmissionLockAsync(options, () => approvePlanContractUnlocked(options, planId));
}

export function supersedePlanContract(options: PlanContractStoreOptions, planId: string, supersededBy: string): PlanContract {
  const store = readPlanContractStore(options);
  const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
  if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
  const current = store.contracts[index];
  if (isTerminalPlanContractStatus(current.status)) throw new Error(`plan contract ${current.planId} is terminal (${current.status})`);
  const replacement = sanitizeFileComponent(supersededBy);
  if (!replacement || replacement === 'unknown') throw new Error('superseded_by is required');
  const at = nowIso(options);
  const next = { ...current, status: 'superseded' as const, supersededBy: replacement, updatedAt: at };
  const contracts = [...store.contracts];
  contracts[index] = next;
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
  return next;
}

/**
 * Atomically reserve one eligible step for one WorkContract. This is the
 * Plan-to-Work concurrency boundary: competing callers cannot bind the same
 * step, and a stale source revision causes no WorkContract side effect.
 */
export function claimPlanStepForWork(
  options: PlanContractStoreOptions,
  input: { planId: string; stepId: string; workId: string; sourceRevision: string },
): PlanContract {
  return updatePlanContract(options, input.planId, (current) => {
    assertRequirementReference(options, current.requirementId);
    if (current.status !== 'approved' && current.status !== 'executing') {
      throw new Error(`PLAN_NOT_EXECUTABLE: ${current.planId} is ${current.status}`);
    }
    if (current.sourceRevision !== input.sourceRevision) {
      return { ...current, status: 'invalidated_by_drift', updatedAt: nowIso(options) };
    }
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.status === 'executing' || step.workId) throw new Error(`PLAN_STEP_ALREADY_ACTIVE: ${step.id}`);
    if (step.status === 'completed') throw new Error(`PLAN_STEP_ALREADY_COMPLETED: ${step.id}`);
    const unresolved = step.dependencies.filter((dependency) => current.steps.find((candidate) => candidate.id === dependency)?.status !== 'completed');
    if (unresolved.length > 0) throw new Error(`PLAN_STEP_DEPENDENCIES_PENDING: ${unresolved.join(', ')}`);
    const at = nowIso(options);
    const steps = [...current.steps];
    steps[stepIndex] = { ...step, status: 'executing', workId: input.workId };
    return { ...current, status: 'executing', steps, updatedAt: at };
  });
}

export function repairDanglingPlanStepWorkBinding(
  options: PlanContractStoreOptions,
  input: { planId: string; stepId: string; expectedWorkId: string; reason: string },
): PlanContract {
  const expectedWorkId = input.expectedWorkId.trim();
  const reason = input.reason.trim();
  if (!expectedWorkId) throw new Error('PLAN_STEP_REPAIR_EXPECTED_WORK_REQUIRED');
  if (!reason) throw new Error('PLAN_STEP_REPAIR_REASON_REQUIRED');
  return updatePlanContract(options, input.planId, (current) => {
    if (isTerminalPlanContractStatus(current.status)) throw new Error(`PLAN_STEP_REPAIR_PLAN_TERMINAL: ${current.planId} is ${current.status}`);
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.workId !== expectedWorkId) {
      throw new Error(`PLAN_STEP_REPAIR_BINDING_CHANGED: ${step.id} is bound to ${step.workId ?? 'no Work'}, expected ${expectedWorkId}`);
    }
    if (step.status !== 'executing') {
      throw new Error(`PLAN_STEP_REPAIR_STATUS_INVALID: ${step.id} is ${step.status}`);
    }
    const at = nowIso(options);
    const steps = [...current.steps];
    steps[stepIndex] = {
      ...step,
      status: 'ready',
      workId: undefined,
      evidenceRefs: [{
        title: 'dangling Work binding repaired',
        summary: `${expectedWorkId}: ${reason}`.slice(0, 2_000),
        detailLevel: 'summary' as const,
      }, ...step.evidenceRefs].slice(0, 20),
    };
    // This is admission-state repair, not semantic replanning: the Plan and its
    // acceptance criteria remain authoritative. Return the exact step to ready
    // so a later start can atomically admit one replacement for the missing
    // record without forcing a second Plan authority.
    return { ...current, status: 'executing', steps, updatedAt: at };
  });
}

export function completePlanStepForWork(
  options: PlanContractStoreOptions,
  input: {
    planId: string;
    stepId: string;
    work: Pick<WorkContract, 'workId' | 'status' | 'phase' | 'evidenceState' | 'completionOutcome' | 'completionReceipt' | 'evidenceRefs'>;
  },
): PlanContract {
  return updatePlanContract(options, input.planId, (current) => {
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.workId !== input.work.workId) throw new Error(`PLAN_STEP_WORK_MISMATCH: ${input.stepId}`);
    if (step.status === 'completed') return current;
    const delivered = input.work.status === 'completed'
      && input.work.phase === 'cleanup'
      && input.work.evidenceState === 'valid'
      && Boolean(input.work.completionOutcome && input.work.completionOutcome !== 'superseded')
      && Boolean(input.work.completionReceipt);
    const failed = input.work.status === 'failed' || input.work.status === 'cancelled';
    if (!delivered && !failed) throw new Error(`PLAN_STEP_WORK_NOT_TERMINAL: ${input.work.workId}`);
    const at = nowIso(options);
    const steps = [...current.steps];
    steps[stepIndex] = {
      ...step,
      // Work completion proves machine delivery only. The Plan step remains in
      // semantic validation until an explicit Controller acceptance records it.
      // Failed/cancelled Work returns the slice to ready for replanning.
      status: delivered ? 'validating' : 'ready',
      // Successful delivery keeps the exact Work identity through semantic
      // validation. Failed/cancelled Work releases the step authority so the
      // replanning path cannot retain a ghost binding to a terminal Work.
      workId: delivered ? step.workId : undefined,
      evidenceRefs: input.work.evidenceRefs.length > 0 ? input.work.evidenceRefs.slice(0, 20) : step.evidenceRefs,
    };
    return { ...current, status: delivered ? 'verifying' : 'replanning', steps, updatedAt: at };
  });
}

export function acceptPlanStepEvidence(
  options: PlanContractStoreOptions,
  input: { planId: string; stepId: string; reviewer: string; rationale: string; acceptedSourceRevision?: string },
): PlanContract {
  const reviewer = input.reviewer.trim();
  const rationale = input.rationale.trim();
  if (!reviewer || !rationale) throw new Error('PLAN_STEP_SEMANTIC_ACCEPTANCE_METADATA_REQUIRED');
  return updatePlanContract(options, input.planId, (current) => {
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.status === 'completed') return current;
    if (step.status !== 'validating') throw new Error(`PLAN_STEP_NOT_READY_FOR_SEMANTIC_ACCEPTANCE: ${step.id} is ${step.status}`);
    const steps = [...current.steps];
    steps[stepIndex] = {
      ...step,
      status: 'completed',
      evidenceRefs: [{ title: 'semantic acceptance', summary: `${reviewer}: ${rationale}`, detailLevel: 'summary' as const }, ...step.evidenceRefs].slice(0, 20),
    };
    const allCompleted = steps.every((candidate) => candidate.status === 'completed');
    const acceptedSourceRevision = input.acceptedSourceRevision?.trim();
    return {
      ...current,
      ...(acceptedSourceRevision ? { sourceRevision: acceptedSourceRevision } : {}),
      status: allCompleted ? 'finalized' : 'executing',
      steps,
      updatedAt: nowIso(options),
    };
  });
}
