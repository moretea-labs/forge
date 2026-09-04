import { createHash } from 'crypto';
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
  rebindPlanBoundWorkContract,
  retirePlanBoundWorkContract,
  isTerminalWorkContractStatus,
  type WorkContract,
} from '../../../../packages/kernel/work/api/index';
import {
  isTerminalPlanContractStatus,
  type EvidenceRef,
  type PlanContract,
  type PlanContractStatus,
  type PlanContractStore,
  type PlanObligationDisposition,
  type PlanStep,
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
  obligationDispositions?: PlanObligationDisposition[];
}

export interface AdmitPlanContractInput extends CreatePlanContractInput {
  planRelation?: PlanAdmissionRelation;
  relatedPlanId?: string;
}

export interface RepairDraftPlanContractInput extends Omit<CreatePlanContractInput, 'planId' | 'repoId' | 'requirementId' | 'evidenceRefs'> {
  /** Source revision observed before entering the admission lock; rejects stale draft writers. */
  expectedSourceRevision?: string;
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

function normalizeObligationDisposition(value: PlanObligationDisposition): PlanObligationDisposition {
  const disposition = value.disposition;
  if (!['keep', 'change', 'defer', 'drop'].includes(disposition)) throw new Error(`PLAN_OBLIGATION_DISPOSITION_INVALID: ${String(disposition)}`);
  return {
    predecessorPlanId: sanitizeFileComponent(value.predecessorPlanId).slice(0, 160),
    obligationId: String(value.obligationId ?? '').trim().slice(0, 160),
    disposition,
    successorRefs: bounded(value.successorRefs, 20, 240),
    ...(value.rationale?.trim() ? { rationale: value.rationale.trim().slice(0, 1_000) } : {}),
  };
}

export interface PlanObligation {
  obligationId: string;
  predecessorPlanId: string;
  kind: 'step_objective' | 'step_acceptance' | 'non_goal' | 'resolved_decision' | 'stop_condition' | 'replan_condition';
  sourceRef: string;
  summary: string;
}

function planObligationId(planId: string, kind: PlanObligation['kind'], sourceRef: string, summary: string): string {
  const digest = createHash('sha256').update(JSON.stringify({ planId, kind, sourceRef, summary })).digest('hex').slice(0, 24);
  return `obl_${digest}`;
}

export function listUnresolvedPlanObligations(plan: PlanContract): PlanObligation[] {
  const out: PlanObligation[] = [];
  const add = (kind: PlanObligation['kind'], sourceRef: string, summary: string) => {
    const normalized = summary.trim();
    if (!normalized) return;
    out.push({ obligationId: planObligationId(plan.planId, kind, sourceRef, normalized), predecessorPlanId: plan.planId, kind, sourceRef, summary: normalized });
  };
  for (const step of plan.steps) {
    if (step.status === 'completed') continue;
    add('step_objective', `step:${step.id}`, step.objective);
    step.acceptanceCriteria.forEach((criterion, index) => add('step_acceptance', `step:${step.id}:acceptance:${index}`, criterion));
  }
  plan.nonGoals.forEach((value, index) => add('non_goal', `non_goal:${index}`, value));
  plan.resolvedDecisions.forEach((value, index) => add('resolved_decision', `resolved_decision:${index}`, value));
  plan.stopConditions.forEach((value, index) => add('stop_condition', `stop_condition:${index}`, value));
  plan.replanConditions.forEach((value, index) => add('replan_condition', `replan_condition:${index}`, value));
  return out;
}

function successorObligationRefs(plan: PlanContract): Set<string> {
  const refs = new Set<string>(['goal']);
  for (const step of plan.steps) {
    refs.add(`step:${step.id}`);
    step.acceptanceCriteria.forEach((_criterion, index) => refs.add(`step:${step.id}:acceptance:${index}`));
  }
  plan.nonGoals.forEach((_value, index) => refs.add(`non_goal:${index}`));
  plan.resolvedDecisions.forEach((_value, index) => refs.add(`resolved_decision:${index}`));
  plan.stopConditions.forEach((_value, index) => refs.add(`stop_condition:${index}`));
  plan.replanConditions.forEach((_value, index) => refs.add(`replan_condition:${index}`));
  if (plan.integrationStrategy?.trim()) refs.add('integration_strategy');
  return refs;
}

function obligationContinuityErrors(plan: PlanContract, allPlans: readonly PlanContract[]): string[] {
  const errors: string[] = [];
  const dispositions = plan.obligationDispositions ?? [];
  const successorRefs = successorObligationRefs(plan);
  const predecessorObligations = new Map<string, Set<string>>();
  for (const predecessorId of plan.supersedes ?? []) {
    const predecessor = allPlans.find((candidate) => candidate.planId === predecessorId);
    if (!predecessor) {
      errors.push(`superseded predecessor not found: ${predecessorId}`);
      continue;
    }
    predecessorObligations.set(predecessor.planId, new Set(listUnresolvedPlanObligations(predecessor).map((entry) => entry.obligationId)));
  }

  const seen = new Set<string>();
  for (const disposition of dispositions) {
    const key = `${disposition.predecessorPlanId}:${disposition.obligationId}`;
    if (seen.has(key)) errors.push(`duplicate obligation disposition ${key}`);
    seen.add(key);
    const known = predecessorObligations.get(disposition.predecessorPlanId);
    if ((plan.supersedes ?? []).includes(disposition.predecessorPlanId) && !known?.has(disposition.obligationId)) {
      errors.push(`unknown predecessor obligation ${key}`);
    }
    if ((disposition.disposition === 'keep' || disposition.disposition === 'change') && disposition.successorRefs.length === 0) {
      errors.push(`obligation ${key} ${disposition.disposition} requires successor_refs`);
    }
    for (const ref of disposition.successorRefs) {
      if (!successorRefs.has(ref)) errors.push(`obligation ${key} references unknown successor_ref ${ref}`);
    }
    if (disposition.disposition !== 'keep' && !disposition.rationale?.trim()) {
      errors.push(`obligation ${key} ${disposition.disposition} requires rationale`);
    }
  }
  for (const [predecessorId, obligations] of predecessorObligations) {
    const covered = new Set(dispositions.filter((entry) => entry.predecessorPlanId === predecessorId).map((entry) => entry.obligationId));
    for (const obligationId of obligations) {
      if (!covered.has(obligationId)) errors.push(`uncovered predecessor obligation ${predecessorId}:${obligationId}`);
    }
  }
  return [...new Set(errors)];
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

function writePlanSupersessionWithWorkRetirement(
  options: PlanContractStoreOptions,
  store: PlanContractStore,
  predecessor: PlanContract,
  successor: PlanContract,
  at: string,
): void {
  if (!sqliteBacked(options)) {
    writePlanContractStore(options, store);
    return;
  }

  // Enumerate candidate Work keys before entering the write transaction. Each
  // row is re-read under BEGIN IMMEDIATE, so concurrent Work progress either
  // becomes the value we retire or causes no lost update.
  const workRecords = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: options.repoId,
    limit: 5_000,
  }).filter((record) => record.value.planId === predecessor.planId);

  withControlPlaneTransaction(options.controllerHome, (database) => {
    for (const plan of [predecessor, successor]) {
      const current = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, plan.planId);
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract',
        scope: options.repoId,
        key: plan.planId,
        schemaVersion: 1,
        value: plan,
        action: plan.planId === predecessor.planId ? 'plan_contract_superseded' : 'plan_contract_successor_written',
        expectedRevision: current?.revision ?? null,
      });
    }

    for (const candidate of workRecords) {
      const current = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, candidate.key);
      if (!current || current.value.planId !== predecessor.planId || isTerminalWorkContractStatus(current.value.status)) continue;
      // A scope-only replan may atomically rebind an exact Work through the
      // dedicated replan API. Generic Plan replacement has no such transfer,
      // so every remaining predecessor-bound Work loses execution authority.
      const retired = retirePlanBoundWorkContract(current.value, {
        predecessorPlanId: predecessor.planId,
        successorPlanId: successor.planId,
        recordedAt: at,
        reason: predecessor.supersessionReason ?? 'owning Plan was superseded',
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract',
        scope: options.repoId,
        key: retired.workId,
        schemaVersion: 2,
        value: retired,
        action: 'work_plan_authority_retired',
        expectedRevision: current.revision,
      });
    }
  });
}

function buildPlanContract(input: CreatePlanContractInput, at: string): PlanContract {
  const planId = sanitizeFileComponent(input.planId);
  if (!String(input.planId ?? '').trim() || planId === 'unknown') throw new Error('plan_id is required');
  return {
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
    obligationDispositions: (input.obligationDispositions ?? []).slice(0, 512).map(normalizeObligationDisposition),
    createdAt: at,
    updatedAt: at,
  };
}

function draftContentErrors(plan: PlanContract): string[] {
  const errors: string[] = [];
  if (!plan.sourceRevision) errors.push('source_revision is required');
  if (!plan.scopeKey || plan.scopeKey === 'unknown') errors.push('scope_key is required');
  if (!plan.goal) errors.push('goal is required');
  if (plan.steps.length === 0) errors.push('at least one plan step is required');
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
  return [...new Set(errors)];
}

function createPlanContractUnlocked(options: PlanContractStoreOptions, input: CreatePlanContractInput): PlanContract {
  assertRequirementReference(options, input.requirementId);
  const at = nowIso(options);
  const plan = buildPlanContract(input, at);
  const store = readPlanContractStore(options);
  if (store.contracts.some((existing) => existing.planId === plan.planId)) {
    throw new Error(`plan contract already exists: ${plan.planId}`);
  }
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts: [plan, ...store.contracts] });
  return plan;
}

function replacePlanContractUnlocked(
  options: PlanContractStoreOptions,
  predecessorId: string,
  input: CreatePlanContractInput,
): PlanContract {
  assertRequirementReference(options, input.requirementId);
  const at = nowIso(options);
  const store = readPlanContractStore(options);
  const predecessorKey = sanitizeFileComponent(predecessorId);
  const predecessorIndex = store.contracts.findIndex((contract) => contract.planId === predecessorKey);
  if (predecessorIndex < 0) throw new Error(`plan contract not found: ${predecessorKey}`);
  const predecessor = store.contracts[predecessorIndex]!;
  if (isTerminalPlanContractStatus(predecessor.status)) throw new Error(`plan contract ${predecessor.planId} is terminal (${predecessor.status})`);
  const successor = {
    ...buildPlanContract(input, at),
    supersedes: [predecessor.planId],
  };
  if (successor.planId === predecessor.planId) throw new Error('PLAN_SUCCESSOR_ID_MUST_CHANGE');
  if (successor.repoId !== predecessor.repoId) throw new Error('PLAN_SUCCESSOR_REPOSITORY_MISMATCH');
  const continuityErrors = obligationContinuityErrors(successor, store.contracts);
  if (continuityErrors.length > 0) throw new Error(`PLAN_OBLIGATION_CONTINUITY_REQUIRED: ${continuityErrors.join('; ')}`);
  if (store.contracts.some((existing) => existing.planId === successor.planId)) {
    throw new Error(`plan contract already exists: ${successor.planId}`);
  }
  const conflictingScope = store.contracts.find((existing, index) => index !== predecessorIndex
    && !isTerminalPlanContractStatus(existing.status)
    && existing.scopeKey === successor.scopeKey);
  if (conflictingScope) throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${successor.scopeKey}:${conflictingScope.planId}`);
  const contracts = [...store.contracts];
  const predecessorNext: PlanContract = {
    ...predecessor,
    status: 'superseded',
    supersededBy: successor.planId,
    supersessionReason: 'extend_existing',
    updatedAt: at,
  };
  contracts[predecessorIndex] = predecessorNext;
  const nextStore = { schemaVersion: 1 as const, updatedAt: at, contracts: [successor, ...contracts] };
  writePlanSupersessionWithWorkRetirement(options, nextStore, predecessorNext, successor, at);
  return successor;
}

function repairDraftPlanContractUnlocked(
  options: PlanContractStoreOptions,
  planId: string,
  input: RepairDraftPlanContractInput,
): PlanContract {
  const store = readPlanContractStore(options);
  const key = sanitizeFileComponent(planId);
  const index = store.contracts.findIndex((contract) => contract.planId === key);
  if (index < 0) throw new Error(`plan contract not found: ${key}`);
  const current = store.contracts[index]!;
  if (current.status !== 'draft') throw new Error(`PLAN_DRAFT_REPAIR_STATUS_INVALID: ${current.planId}:${current.status}`);
  if (input.expectedSourceRevision !== undefined && current.sourceRevision !== input.expectedSourceRevision) {
    throw new Error(`PLAN_DRAFT_REPAIR_STALE_SOURCE: ${current.planId}:expected=${input.expectedSourceRevision}:actual=${current.sourceRevision}`);
  }
  assertRequirementReference(options, current.requirementId);
  const at = nowIso(options);
  const candidate = buildPlanContract({
    ...input,
    planId: current.planId,
    repoId: current.repoId,
    requirementId: current.requirementId,
    evidenceRefs: current.evidenceRefs,
  }, at);
  const contentErrors = draftContentErrors(candidate);
  if (contentErrors.length > 0) {
    throw new Error(`PLAN_DRAFT_REPAIR_INVALID: ${contentErrors.join('; ')}`);
  }
  const conflictingScope = store.contracts.find((existing, candidateIndex) => candidateIndex !== index
    && !isTerminalPlanContractStatus(existing.status)
    && existing.scopeKey === candidate.scopeKey);
  if (conflictingScope) throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${candidate.scopeKey}:${conflictingScope.planId}`);
  const repaired: PlanContract = {
    ...candidate,
    createdAt: current.createdAt,
    updatedAt: at,
  };
  const contracts = [...store.contracts];
  contracts[index] = repaired;
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
  return repaired;
}

export function repairDraftPlanContract(
  options: PlanContractStoreOptions,
  planId: string,
  input: RepairDraftPlanContractInput,
): PlanContract {
  return withPlanAdmissionLock(options, () => repairDraftPlanContractUnlocked(options, planId, input));
}

export async function repairDraftPlanContractAsync(
  options: PlanContractStoreOptions,
  planId: string,
  input: RepairDraftPlanContractInput,
): Promise<PlanContract> {
  return await withPlanAdmissionLockAsync(options, () => repairDraftPlanContractUnlocked(options, planId, input));
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
  if (resolution.admissionDecision === 'extend_existing' && resolution.plan) {
    const successor = replacePlanContractUnlocked(options, resolution.plan.planId, input);
    return { ...resolution, admissionDecision: 'create_new', plan: successor };
  }
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

export function isCurrentPlanContract(contract: PlanContract): boolean {
  return !isTerminalPlanContractStatus(contract.status) && !contract.supersededBy?.trim();
}

export function listPlanContracts(options: PlanContractStoreOptions & { status?: PlanContractStatus | 'active' | 'all'; limit?: number }): PlanContract[] {
  const status = options.status ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return readPlanContractStore(options).contracts
    .filter((contract) => status === 'all' || (status === 'active' ? isCurrentPlanContract(contract) : contract.status === status))
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
  const errors = draftContentErrors(plan).map((error) => `${error} before approval`);
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
  errors.push(...obligationContinuityErrors(plan, allPlans));
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

export function supersedePlanContract(options: PlanContractStoreOptions, planId: string, supersededBy: string, reason = 'explicit_supersession'): PlanContract {
  return withPlanAdmissionLock(options, () => {
    const store = readPlanContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
    if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
    const current = store.contracts[index]!;
    if (isTerminalPlanContractStatus(current.status)) throw new Error(`plan contract ${current.planId} is terminal (${current.status})`);
    const replacement = sanitizeFileComponent(supersededBy);
    if (!replacement || replacement === 'unknown') throw new Error('superseded_by is required');
    if (replacement === current.planId) throw new Error('PLAN_SUCCESSOR_ID_MUST_CHANGE');
    const successor = store.contracts.find((contract) => contract.planId === replacement);
    if (!successor) throw new Error(`PLAN_SUCCESSOR_NOT_FOUND: ${replacement}`);
    const successorCandidate = { ...successor, supersedes: [...new Set([...(successor.supersedes ?? []), current.planId])] };
    const continuityErrors = obligationContinuityErrors(successorCandidate, store.contracts);
    if (continuityErrors.length > 0) throw new Error(`PLAN_OBLIGATION_CONTINUITY_REQUIRED: ${continuityErrors.join('; ')}`);
    const at = nowIso(options);
    const boundedReason = String(reason ?? '').trim().slice(0, 500) || 'explicit_supersession';
    const next = {
      ...current,
      status: 'superseded' as const,
      supersededBy: successor.planId,
      supersessionReason: boundedReason,
      updatedAt: at,
    };
    const successorNext = {
      ...successorCandidate,
      updatedAt: at,
    };
    const contracts = [...store.contracts];
    contracts[index] = next;
    contracts[contracts.findIndex((contract) => contract.planId === successor.planId)] = successorNext;
    const nextStore = { schemaVersion: 1 as const, updatedAt: at, contracts };
    writePlanSupersessionWithWorkRetirement(options, nextStore, next, successorNext, at);
    return next;
  });
}

/**
 * Maintenance reconciliation for historical V2 state created before Plan ->
 * Work authority retirement was atomic. It terminalizes only non-terminal Work
 * whose bound Plan is already terminal; it never deletes history and never
 * touches Work bound to a current Plan.
 */
export function retireTerminalPlanBoundWorkAuthorities(options: PlanContractStoreOptions): string[] {
  if (!sqliteBacked(options)) return [];
  const terminalPlans = new Map(
    readPlanContractStore(options).contracts
      .filter((plan) => isTerminalPlanContractStatus(plan.status))
      .map((plan) => [plan.planId, plan] as const),
  );
  if (terminalPlans.size === 0) return [];
  const candidates = listControlPlaneRecords<WorkContract>(options.controllerHome, {
    namespace: 'work_contract',
    scope: options.repoId,
    limit: 5_000,
  }).filter((record) => record.value.planId && terminalPlans.has(record.value.planId) && !isTerminalWorkContractStatus(record.value.status));
  if (candidates.length === 0) return [];
  const retired: string[] = [];
  const at = nowIso(options);
  withControlPlaneTransaction(options.controllerHome, (database) => {
    for (const candidate of candidates) {
      const current = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, candidate.key);
      const planId = current?.value.planId;
      if (!current || !planId || isTerminalWorkContractStatus(current.value.status)) continue;
      const plan = terminalPlans.get(planId);
      if (!plan || !isTerminalPlanContractStatus(plan.status)) continue;
      const next = retirePlanBoundWorkContract(current.value, {
        predecessorPlanId: plan.planId,
        successorPlanId: plan.supersededBy,
        recordedAt: at,
        reason: `maintenance reconciliation: owning Plan is ${plan.status}`,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract',
        scope: options.repoId,
        key: next.workId,
        schemaVersion: 2,
        value: next,
        action: 'work_terminal_plan_authority_reconciled',
        expectedRevision: current.revision,
      });
      retired.push(next.workId);
    }
  });
  return retired.sort();
}

export interface ReplanActivePlanBoundWorkScopeInput {
  planId: string;
  stepId: string;
  workId: string;
  successorPlanId: string;
  sourceRevision: string;
  allowedPaths: string[];
  reason: string;
}

export interface ReplanActivePlanBoundWorkScopeResult {
  predecessor: PlanContract;
  successor: PlanContract;
  work: WorkContract;
}

/**
 * Atomically replace one executing Plan authority and move its exact active
 * Work binding to the successor. This repair is intentionally scope-only:
 * objective, acceptance, checks, forbidden paths, dependencies, and Work
 * identity remain unchanged; allowed paths may only widen.
 */
export function replanActivePlanBoundWorkScope(
  options: PlanContractStoreOptions,
  input: ReplanActivePlanBoundWorkScopeInput,
): ReplanActivePlanBoundWorkScopeResult {
  if (!sqliteBacked(options)) throw new Error('PLAN_WORK_REPLAN_REQUIRES_CONTROLLER_STORE');
  const predecessorId = sanitizeFileComponent(input.planId);
  const successorId = sanitizeFileComponent(input.successorPlanId);
  const stepId = sanitizeFileComponent(input.stepId);
  const workId = sanitizeFileComponent(input.workId);
  const sourceRevision = input.sourceRevision.trim();
  const reason = input.reason.trim();
  if (!successorId || successorId === 'unknown' || successorId === predecessorId) throw new Error('PLAN_SUCCESSOR_ID_MUST_CHANGE');
  if (!sourceRevision) throw new Error('PLAN_WORK_REPLAN_SOURCE_REVISION_REQUIRED');
  if (!reason) throw new Error('PLAN_WORK_REPLAN_REASON_REQUIRED');
  const requestedAllowedPaths = [...new Set(input.allowedPaths.map((value) => value.trim()).filter(Boolean))].slice(0, 50);

  return withPlanAdmissionLock(options, () => {
    const observed = getPlanContract(options, predecessorId);
    if (!observed) throw new Error(`plan contract not found: ${predecessorId}`);
    assertRequirementReference(options, observed.requirementId);
    return withControlPlaneTransaction(options.controllerHome, (database) => {
      const predecessorRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, predecessorId);
      if (!predecessorRecord) throw new Error(`plan contract not found: ${predecessorId}`);
      const predecessor = predecessorRecord.value;
      if (predecessor.supersededBy || isTerminalPlanContractStatus(predecessor.status)) {
        throw new Error(`PLAN_WORK_REPLAN_PREDECESSOR_TERMINAL: ${predecessor.planId}:${predecessor.status}`);
      }
      if (predecessor.status !== 'executing' && predecessor.status !== 'replanning') {
        throw new Error(`PLAN_WORK_REPLAN_STATUS_INVALID: ${predecessor.planId}:${predecessor.status}`);
      }
      if (readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, successorId)) {
        throw new Error(`plan contract already exists: ${successorId}`);
      }
      const stepIndex = predecessor.steps.findIndex((candidate) => candidate.id === stepId);
      if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${stepId}`);
      const step = predecessor.steps[stepIndex]!;
      if (step.status !== 'executing' || step.workId !== workId) {
        throw new Error(`PLAN_WORK_REPLAN_STEP_BINDING_MISMATCH: ${predecessor.planId}/${stepId}:${step.status}:${step.workId ?? 'none'}`);
      }
      for (const path of step.allowedPaths) {
        if (!requestedAllowedPaths.includes(path)) throw new Error(`PLAN_WORK_REPLAN_SCOPE_NARROWING_FORBIDDEN: ${path}`);
      }
      const widened = requestedAllowedPaths.some((path) => !step.allowedPaths.includes(path));
      if (!widened) throw new Error('PLAN_WORK_REPLAN_SCOPE_NOT_WIDENED');
      const workRecord = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, workId);
      if (!workRecord) throw new Error(`work contract not found: ${workId}`);
      const work = workRecord.value;
      if (work.requirementId !== predecessor.requirementId) throw new Error('PLAN_WORK_REPLAN_REQUIREMENT_MISMATCH');
      const at = nowIso(options);
      const steps = [...predecessor.steps];
      steps[stepIndex] = {
        ...step,
        allowedPaths: requestedAllowedPaths,
        evidenceRefs: [{
          title: 'scope-only Plan replan',
          summary: `${predecessor.planId} -> ${successorId}: ${reason}`.slice(0, 2_000),
          detailLevel: 'summary' as const,
        }, ...step.evidenceRefs].slice(0, 20),
      };
      const successor: PlanContract = {
        ...predecessor,
        planId: successorId,
        sourceRevision,
        status: 'executing',
        steps,
        supersedes: [predecessor.planId],
        supersededBy: undefined,
        supersessionReason: undefined,
        evidenceRefs: [{
          title: 'active Work scope replanned',
          summary: `${predecessor.planId}/${stepId} retained exact Work ${workId}; allowed-path authority widened without changing semantic acceptance or machine checks.`.slice(0, 2_000),
          detailLevel: 'summary' as const,
        }, ...predecessor.evidenceRefs].slice(0, 20),
        createdAt: at,
        updatedAt: at,
      };
      const predecessorNext: PlanContract = {
        ...predecessor,
        status: 'superseded',
        supersededBy: successorId,
        supersessionReason: reason.slice(0, 500),
        updatedAt: at,
      };
      const workNext = rebindPlanBoundWorkContract(work, {
        predecessorPlanId: predecessor.planId,
        successorPlanId: successorId,
        planStepId: stepId,
        planSourceRevision: sourceRevision,
        allowedPaths: requestedAllowedPaths,
        forbiddenPaths: step.forbiddenPaths,
        checks: step.checks,
        recordedAt: at,
        reason,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract', scope: options.repoId, key: predecessor.planId, schemaVersion: 1,
        value: predecessorNext, action: 'plan_work_scope_replan_predecessor', expectedRevision: predecessorRecord.revision,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract', scope: options.repoId, key: successor.planId, schemaVersion: 1,
        value: successor, action: 'plan_work_scope_replan_successor', expectedRevision: null,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract', scope: options.repoId, key: workNext.workId, schemaVersion: 2,
        value: workNext, action: 'plan_work_scope_replan_work_rebind', expectedRevision: workRecord.revision,
      });
      return { predecessor: predecessorNext, successor, work: workNext };
    });
  });
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
