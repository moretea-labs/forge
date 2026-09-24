import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  normalizePlanScopeKey,
  isPlanExtensionPredecessor,
  resolvePlanAdmission,
  withPlanAdmissionLock,
  withPlanAdmissionLockAsync,
  type PlanAdmissionRelation,
  type PlanAdmissionResolution,
} from './semantic-admission';
import {
  listControlPlaneRecords,
  listAllControlPlaneRecordsWithinTransaction,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../persistence/sqlite-store';
import { readRequirement } from '../persistence/requirement-store';
import {
  getWorkContract,
  canonicalizeWorkContractForAuthority,
  isDirectEditWorkCompletionReceipt,
  isRepositoryCompletionReceipt,
  rebindPlanBoundWorkContract,
  refreshPlanBoundWorkRevision,
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
  type PlanRevisionDraft,
  type PlanRevisionRecord,
  type PlanStep,
  type PlanStepDeliveryCarry,
} from './types';

export interface PlanContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface PlanContractStoreOptions extends PlanContractStoreLocation {
  now?: () => string;
  /** Prove that one delivered Git revision is contained in a later Plan source. Missing/failed proof is fail-closed. */
  revisionContains?: (ancestorRevision: string, descendantRevision: string) => boolean;
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
  revision: number;
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

export function currentPlanRevision(plan: PlanContract): number {
  const revision = Number(plan.revision);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

export function currentPlanSemanticRevision(plan: PlanContract): number {
  const revision = Number(plan.semanticRevision);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

export interface PlanSemanticView {
  planId: string;
  revision: number;
  repoId: string;
  requirementId?: string;
  requirementBasisRevision?: number;
  sourceBasisRevision: string;
  goal: string;
  nonGoals: string[];
  assumptions: string[];
  resolvedDecisions: string[];
  stopConditions: string[];
  replanConditions: string[];
  integrationStrategy?: string;
  items: Array<{ id: string; objective: string; dependencies: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export interface PlanSemanticRevisionRecord extends PlanSemanticView {
  schemaVersion: 1;
  recordedAt: string;
}

export interface RevisePlanSemanticInput {
  expectedRevision: number;
  requirementBasisRevision?: number;
  sourceBasisRevision?: string;
  goal?: string;
  nonGoals?: string[];
  assumptions?: string[];
  resolvedDecisions?: string[];
  stopConditions?: string[];
  replanConditions?: string[];
  integrationStrategy?: string | null;
  items?: Array<{ id: string; objective: string; dependencies?: string[] }>;
}

function legacyPlanSemanticContext(plan: PlanContract) {
  return {
    requirementBasisRevision: undefined,
    sourceBasisRevision: plan.sourceRevision,
    goal: plan.goal,
    nonGoals: [...plan.nonGoals],
    assumptions: [...plan.assumptions],
    resolvedDecisions: [...plan.resolvedDecisions],
    stopConditions: [...plan.stopConditions],
    replanConditions: [...plan.replanConditions],
    integrationStrategy: plan.integrationStrategy,
    items: plan.steps.map((step) => ({ id: step.id, objective: step.objective, dependencies: [...step.dependencies] })),
  };
}

export function planSemanticView(plan: PlanContract): PlanSemanticView {
  const semantic = plan.semanticContext ?? legacyPlanSemanticContext(plan);
  return {
    planId: plan.planId,
    revision: currentPlanSemanticRevision(plan),
    repoId: plan.repoId,
    requirementId: plan.requirementId,
    requirementBasisRevision: semantic.requirementBasisRevision,
    sourceBasisRevision: semantic.sourceBasisRevision,
    goal: semantic.goal,
    nonGoals: [...semantic.nonGoals],
    assumptions: [...semantic.assumptions],
    resolvedDecisions: [...semantic.resolvedDecisions],
    stopConditions: [...semantic.stopConditions],
    replanConditions: [...semantic.replanConditions],
    integrationStrategy: semantic.integrationStrategy,
    items: semantic.items.map((item) => ({ id: item.id, objective: item.objective, dependencies: [...item.dependencies] })),
    createdAt: plan.createdAt,
    updatedAt: plan.semanticUpdatedAt ?? plan.createdAt,
  };
}

interface PlanRevisionRecordStore {
  schemaVersion: 1;
  updatedAt: string;
  revisions: PlanRevisionRecord[];
}

interface PlanSemanticRevisionStore {
  schemaVersion: 1;
  updatedAt: string;
  revisions: PlanSemanticRevisionRecord[];
}

interface PlanExecutionBaselineRecord {
  schemaVersion: 1;
  repoId: string;
  planId: string;
  semanticSourceRevision: string;
  executionBaselineRevision: string;
  updatedAt: string;
}

interface PlanExecutionBaselineStore {
  schemaVersion: 1;
  updatedAt: string;
  baselines: PlanExecutionBaselineRecord[];
}

function planRevisionRecordKey(planId: string, revision: number): string {
  return `${sanitizeFileComponent(planId)}:r${revision}`;
}

function projectDependencyReadySteps(steps: readonly PlanStep[]): PlanStep[] {
  const completed = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
  return steps.map((step) => step.status === 'pending'
    && step.dependencies.every((dependencyId) => completed.has(dependencyId))
    ? { ...step, status: 'ready' as const }
    : step);
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

function listPlanObligations(plan: PlanContract, mode: 'unresolved' | 'completed_steps'): PlanObligation[] {
  const out: PlanObligation[] = [];
  const add = (kind: PlanObligation['kind'], sourceRef: string, summary: string) => {
    const normalized = summary.trim();
    if (!normalized) return;
    out.push({ obligationId: planObligationId(plan.planId, kind, sourceRef, normalized), predecessorPlanId: plan.planId, kind, sourceRef, summary: normalized });
  };
  for (const step of plan.steps) {
    if (mode === 'unresolved' && step.status === 'completed') continue;
    if (mode === 'completed_steps' && step.status !== 'completed') continue;
    add('step_objective', `step:${step.id}`, step.objective);
    step.acceptanceCriteria.forEach((criterion, index) => add('step_acceptance', `step:${step.id}:acceptance:${index}`, criterion));
  }
  if (mode === 'unresolved') {
    plan.nonGoals.forEach((value, index) => add('non_goal', `non_goal:${index}`, value));
    plan.resolvedDecisions.forEach((value, index) => add('resolved_decision', `resolved_decision:${index}`, value));
    plan.stopConditions.forEach((value, index) => add('stop_condition', `stop_condition:${index}`, value));
    plan.replanConditions.forEach((value, index) => add('replan_condition', `replan_condition:${index}`, value));
  }
  return out;
}

export function listUnresolvedPlanObligations(plan: PlanContract): PlanObligation[] {
  return listPlanObligations(plan, 'unresolved');
}

function retireResolvedPredecessorObligationDispositions(
  plan: PlanContract,
  allPlans: readonly PlanContract[],
): PlanContract {
  const dispositions = plan.obligationDispositions ?? [];
  if (dispositions.length === 0 || (plan.supersedes?.length ?? 0) === 0) return plan;
  const resolvedByPredecessor = new Map<string, Set<string>>();
  for (const predecessorId of plan.supersedes ?? []) {
    const predecessor = allPlans.find((candidate) => candidate.planId === predecessorId);
    if (!predecessor) continue;
    resolvedByPredecessor.set(
      predecessorId,
      new Set(listPlanObligations(predecessor, 'completed_steps').map((obligation) => obligation.obligationId)),
    );
  }
  const retained = dispositions.filter((disposition) =>
    !resolvedByPredecessor.get(disposition.predecessorPlanId)?.has(disposition.obligationId));
  return retained.length === dispositions.length ? plan : { ...plan, obligationDispositions: retained };
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

function updatePlanContractWithExecutionBaseline(
  options: PlanContractStoreOptions,
  planId: string,
  mutate: (current: PlanContract, executionBaselineRevision: string) => { plan: PlanContract; executionBaselineRevision: string },
): PlanContract {
  const key = sanitizeFileComponent(planId);
  const apply = (): PlanContract => {
    const store = readPlanContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.planId === key);
    if (index < 0) throw new Error(`plan contract not found: ${key}`);
    const current = store.contracts[index]!;
    const currentBaseline = getPlanExecutionBaselineRevision(options, current);
    const next = mutate(current, currentBaseline);
    const baseline: PlanExecutionBaselineRecord = {
      schemaVersion: 1, repoId: current.repoId, planId: current.planId, semanticSourceRevision: next.plan.sourceRevision,
      executionBaselineRevision: next.executionBaselineRevision.trim() || next.plan.sourceRevision, updatedAt: next.plan.updatedAt,
    };
    if (!sqliteBacked(options)) {
      const baselineStore = readJsonFile<PlanExecutionBaselineStore>(planExecutionBaselineStorePath(options), {
        schemaVersion: 1, updatedAt: baseline.updatedAt, baselines: [],
      });
      const baselineIndex = baselineStore.baselines.findIndex((record) => record.planId === key);
      const baselines = [...baselineStore.baselines];
      if (baselineIndex >= 0) baselines[baselineIndex] = baseline; else baselines.unshift(baseline);
      writeJsonAtomic(planExecutionBaselineStorePath(options), { schemaVersion: 1, updatedAt: baseline.updatedAt, baselines });
      const contracts = [...store.contracts];
      contracts[index] = next.plan;
      writePlanContractStore(options, { schemaVersion: 1, updatedAt: next.plan.updatedAt, contracts });
      return next.plan;
    }
    return withControlPlaneTransaction(options.controllerHome!, (database) => {
      const planRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId!, key);
      if (!planRecord || JSON.stringify(planRecord.value) !== JSON.stringify(current)) throw new Error(`PLAN_EXECUTION_BASELINE_STALE: ${key}`);
      const baselineRecord = readControlPlaneRecordWithinTransaction<PlanExecutionBaselineRecord>(database, 'plan_execution_baseline', options.repoId!, key);
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract', scope: options.repoId!, key, schemaVersion: 1, value: next.plan,
        action: 'plan_contract_execution_claim', expectedRevision: planRecord.revision,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_execution_baseline', scope: options.repoId!, key, schemaVersion: 1, value: baseline,
        action: 'plan_execution_baseline_write', expectedRevision: baselineRecord?.revision ?? null,
      });
      return next.plan;
    });
  };
  if (!options.controllerHome || !options.repoId) return apply();
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `plan-${key}` },
    'plan-contract-execution-baseline',
    apply,
    15_000,
  );
}

function assertRequirementReference(options: PlanContractStoreOptions, requirementId: string | undefined): void {
  const normalized = requirementId?.trim();
  if (!normalized || !options.controllerHome) return;
  const requirement = readRequirement({ controllerHome: options.controllerHome, now: options.now }, normalized)?.value;
  if (!requirement) throw new Error(`PLAN_REQUIREMENT_NOT_FOUND: ${normalized}`);
  if (requirement.state === 'done' || requirement.state === 'cancelled') {
    throw new Error(`PLAN_REQUIREMENT_TERMINAL: ${normalized}:${requirement.state}`);
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

function planExecutionBaselineStorePath(location: PlanContractStoreLocation): string {
  return join(planContractRoot(location), 'execution-baselines.json');
}

function readPlanExecutionBaselineRecord(options: PlanContractStoreOptions, planId: string): PlanExecutionBaselineRecord | undefined {
  const key = sanitizeFileComponent(planId);
  if (sqliteBacked(options)) {
    return listControlPlaneRecords<PlanExecutionBaselineRecord>(options.controllerHome!, {
      namespace: 'plan_execution_baseline', scope: options.repoId!, limit: 5_000,
    }).map((record) => record.value).find((record) => record.planId === key);
  }
  const store = readJsonFile<PlanExecutionBaselineStore>(planExecutionBaselineStorePath(options), {
    schemaVersion: 1, updatedAt: nowIso(options), baselines: [],
  });
  return store.baselines.find((record) => record.planId === key);
}

function persistedPlanExecutionBaselineRevision(options: PlanContractStoreOptions, plan: PlanContract): string {
  const record = readPlanExecutionBaselineRecord(options, plan.planId);
  return record?.semanticSourceRevision === plan.sourceRevision && record.executionBaselineRevision.trim()
    ? record.executionBaselineRevision.trim()
    : plan.sourceRevision;
}

export function getPlanExecutionBaselineRevision(options: PlanContractStoreOptions, planOrId: PlanContract | string): string {
  const plan = typeof planOrId === 'string' ? getPlanContract(options, planOrId) : planOrId;
  if (!plan) throw new Error(`plan contract not found: ${sanitizeFileComponent(String(planOrId))}`);
  const activeStep = plan.steps.find((step) => (step.status === 'executing' || step.status === 'validating') && step.workId);
  if (options.controllerHome && options.repoId && activeStep?.workId) {
    const work = getWorkContract(options, activeStep.workId);
    const frozenBase = work?.baseRevision?.trim();
    if (frozenBase && work?.planId === plan.planId && work.planStepId === activeStep.id) return frozenBase;
  }
  return persistedPlanExecutionBaselineRevision(options, plan);
}

export function planRevisionStorePath(location: PlanContractStoreLocation): string {
  return join(planContractRoot(location), 'revisions.json');
}

function planSemanticRevisionStorePath(location: PlanContractStoreLocation): string {
  return join(planContractRoot(location), 'semantic-revisions.json');
}

export function listPlanRevisionRecords(
  options: PlanContractStoreOptions,
  planId?: string,
): PlanRevisionRecord[] {
  const normalizedPlanId = planId ? sanitizeFileComponent(planId) : undefined;
  if (!sqliteBacked(options)) {
    const store = readJsonFile<PlanRevisionRecordStore>(planRevisionStorePath(options), { schemaVersion: 1, updatedAt: nowIso(options), revisions: [] });
    return store.revisions
      .filter((record) => !normalizedPlanId || record.planId === normalizedPlanId)
      .sort((left, right) => right.revision - left.revision);
  }
  return listControlPlaneRecords<PlanRevisionRecord>(options.controllerHome, {
    namespace: 'plan_revision', scope: options.repoId, limit: 5_000,
  }).map((record) => record.value)
    .filter((record) => !normalizedPlanId || record.planId === normalizedPlanId)
    .sort((left, right) => right.revision - left.revision);
}

function appendJsonPlanRevisionRecord(options: PlanContractStoreOptions, record: PlanRevisionRecord): void {
  const path = planRevisionStorePath(options);
  const store = readJsonFile<PlanRevisionRecordStore>(path, { schemaVersion: 1, updatedAt: record.recordedAt, revisions: [] });
  if (store.revisions.some((existing) => existing.planId === record.planId && existing.revision === record.revision)) {
    throw new Error(`PLAN_REVISION_ALREADY_EXISTS: ${record.planId}:r${record.revision}`);
  }
  writeJsonAtomic(path, { schemaVersion: 1, updatedAt: record.recordedAt, revisions: [record, ...store.revisions] });
}

export function listPlanSemanticRevisionRecords(options: PlanContractStoreOptions, planId?: string): PlanSemanticRevisionRecord[] {
  const normalizedPlanId = planId ? sanitizeFileComponent(planId) : undefined;
  if (!sqliteBacked(options)) {
    const store = readJsonFile<PlanSemanticRevisionStore>(planSemanticRevisionStorePath(options), { schemaVersion: 1, updatedAt: nowIso(options), revisions: [] });
    return store.revisions.filter((record) => !normalizedPlanId || record.planId === normalizedPlanId)
      .sort((left, right) => right.revision - left.revision);
  }
  return listControlPlaneRecords<PlanSemanticRevisionRecord>(options.controllerHome, {
    namespace: 'plan_semantic_revision', scope: options.repoId, limit: 5_000,
  }).map((record) => record.value)
    .filter((record) => !normalizedPlanId || record.planId === normalizedPlanId)
    .sort((left, right) => right.revision - left.revision);
}

function appendJsonPlanSemanticRevisionRecord(options: PlanContractStoreOptions, record: PlanSemanticRevisionRecord): void {
  const path = planSemanticRevisionStorePath(options);
  const store = readJsonFile<PlanSemanticRevisionStore>(path, { schemaVersion: 1, updatedAt: record.recordedAt, revisions: [] });
  if (store.revisions.some((existing) => existing.planId === record.planId && existing.revision === record.revision)) return;
  writeJsonAtomic(path, { schemaVersion: 1, updatedAt: record.recordedAt, revisions: [record, ...store.revisions].slice(0, 5_000) });
}
function planRevisionRecord(plan: PlanContract, input: { recordedAt: string; reason: string; requestedRevisionLabel?: string }): PlanRevisionRecord {
  return {
    schemaVersion: 1, repoId: plan.repoId, planId: plan.planId, revision: currentPlanRevision(plan),
    requirementId: plan.requirementId, scopeKey: plan.scopeKey, sourceRevision: plan.sourceRevision, goal: plan.goal,
    nonGoals: [...plan.nonGoals], assumptions: [...plan.assumptions], resolvedDecisions: [...plan.resolvedDecisions],
    stopConditions: [...plan.stopConditions], replanConditions: [...plan.replanConditions], integrationStrategy: plan.integrationStrategy,
    status: plan.status, steps: structuredClone(plan.steps), evidenceRefs: structuredClone(plan.evidenceRefs),
    obligationDispositions: plan.obligationDispositions ? structuredClone(plan.obligationDispositions) : undefined,
    recordedAt: input.recordedAt, reason: input.reason.slice(0, 1_000), requestedRevisionLabel: input.requestedRevisionLabel,
  };
}

function revisionDraftFromCandidate(candidate: PlanContract, input: { requestedRevisionLabel?: string; createdAt: string; updatedAt: string }): PlanRevisionDraft {
  return {
    revision: currentPlanRevision(candidate), requestedRevisionLabel: input.requestedRevisionLabel,
    sourceRevision: candidate.sourceRevision, goal: candidate.goal, nonGoals: [...candidate.nonGoals], assumptions: [...candidate.assumptions],
    resolvedDecisions: [...candidate.resolvedDecisions], stopConditions: [...candidate.stopConditions], replanConditions: [...candidate.replanConditions],
    integrationStrategy: candidate.integrationStrategy, steps: structuredClone(candidate.steps),
    obligationDispositions: candidate.obligationDispositions ? structuredClone(candidate.obligationDispositions) : undefined,
    deliveryCarries: candidate.deliveryCarries ? structuredClone(candidate.deliveryCarries) : undefined,
    createdAt: input.createdAt, updatedAt: input.updatedAt,
  };
}

function planFromPendingRevision(current: PlanContract, pending: PlanRevisionDraft, at: string): PlanContract {
  return {
    ...current, revision: pending.revision, sourceRevision: pending.sourceRevision, goal: pending.goal, nonGoals: [...pending.nonGoals],
    assumptions: [...pending.assumptions], resolvedDecisions: [...pending.resolvedDecisions], stopConditions: [...pending.stopConditions],
    replanConditions: [...pending.replanConditions], integrationStrategy: pending.integrationStrategy, steps: structuredClone(pending.steps),
    obligationDispositions: pending.obligationDispositions ? structuredClone(pending.obligationDispositions) : undefined,
    deliveryCarries: pending.deliveryCarries ? structuredClone(pending.deliveryCarries) : undefined,
    pendingRevision: undefined, updatedAt: at,
  };
}

function revisionContinuityErrors(current: PlanContract, candidate: PlanContract, allPlans: readonly PlanContract[]): string[] {
  const validationCandidate: PlanContract = { ...candidate, supersedes: [current.planId] };
  return obligationContinuityErrors(validationCandidate, allPlans);
}

function retireResolvedRevisionObligationDispositions(current: PlanContract, candidate: PlanContract): PlanContract {
  const dispositions = candidate.obligationDispositions ?? [];
  if (dispositions.length === 0) return candidate;
  const completed = new Set(listPlanObligations(current, 'completed_steps').map((obligation) => obligation.obligationId));
  if (completed.size === 0) return candidate;
  const retained = dispositions.filter((disposition) => !(disposition.predecessorPlanId === current.planId && completed.has(disposition.obligationId)));
  return retained.length === dispositions.length ? candidate : { ...candidate, obligationDispositions: retained };
}

function assertRevisionScopeAuthority(current: PlanContract, allPlans: readonly PlanContract[]): void {
  const conflicting = allPlans.find((plan) => plan.planId !== current.planId
    && !isTerminalPlanContractStatus(plan.status) && plan.scopeKey === current.scopeKey);
  if (conflicting) throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${current.scopeKey}:${conflicting.planId}`);
}

function deriveRequiredRevisionDeliveryCarries(
  options: PlanContractStoreOptions,
  current: PlanContract,
  candidate: PlanContract,
  at: string,
): PlanStepDeliveryCarry[] {
  const carries = derivePlanStepDeliveryCarries(options, current, candidate, at);
  // A validating projection backed by a still-completed Work but missing its
  // immutable completion receipt is corrupt and cannot be silently downgraded.
  // A changed execution contract, failed/cancelled Work, or a successor source
  // that does not contain the delivered revision simply means "do not carry".
  for (const previousStep of current.steps) {
    if (previousStep.status !== 'validating' || !previousStep.workId) continue;
    const nextStep = candidate.steps.find((step) => step.id === previousStep.id);
    if (!nextStep || !samePlanStepExecutionContract(previousStep, nextStep)) continue;
    if (!acceptanceChangesExplicitlyReconciled(current, previousStep, candidate, nextStep)) continue;
    const work = getWorkContract(options, previousStep.workId);
    if (work?.status === 'completed' && !work.completionReceipt) {
      throw new Error(`PLAN_DELIVERY_CARRY_RECEIPT_REQUIRED: ${current.planId}/${previousStep.id}`);
    }
  }
  return carries;
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
      // SQLite is authoritative per Plan row. A sibling Plan appearing in an
      // aggregate compatibility snapshot is not itself a mutation.
      if (current && JSON.stringify(current.value) === JSON.stringify(contract)) continue;
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
): PlanContract {
  if (!sqliteBacked(options)) {
    writePlanContractStore(options, store);
    return successor;
  }

  let writtenSuccessor = successor;

  withControlPlaneTransaction(options.controllerHome, (database) => {
    let successorNext = successor;
    const workWrites: Array<{ value: WorkContract; revision: number; action: string }> = [];
    const workRecords = listAllControlPlaneRecordsWithinTransaction<WorkContract>(database, {
      namespace: 'work_contract', scope: options.repoId,
    }).filter((record) => record.value.planId === predecessor.planId);
    for (const current of workRecords) {
      if (isTerminalWorkContractStatus(current.value.status)) continue;
      const predecessorStep = predecessor.steps.find((step) => workMatchesPlanStep(current.value, predecessor, step));
      const successorIndex = predecessorStep ? successorNext.steps.findIndex((step) => step.id === predecessorStep.id) : -1;
      const successorStep = successorIndex >= 0 ? successorNext.steps[successorIndex] : undefined;
      if (predecessorStep && successorStep
        && samePlanStepExecutionContract(predecessorStep, successorStep)
        && sameOrderedStrings(predecessorStep.acceptanceCriteria, successorStep.acceptanceCriteria)) {
        const rebound = rebindPlanBoundWorkContract(current.value, {
          predecessorPlanId: predecessor.planId, successorPlanId: successorNext.planId, planStepId: successorStep.id,
          planSourceRevision: successorNext.sourceRevision, allowedPaths: successorStep.allowedPaths, forbiddenPaths: successorStep.forbiddenPaths,
          checks: successorStep.checks, recordedAt: at, reason: 'Plan successor preserved this exact active Work contract.',
        });
        const steps = [...successorNext.steps];
        steps[successorIndex] = {
          ...successorStep, status: 'executing', workId: rebound.workId,
          evidenceRefs: [{ title: 'active Work carried to successor', summary: `Rebound exact Work ${rebound.workId} from ${predecessor.planId}; successor approval changed no Work contract semantics.`, detailLevel: 'summary' as const }, ...predecessorStep.evidenceRefs].slice(0, 20),
        };
        successorNext = { ...successorNext, status: 'executing', steps, updatedAt: at };
        workWrites.push({ value: rebound, revision: current.revision, action: 'work_plan_authority_rebound' });
        continue;
      }
      const retired = retirePlanBoundWorkContract(current.value, {
        predecessorPlanId: predecessor.planId, successorPlanId: successorNext.planId, recordedAt: at,
        reason: predecessor.supersessionReason ?? 'owning Plan was superseded',
      });
      workWrites.push({ value: retired, revision: current.revision, action: 'work_plan_authority_retired' });
    }

    for (const plan of [predecessor, successorNext]) {
      const current = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, plan.planId);
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract', scope: options.repoId, key: plan.planId, schemaVersion: 1, value: plan,
        action: plan.planId === predecessor.planId ? 'plan_contract_superseded' : 'plan_contract_successor_written',
        expectedRevision: current?.revision ?? null,
      });
    }
    for (const write of workWrites) {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract', scope: options.repoId, key: write.value.workId, schemaVersion: 2, value: write.value,
        action: write.action, expectedRevision: write.revision,
      });
    }
    writtenSuccessor = successorNext;
  });
  return writtenSuccessor;
}

function buildPlanContract(input: CreatePlanContractInput, at: string): PlanContract {
  const planId = sanitizeFileComponent(input.planId);
  if (!String(input.planId ?? '').trim() || planId === 'unknown') throw new Error('plan_id is required');
  return {
    schemaVersion: 1,
    planId,
    revision: 1,
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

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePlanStepExecutionContract(predecessor: PlanStep, successor: PlanStep): boolean {
  return predecessor.id === successor.id
    && predecessor.objective === successor.objective
    && sameOrderedStrings(predecessor.dependencies, successor.dependencies)
    && sameOrderedStrings(predecessor.authoritativeFiles, successor.authoritativeFiles)
    && sameOrderedStrings(predecessor.allowedPaths, successor.allowedPaths)
    && sameOrderedStrings(predecessor.forbiddenPaths, successor.forbiddenPaths)
    && sameOrderedStrings(predecessor.checks, successor.checks);
}

function workMatchesPlanStep(work: WorkContract, plan: PlanContract, step: PlanStep): boolean {
  return step.status === 'executing' && work.planId === plan.planId && work.planStepId === step.id && step.workId === work.workId
    && work.requirementId === plan.requirementId && work.planSourceRevision === plan.sourceRevision
    && work.objective === step.objective
    && sameOrderedStrings(work.acceptanceCriteria, step.acceptanceCriteria)
    && sameOrderedStrings(work.allowedPaths, step.allowedPaths)
    && sameOrderedStrings(work.forbiddenPaths, step.forbiddenPaths)
    && sameOrderedStrings(work.checks, step.checks);
}

function hasCoherentActivePlanBoundWork(options: PlanContractStoreOptions, plan: PlanContract): boolean {
  if (!sqliteBacked(options)) return false;
  return listControlPlaneRecords<WorkContract>(options.controllerHome, { namespace: 'work_contract', scope: options.repoId, limit: 5_000 })
    .some(({ value: work }) => !isTerminalWorkContractStatus(work.status)
      && plan.steps.some((step) => workMatchesPlanStep(work, plan, step)));
}

function acceptanceChangesExplicitlyReconciled(
  predecessorPlan: PlanContract,
  predecessorStep: PlanStep,
  successorPlan: PlanContract,
  successorStep: PlanStep,
): boolean {
  if (sameOrderedStrings(predecessorStep.acceptanceCriteria, successorStep.acceptanceCriteria)) return true;
  const obligations = listUnresolvedPlanObligations(predecessorPlan)
    .filter((entry) => entry.kind === 'step_acceptance' && entry.sourceRef.startsWith(`step:${predecessorStep.id}:acceptance:`));
  const dispositions = successorPlan.obligationDispositions ?? [];
  const dispositionFor = (obligationId: string) => dispositions.find((entry) =>
    entry.predecessorPlanId === predecessorPlan.planId && entry.obligationId === obligationId);

  for (const obligation of obligations) {
    if (successorStep.acceptanceCriteria.includes(obligation.summary)) continue;
    const disposition = dispositionFor(obligation.obligationId);
    if (!disposition || disposition.disposition === 'keep' || !disposition.rationale?.trim()) return false;
  }
  for (let index = 0; index < successorStep.acceptanceCriteria.length; index += 1) {
    const criterion = successorStep.acceptanceCriteria[index]!;
    if (predecessorStep.acceptanceCriteria.includes(criterion)) continue;
    const successorRef = `step:${successorStep.id}:acceptance:${index}`;
    const explicitlyChanged = obligations.some((obligation) => {
      const disposition = dispositionFor(obligation.obligationId);
      return disposition?.disposition === 'change'
        && Boolean(disposition.rationale?.trim())
        && disposition.successorRefs.includes(successorRef);
    });
    if (!explicitlyChanged) return false;
  }
  return true;
}

function deliveryCarryForStep(
  options: PlanContractStoreOptions,
  predecessorPlan: PlanContract,
  predecessorStep: PlanStep,
  successorPlan: PlanContract,
  successorStep: PlanStep,
  recordedAt: string,
): PlanStepDeliveryCarry | undefined {
  if (!samePlanStepExecutionContract(predecessorStep, successorStep)) return undefined;
  if (!acceptanceChangesExplicitlyReconciled(predecessorPlan, predecessorStep, successorPlan, successorStep)) return undefined;
  if (!predecessorPlan.requirementId || successorPlan.requirementId !== predecessorPlan.requirementId) return undefined;

  if (!options.controllerHome || !options.repoId) return undefined;
  const exactHistoricalWorks = listControlPlaneRecords<WorkContract>(
    options.controllerHome,
    { namespace: 'work_contract', scope: options.repoId, limit: 5_000 },
  ).map((record) => record.value).filter((candidate) =>
    candidate.status === 'completed'
    && candidate.planId === predecessorPlan.planId
    && candidate.planStepId === predecessorStep.id
    && candidate.requirementId === predecessorPlan.requirementId
    && candidate.planSourceRevision === predecessorPlan.sourceRevision
    && candidate.objective === predecessorStep.objective
    && sameOrderedStrings(candidate.acceptanceCriteria, predecessorStep.acceptanceCriteria)
    && sameOrderedStrings(candidate.allowedPaths, predecessorStep.allowedPaths)
    && sameOrderedStrings(candidate.forbiddenPaths, predecessorStep.forbiddenPaths)
    && sameOrderedStrings(candidate.checks, predecessorStep.checks)
  );
  const work = predecessorStep.workId
    ? getWorkContract(options, predecessorStep.workId)
    : exactHistoricalWorks.length === 1
      ? exactHistoricalWorks[0]
      : undefined;
  if (!work
    || work.status !== 'completed'
    || work.phase !== 'cleanup'
    || work.evidenceState !== 'valid'
    || !work.completionOutcome
    || work.completionOutcome === 'superseded'
    || work.requirementId !== predecessorPlan.requirementId
    || work.planId !== predecessorPlan.planId
    || work.planStepId !== predecessorStep.id
    || work.planSourceRevision !== predecessorPlan.sourceRevision
    || !work.completionReceipt) return undefined;

  const receipt = work.completionReceipt;
  if (!isRepositoryCompletionReceipt(receipt) && !isDirectEditWorkCompletionReceipt(receipt)) return undefined;
  if (receipt.workId !== work.workId
    || receipt.delivery.status !== 'integrated'
    || !receipt.delivery.reachable
    || receipt.cleanup.status === 'blocked') return undefined;
  const targetRevision = receipt.targetRevision.trim();
  const successorSourceRevision = successorPlan.sourceRevision.trim();
  if (!targetRevision || !successorSourceRevision) return undefined;
  if (targetRevision !== successorSourceRevision) {
    try {
      if (options.revisionContains?.(targetRevision, successorSourceRevision) !== true) return undefined;
    } catch {
      return undefined;
    }
  }

  return {
    predecessorPlanId: predecessorPlan.planId,
    predecessorStepId: predecessorStep.id,
    successorStepId: successorStep.id,
    workId: work.workId,
    completionReceiptId: receipt.receiptId,
    deliveredSourceRevision: targetRevision,
    recordedAt,
  };
}

function derivePlanStepDeliveryCarries(
  options: PlanContractStoreOptions,
  predecessorPlan: PlanContract,
  successorPlan: PlanContract,
  recordedAt: string,
): PlanStepDeliveryCarry[] {
  return successorPlan.steps.flatMap((successorStep) => {
    const predecessorStep = predecessorPlan.steps.find((candidate) => candidate.id === successorStep.id);
    if (!predecessorStep) return [];
    const carry = deliveryCarryForStep(options, predecessorPlan, predecessorStep, successorPlan, successorStep, recordedAt);
    return carry ? [carry] : [];
  });
}

function materializePlanStepDeliveryCarries(
  options: PlanContractStoreOptions,
  plan: PlanContract,
  allPlans: readonly PlanContract[],
): { steps: PlanStep[]; carriedCount: number } {
  if (!plan.deliveryCarries?.length) return { steps: plan.steps, carriedCount: 0 };
  const carriedSteps = new Set<string>();
  const steps = plan.steps.map((step) => ({ ...step }));
  for (const carry of plan.deliveryCarries) {
    if (carriedSteps.has(carry.successorStepId)) throw new Error(`PLAN_DELIVERY_CARRY_DUPLICATE_STEP: ${carry.successorStepId}`);
    const predecessorPlan = allPlans.find((candidate) => candidate.planId === carry.predecessorPlanId);
    const predecessorStep = predecessorPlan?.steps.find((candidate) => candidate.id === carry.predecessorStepId);
    const successorIndex = steps.findIndex((candidate) => candidate.id === carry.successorStepId);
    const successorStep = successorIndex >= 0 ? steps[successorIndex] : undefined;
    if (!predecessorPlan || !predecessorStep || !successorStep) throw new Error(`PLAN_DELIVERY_CARRY_INVALID: ${carry.successorStepId}`);
    const expected = deliveryCarryForStep(options, predecessorPlan, predecessorStep, plan, successorStep, carry.recordedAt);
    if (!expected
      || expected.workId !== carry.workId
      || expected.completionReceiptId !== carry.completionReceiptId
      || expected.deliveredSourceRevision !== carry.deliveredSourceRevision) {
      throw new Error(`PLAN_DELIVERY_CARRY_INVALID: ${carry.successorStepId}`);
    }
    steps[successorIndex] = {
      ...successorStep,
      status: 'validating',
      workId: carry.workId,
      evidenceRefs: [{
        evidenceId: carry.completionReceiptId,
        title: 'successor delivery carried',
        summary: `Reused immutable delivery from ${carry.predecessorPlanId}/${carry.predecessorStepId}; semantic acceptance remains explicit.`,
        detailLevel: 'summary' as const,
      }, ...predecessorStep.evidenceRefs].slice(0, 20),
    };
    carriedSteps.add(carry.successorStepId);
  }
  return { steps, carriedCount: carriedSteps.size };
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
  const current = store.contracts[predecessorIndex]!;
  if (!isPlanExtensionPredecessor(current)) throw new Error(`plan contract ${current.planId} is terminal (${current.status})`);

  // Before approval Plan identity is already provisional, so an extension simply
  // repairs that exact draft instead of minting an r2/r3 entity.
  if (current.status === 'draft') {
    const draftCandidate = buildPlanContract({
      ...input,
      planId: current.planId,
      repoId: current.repoId,
      requirementId: current.requirementId,
      scopeKey: current.scopeKey,
    }, at);
    const continuityErrors = revisionContinuityErrors(current, draftCandidate, store.contracts);
    if (continuityErrors.length > 0) {
      throw new Error(`PLAN_OBLIGATION_CONTINUITY_REQUIRED: ${continuityErrors.join('; ')}`);
    }
    return repairDraftPlanContractUnlocked(options, current.planId, {
      scopeKey: input.scopeKey, sourceRevision: input.sourceRevision, goal: input.goal, nonGoals: input.nonGoals, assumptions: input.assumptions,
      resolvedDecisions: input.resolvedDecisions, stopConditions: input.stopConditions, replanConditions: input.replanConditions,
      integrationStrategy: input.integrationStrategy, steps: input.steps, obligationDispositions: input.obligationDispositions,
    });
  }
  if (current.pendingRevision) throw new Error(`PLAN_REVISION_DRAFT_ALREADY_EXISTS: ${current.planId}:r${current.pendingRevision.revision}`);
  if (input.requirementId?.trim() !== current.requirementId?.trim()) throw new Error('PLAN_REVISION_REQUIREMENT_IDENTITY_MISMATCH');
  if (normalizeScopeKey(input.scopeKey) !== current.scopeKey) throw new Error(`PLAN_REVISION_SCOPE_IDENTITY_MISMATCH: ${current.scopeKey}`);

  const candidate = {
    ...buildPlanContract({ ...input, planId: current.planId, repoId: current.repoId, requirementId: current.requirementId, scopeKey: current.scopeKey }, at),
    revision: currentPlanRevision(current) + 1,
    supersedes: current.supersedes ? [...current.supersedes] : undefined,
  };
  const contentErrors = draftContentErrors(candidate);
  if (contentErrors.length > 0) throw new Error(`PLAN_REVISION_DRAFT_INVALID: ${contentErrors.join('; ')}`);
  const continuityErrors = revisionContinuityErrors(current, candidate, store.contracts);
  if (continuityErrors.length > 0) throw new Error(`PLAN_OBLIGATION_CONTINUITY_REQUIRED: ${continuityErrors.join('; ')}`);
  assertRevisionScopeAuthority(current, store.contracts);
  const deliveryCarries = deriveRequiredRevisionDeliveryCarries(options, current, candidate, at);
  const stagedCandidate = deliveryCarries.length > 0 ? { ...candidate, deliveryCarries } : candidate;
  const requestedRevisionLabel = sanitizeFileComponent(input.planId);
  const pendingRevision = revisionDraftFromCandidate(stagedCandidate, {
    requestedRevisionLabel: requestedRevisionLabel !== current.planId ? requestedRevisionLabel : undefined, createdAt: at, updatedAt: at,
  });
  const next: PlanContract = { ...current, status: 'replanning', pendingRevision, updatedAt: at };
  const contracts = [...store.contracts];
  contracts[predecessorIndex] = next;
  writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
  return next;
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
  const pending = current.status === 'replanning' ? current.pendingRevision : undefined;
  if (current.status !== 'draft' && !pending) throw new Error(`PLAN_DRAFT_REPAIR_STATUS_INVALID: ${current.planId}:${current.status}`);
  const observedSourceRevision = pending?.sourceRevision ?? current.sourceRevision;
  if (input.expectedSourceRevision !== undefined && observedSourceRevision !== input.expectedSourceRevision) {
    throw new Error(`PLAN_DRAFT_REPAIR_STALE_SOURCE: ${current.planId}:expected=${input.expectedSourceRevision}:actual=${observedSourceRevision}`);
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
  const candidateWithLineage = retireResolvedPredecessorObligationDispositions({
    ...candidate,
    ...(current.supersedes?.length ? { supersedes: [...current.supersedes] } : {}),
  }, store.contracts);
  const contentErrors = draftContentErrors(candidateWithLineage);
  if (contentErrors.length > 0) {
    throw new Error(`PLAN_DRAFT_REPAIR_INVALID: ${contentErrors.join('; ')}`);
  }
  const continuityErrors = obligationContinuityErrors(candidateWithLineage, store.contracts);
  if (continuityErrors.length > 0) {
    throw new Error(`PLAN_DRAFT_REPAIR_INVALID: ${continuityErrors.join('; ')}`);
  }
  if (pending) {
    if (normalizeScopeKey(input.scopeKey) !== current.scopeKey) throw new Error(`PLAN_REVISION_SCOPE_IDENTITY_MISMATCH: ${current.scopeKey}`);
    assertRevisionScopeAuthority(current, store.contracts);
    let revisionCandidate: PlanContract = { ...candidateWithLineage, revision: pending.revision, supersedes: current.supersedes ? [...current.supersedes] : undefined };
    revisionCandidate = retireResolvedRevisionObligationDispositions(current, revisionCandidate);
    const revisionErrors = revisionContinuityErrors(current, revisionCandidate, store.contracts);
    if (revisionErrors.length > 0) throw new Error(`PLAN_DRAFT_REPAIR_INVALID: ${revisionErrors.join('; ')}`);
    const deliveryCarries = deriveRequiredRevisionDeliveryCarries(options, current, revisionCandidate, at);
    if (deliveryCarries.length > 0) revisionCandidate = { ...revisionCandidate, deliveryCarries };
    const repairedPending = revisionDraftFromCandidate(revisionCandidate, {
      requestedRevisionLabel: pending.requestedRevisionLabel, createdAt: pending.createdAt, updatedAt: at,
    });
    const repairedCurrent: PlanContract = { ...current, pendingRevision: repairedPending, updatedAt: at };
    const contracts = [...store.contracts];
    contracts[index] = repairedCurrent;
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
    return repairedCurrent;
  }
  const explicitPredecessors = new Set(candidateWithLineage.supersedes ?? []);
  const conflictingScope = store.contracts.find((existing, candidateIndex) => candidateIndex !== index
    && !isTerminalPlanContractStatus(existing.status)
    && existing.scopeKey === candidateWithLineage.scopeKey
    && !explicitPredecessors.has(existing.planId));
  if (conflictingScope) throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${candidateWithLineage.scopeKey}:${conflictingScope.planId}`);
  const predecessor = current.supersedes?.length === 1
    ? store.contracts.find((existing) => existing.planId === current.supersedes![0])
    : undefined;
  const deliveryCarries = predecessor
    ? derivePlanStepDeliveryCarries(options, predecessor, candidateWithLineage, at)
    : [];
  const repaired: PlanContract = {
    ...candidateWithLineage,
    ...(deliveryCarries.length ? { deliveryCarries } : {}),
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
  const plans = listPlanContracts({ ...options, status: 'all', limit: 100 });
  const resolution = resolvePlanAdmission(plans, {
    requirementId: input.requirementId,
    scopeKey: input.scopeKey,
    planRelation: input.planRelation,
    relatedPlanId: input.relatedPlanId,
  });
  if (resolution.admissionDecision === 'extend_existing' && resolution.plan) {
    const revised = replacePlanContractUnlocked(options, resolution.plan.planId, input);
    return { ...resolution, admissionDecision: 'reuse_existing', plan: revised };
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

export function revisePlanSemanticContext(
  options: PlanContractStoreOptions,
  planIdInput: string,
  input: RevisePlanSemanticInput,
): PlanContract {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('PLAN_EXPECTED_REVISION_INVALID');
  return withPlanAdmissionLock(options, () => {
    const planId = sanitizeFileComponent(planIdInput);
    const applyRevision = (current: PlanContract, at: string): { previous: PlanSemanticView; next: PlanContract } => {
      const revision = currentPlanSemanticRevision(current);
      if (revision !== input.expectedRevision) throw new Error(`PLAN_REVISION_CONFLICT:${planId}:expected=${input.expectedRevision}:actual=${revision}`);
      const previous = planSemanticView(current);
      const goal = input.goal === undefined ? previous.goal : String(input.goal).trim().slice(0, 2_000);
      if (!goal) throw new Error('PLAN_GOAL_REQUIRED');
      const requirementBasisRevision = input.requirementBasisRevision === undefined
        ? previous.requirementBasisRevision
        : (() => {
            if (!Number.isInteger(input.requirementBasisRevision) || Number(input.requirementBasisRevision) < 1) throw new Error('PLAN_REQUIREMENT_BASIS_REVISION_INVALID');
            return Number(input.requirementBasisRevision);
          })();
      const sourceBasisRevision = input.sourceBasisRevision === undefined ? previous.sourceBasisRevision : String(input.sourceBasisRevision).trim().slice(0, 200);
      const items = input.items === undefined
        ? previous.items
        : input.items.slice(0, 100).map((item) => ({
            id: String(item.id).trim().slice(0, 200),
            objective: String(item.objective).trim().slice(0, 2_000),
            dependencies: [...new Set((item.dependencies ?? []).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100),
          }));
      if (items.some((item) => !item.id || !item.objective) || new Set(items.map((item) => item.id)).size !== items.length) throw new Error('PLAN_SEMANTIC_ITEMS_INVALID');
      const semanticContext = {
        requirementBasisRevision,
        sourceBasisRevision,
        goal,
        nonGoals: input.nonGoals === undefined ? previous.nonGoals : bounded(input.nonGoals, 20),
        assumptions: input.assumptions === undefined ? previous.assumptions : bounded(input.assumptions, 30),
        resolvedDecisions: input.resolvedDecisions === undefined ? previous.resolvedDecisions : bounded(input.resolvedDecisions, 30),
        stopConditions: input.stopConditions === undefined ? previous.stopConditions : bounded(input.stopConditions, 20),
        replanConditions: input.replanConditions === undefined ? previous.replanConditions : bounded(input.replanConditions, 20),
        integrationStrategy: input.integrationStrategy === undefined ? previous.integrationStrategy : input.integrationStrategy === null ? undefined : String(input.integrationStrategy).trim().slice(0, 1_000) || undefined,
        items,
      };
      return {
        previous,
        next: { ...current, semanticRevision: revision + 1, semanticUpdatedAt: at, semanticContext, updatedAt: at },
      };
    };

    if (sqliteBacked(options)) {
      return withControlPlaneTransaction(options.controllerHome, (database) => {
        const currentRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, planId);
        if (!currentRecord) throw new Error(`plan contract not found: ${planId}`);
        const at = nowIso(options);
        const { previous, next } = applyRevision(currentRecord.value, at);
        const semanticRevisionKey = `${planId}:r${previous.revision}`;
        if (!readControlPlaneRecordWithinTransaction<PlanSemanticRevisionRecord>(database, 'plan_semantic_revision', options.repoId, semanticRevisionKey)) {
          writeControlPlaneRecordWithinTransaction(database, {
            namespace: 'plan_semantic_revision', scope: options.repoId, key: semanticRevisionKey, schemaVersion: 1,
            value: { schemaVersion: 1, ...previous, recordedAt: at },
            action: 'plan_semantic_revision_archived', expectedRevision: null,
          });
        }
        return writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'plan_contract', scope: options.repoId, key: planId, schemaVersion: 1,
          value: next, action: 'plan_semantic_revised', expectedRevision: currentRecord.revision,
        }).value;
      });
    }

    const store = readPlanContractStore(options);
    const index = store.contracts.findIndex((contract) => contract.planId === planId);
    if (index < 0) throw new Error(`plan contract not found: ${planId}`);
    const at = nowIso(options);
    const { previous, next } = applyRevision(store.contracts[index]!, at);
    appendJsonPlanSemanticRevisionRecord(options, { schemaVersion: 1, ...previous, recordedAt: at });
    const contracts = [...store.contracts];
    contracts[index] = next;
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
    return next;
  });
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
    revision: currentPlanRevision(plan),
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
  const stagedPredecessorId = plan.supersedes?.length === 1 ? plan.supersedes[0] : undefined;
  if (allPlans.some((existing) => existing.planId !== plan.planId && existing.scopeKey === plan.scopeKey
    && scopeIsCommitted(existing.status)
    && !(existing.planId === stagedPredecessorId && existing.status === 'replanning'))) {
    errors.push(`active plan already owns scope_key ${plan.scopeKey}`);
  }
  errors.push(...obligationContinuityErrors(plan, allPlans));
  return [...new Set(errors)];
}

function approvePendingPlanRevisionUnlocked(
  options: PlanContractStoreOptions & { controllerHome: string; repoId: string },
  current: PlanContract,
): PlanContract {
  const pending = current.pendingRevision;
  if (!pending) throw new Error('PLAN_PENDING_REVISION_REQUIRED');
  const at = nowIso(options);
  return withControlPlaneTransaction(options.controllerHome, (database) => {
    const currentRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, current.planId);
    if (!currentRecord?.value.pendingRevision) throw new Error('PLAN_PENDING_REVISION_STALE');
    const predecessor = currentRecord.value;
    const staged = predecessor.pendingRevision!;
    const archived = planRevisionRecord(predecessor, { recordedAt: at, reason: 'approved Plan revision', requestedRevisionLabel: staged.requestedRevisionLabel });
    let candidate = planFromPendingRevision(predecessor, staged, at);
    candidate = { ...candidate, status: 'approved', steps: projectDependencyReadySteps(candidate.steps) };
    const allPlans = readPlanContractStore(options).contracts;
    assertRevisionScopeAuthority(predecessor, allPlans);
    const continuityErrors = revisionContinuityErrors(predecessor, candidate, allPlans);
    if (continuityErrors.length > 0) throw new Error(`PLAN_OBLIGATION_CONTINUITY_REQUIRED: ${continuityErrors.join('; ')}`);
    const revalidatedCarries = deriveRequiredRevisionDeliveryCarries(options, predecessor, candidate, at);
    const stagedCarryKeys = new Set((staged.deliveryCarries ?? []).map((carry) => `${carry.successorStepId}:${carry.workId}:${carry.completionReceiptId}`));
    const revalidatedCarryKeys = new Set(revalidatedCarries.map((carry) => `${carry.successorStepId}:${carry.workId}:${carry.completionReceiptId}`));
    for (const carry of revalidatedCarries) {
      const key = `${carry.successorStepId}:${carry.workId}:${carry.completionReceiptId}`;
      if (!stagedCarryKeys.has(key)) throw new Error(`PLAN_DELIVERY_CARRY_STAGING_MISMATCH: ${carry.successorStepId}`);
    }
    for (const carry of staged.deliveryCarries ?? []) {
      const key = `${carry.successorStepId}:${carry.workId}:${carry.completionReceiptId}`;
      if (!revalidatedCarryKeys.has(key)) throw new Error(`PLAN_DELIVERY_CARRY_INVALID: ${carry.successorStepId}`);
    }

    const workWrites: Array<{ value: WorkContract; revision: number; action: string }> = [];
    let hasExecuting = false;
    let hasValidating = false;
    const steps = [...candidate.steps];
    // Preserve already completed immutable semantics without replay.
    for (let index = 0; index < steps.length; index += 1) {
      const nextStep = steps[index]!;
      const previousStep = predecessor.steps.find((step) => step.id === nextStep.id);
      if (!previousStep) continue;
      if (previousStep.status === 'completed' && samePlanStepExecutionContract(previousStep, nextStep)
        && sameOrderedStrings(previousStep.acceptanceCriteria, nextStep.acceptanceCriteria)) {
        steps[index] = { ...nextStep, status: 'completed', workId: previousStep.workId, evidenceRefs: previousStep.evidenceRefs };
      } else {
        const carry = deliveryCarryForStep(options, predecessor, previousStep, candidate, nextStep, at);
        if (carry) {
          steps[index] = {
            ...nextStep,
            status: 'validating',
            workId: carry.workId,
            evidenceRefs: previousStep.evidenceRefs,
          };
          hasValidating = true;
        }
      }
    }
    candidate = { ...candidate, steps };

    const workRecords = listAllControlPlaneRecordsWithinTransaction<WorkContract>(database, { namespace: 'work_contract', scope: options.repoId })
      .filter((record) => record.value.planId === predecessor.planId && !isTerminalWorkContractStatus(record.value.status));
    for (const workRecord of workRecords) {
      const previousStep = predecessor.steps.find((step) => workMatchesPlanStep(workRecord.value, predecessor, step));
      const nextIndex = previousStep ? candidate.steps.findIndex((step) => step.id === previousStep.id) : -1;
      const nextStep = nextIndex >= 0 ? candidate.steps[nextIndex] : undefined;
      if (previousStep && nextStep && previousStep.workId === workRecord.value.workId
        && samePlanStepExecutionContract(previousStep, nextStep)
        && sameOrderedStrings(previousStep.acceptanceCriteria, nextStep.acceptanceCriteria)) {
        const refreshed = refreshPlanBoundWorkRevision(workRecord.value, {
          planId: predecessor.planId, planStepId: nextStep.id, planSourceRevision: candidate.sourceRevision,
          allowedPaths: nextStep.allowedPaths, forbiddenPaths: nextStep.forbiddenPaths, checks: nextStep.checks,
          recordedAt: at, reason: `Plan revision r${currentPlanRevision(predecessor)} -> r${staged.revision} preserved the exact Work contract.`,
        });
        const nextSteps = [...candidate.steps];
        nextSteps[nextIndex] = { ...nextStep, status: 'executing', workId: refreshed.workId, evidenceRefs: previousStep.evidenceRefs };
        candidate = { ...candidate, steps: nextSteps };
        hasExecuting = true;
        workWrites.push({ value: refreshed, revision: workRecord.revision, action: 'plan_revision_work_refreshed' });
      } else {
        const retired = retirePlanBoundWorkContract(workRecord.value, {
          predecessorPlanId: predecessor.planId, recordedAt: at, reason: `Plan revision r${currentPlanRevision(predecessor)} -> r${staged.revision} changed the frozen Work execution contract.`,
        });
        workWrites.push({ value: retired, revision: workRecord.revision, action: 'plan_revision_work_retired' });
      }
    }
    const allCompleted = candidate.steps.length > 0 && candidate.steps.every((step) => step.status === 'completed');
    candidate = { ...candidate, deliveryCarries: undefined, status: hasExecuting ? 'executing' : hasValidating ? 'verifying' : allCompleted ? 'ready_to_finalize' : 'approved', updatedAt: at };
    const revisionKey = planRevisionRecordKey(predecessor.planId, currentPlanRevision(predecessor));
    if (readControlPlaneRecordWithinTransaction<PlanRevisionRecord>(database, 'plan_revision', options.repoId, revisionKey)) {
      throw new Error(`PLAN_REVISION_ALREADY_EXISTS: ${predecessor.planId}:r${currentPlanRevision(predecessor)}`);
    }
    writeControlPlaneRecordWithinTransaction(database, { namespace: 'plan_revision', scope: options.repoId, key: revisionKey, schemaVersion: 1, value: archived, action: 'plan_revision_archived', expectedRevision: null });
    writeControlPlaneRecordWithinTransaction(database, { namespace: 'plan_contract', scope: options.repoId, key: predecessor.planId, schemaVersion: 1, value: candidate, action: 'plan_revision_approved', expectedRevision: currentRecord.revision });
    for (const write of workWrites) {
      writeControlPlaneRecordWithinTransaction(database, { namespace: 'work_contract', scope: options.repoId, key: write.value.workId, schemaVersion: 2, value: write.value, action: write.action, expectedRevision: write.revision });
    }
    return candidate;
  });
}

function approvePlanContractUnlocked(options: PlanContractStoreOptions, planId: string): PlanContract {
  const store = readPlanContractStore(options);
  const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
  if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
  const current = store.contracts[index];
  assertRequirementReference(options, current.requirementId);
  if (current.status === 'replanning' && current.pendingRevision) {
    if (!sqliteBacked(options)) {
      const at = nowIso(options);
      const candidate = { ...planFromPendingRevision(current, current.pendingRevision, at), status: 'approved' as const };
      appendJsonPlanRevisionRecord(options, planRevisionRecord(current, { recordedAt: at, reason: 'approved Plan revision', requestedRevisionLabel: current.pendingRevision.requestedRevisionLabel }));
      const contracts = [...store.contracts];
      contracts[index] = candidate;
      writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
      return candidate;
    }
    return approvePendingPlanRevisionUnlocked(options, current);
  }
  if (current.status !== 'draft' && current.status !== 'reviewing') throw new Error(`plan contract ${current.planId} cannot be approved from ${current.status}`);
  const errors = approvalErrors(current, store.contracts);
  if (errors.length > 0) throw new Error(`plan contract ${current.planId} cannot be approved: ${errors.join('; ')}`);
  const at = nowIso(options);
  const materializedCarry = materializePlanStepDeliveryCarries(options, current, store.contracts);
  const next = {
    ...current,
    status: materializedCarry.carriedCount > 0 ? 'verifying' as const : 'approved' as const,
    steps: projectDependencyReadySteps(materializedCarry.steps),
    updatedAt: at,
  };
  const stagedPredecessor = current.supersedes?.length === 1
    ? store.contracts.find((candidate) => candidate.planId === current.supersedes![0] && candidate.status === 'replanning')
    : undefined;
  if (stagedPredecessor) {
    const predecessorNext: PlanContract = { ...stagedPredecessor, status: 'superseded', supersededBy: current.planId, supersessionReason: 'extend_existing', updatedAt: at };
    const contracts = store.contracts.map((candidate) => candidate.planId === predecessorNext.planId ? predecessorNext : candidate.planId === next.planId ? next : candidate);
    return writePlanSupersessionWithWorkRetirement(options, { schemaVersion: 1, updatedAt: at, contracts }, predecessorNext, next, at);
  }
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
  requestedRevisionLabel: string;
  sourceRevision: string;
  allowedPaths: string[];
  reason: string;
}

export interface ReplanActivePlanBoundWorkScopeResult {
  priorPlan: PlanContract;
  currentPlan: PlanContract;
  work: WorkContract;
}

/**
 * Atomically advance one executing Plan revision while retaining its exact
 * active Work binding. This repair is intentionally scope-only: objective,
 * acceptance, checks, forbidden paths, dependencies, Plan identity, and Work
 * identity remain unchanged; allowed paths may only widen.
 */
export function replanActivePlanBoundWorkScope(
  options: PlanContractStoreOptions,
  input: ReplanActivePlanBoundWorkScopeInput,
): ReplanActivePlanBoundWorkScopeResult {
  if (!sqliteBacked(options)) throw new Error('PLAN_WORK_REPLAN_REQUIRES_CONTROLLER_STORE');
  const planId = sanitizeFileComponent(input.planId);
  const requestedRevisionLabel = sanitizeFileComponent(input.requestedRevisionLabel);
  const stepId = sanitizeFileComponent(input.stepId);
  const workId = sanitizeFileComponent(input.workId);
  const sourceRevision = input.sourceRevision.trim();
  const reason = input.reason.trim();
  if (!requestedRevisionLabel || requestedRevisionLabel === 'unknown' || requestedRevisionLabel === planId) throw new Error('PLAN_REVISION_LABEL_MUST_CHANGE');
  if (!sourceRevision) throw new Error('PLAN_WORK_REPLAN_SOURCE_REVISION_REQUIRED');
  if (!reason) throw new Error('PLAN_WORK_REPLAN_REASON_REQUIRED');
  const requestedAllowedPaths = [...new Set(input.allowedPaths.map((value) => value.trim()).filter(Boolean))].slice(0, 50);

  return withPlanAdmissionLock(options, () => {
    const observed = getPlanContract(options, planId);
    if (!observed) throw new Error(`plan contract not found: ${planId}`);
    assertRequirementReference(options, observed.requirementId);
    return withControlPlaneTransaction(options.controllerHome, (database) => {
      const planRecord = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', options.repoId, planId);
      if (!planRecord) throw new Error(`plan contract not found: ${planId}`);
      const priorPlan = planRecord.value;
      if (priorPlan.supersededBy || isTerminalPlanContractStatus(priorPlan.status)) {
        throw new Error(`PLAN_WORK_REPLAN_PREDECESSOR_TERMINAL: ${priorPlan.planId}:${priorPlan.status}`);
      }
      if (priorPlan.status !== 'executing' && priorPlan.status !== 'replanning') {
        throw new Error(`PLAN_WORK_REPLAN_STATUS_INVALID: ${priorPlan.planId}:${priorPlan.status}`);
      }
      const stepIndex = priorPlan.steps.findIndex((candidate) => candidate.id === stepId);
      if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${stepId}`);
      const step = priorPlan.steps[stepIndex]!;
      if (step.status !== 'executing' || step.workId !== workId) {
        throw new Error(`PLAN_WORK_REPLAN_STEP_BINDING_MISMATCH: ${priorPlan.planId}/${stepId}:${step.status}:${step.workId ?? 'none'}`);
      }
      for (const path of step.allowedPaths) {
        if (!requestedAllowedPaths.includes(path)) throw new Error(`PLAN_WORK_REPLAN_SCOPE_NARROWING_FORBIDDEN: ${path}`);
      }
      const widened = requestedAllowedPaths.some((path) => !step.allowedPaths.includes(path));
      if (!widened) throw new Error('PLAN_WORK_REPLAN_SCOPE_NOT_WIDENED');
      const workRecord = readControlPlaneRecordWithinTransaction<WorkContract>(database, 'work_contract', options.repoId, workId);
      if (!workRecord) throw new Error(`work contract not found: ${workId}`);
      // Replan runs inside the Plan + Work transaction. Normalize the exact
      // row read there so a legacy Work missing the first-class review
      // checkpoint is migrated by the canonical Work authority before the
      // scope-only refresh validates phase evidence.
      const work = canonicalizeWorkContractForAuthority(workRecord.value);
      if (work.requirementId !== priorPlan.requirementId) throw new Error('PLAN_WORK_REPLAN_REQUIREMENT_MISMATCH');
      const at = nowIso(options);
      const priorRevision = currentPlanRevision(priorPlan);
      const archived = planRevisionRecord(priorPlan, { recordedAt: at, reason, requestedRevisionLabel });
      const steps = [...priorPlan.steps];
      steps[stepIndex] = {
        ...step,
        allowedPaths: requestedAllowedPaths,
        evidenceRefs: [{
          title: 'scope-only Plan revision',
          summary: `${priorPlan.planId} r${priorRevision} -> r${priorRevision + 1}: ${reason}`.slice(0, 2_000),
          detailLevel: 'summary' as const,
        }, ...step.evidenceRefs].slice(0, 20),
      };
      const currentPlan: PlanContract = {
        ...priorPlan,
        revision: priorRevision + 1,
        sourceRevision,
        status: 'executing',
        steps,
        evidenceRefs: [{
          title: 'active Work Plan revision advanced',
          summary: `${priorPlan.planId} retained exact Work ${workId}; current revision advanced r${priorRevision} -> r${priorRevision + 1} without creating another Plan authority.`.slice(0, 2_000),
          detailLevel: 'summary' as const,
        }, ...priorPlan.evidenceRefs].slice(0, 20),
        updatedAt: at,
      };
      const workNext = refreshPlanBoundWorkRevision(work, {
        planId: priorPlan.planId, planStepId: stepId, planSourceRevision: sourceRevision,
        allowedPaths: requestedAllowedPaths, forbiddenPaths: step.forbiddenPaths, checks: step.checks, recordedAt: at, reason,
      });
      const revisionKey = planRevisionRecordKey(priorPlan.planId, priorRevision);
      const existingRevision = readControlPlaneRecordWithinTransaction<PlanRevisionRecord>(database, 'plan_revision', options.repoId, revisionKey);
      if (existingRevision) throw new Error(`PLAN_REVISION_ALREADY_EXISTS: ${priorPlan.planId}:r${priorRevision}`);
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_revision', scope: options.repoId, key: revisionKey, schemaVersion: 1,
        value: archived, action: 'plan_revision_archived', expectedRevision: null,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract', scope: options.repoId, key: priorPlan.planId, schemaVersion: 1,
        value: currentPlan, action: 'plan_current_revision_advanced', expectedRevision: planRecord.revision,
      });
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'work_contract', scope: options.repoId, key: workNext.workId, schemaVersion: 2,
        value: workNext, action: 'plan_revision_work_refreshed', expectedRevision: workRecord.revision,
      });
      return { priorPlan, currentPlan, work: workNext };
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
  return updatePlanContractWithExecutionBaseline(options, input.planId, (current, executionBaselineRevision) => {
    assertRequirementReference(options, current.requirementId);
    if (current.status !== 'approved' && current.status !== 'executing') {
      throw new Error(`PLAN_NOT_EXECUTABLE: ${current.planId} is ${current.status}`);
    }
    let nextExecutionBaseline = executionBaselineRevision;
    if (executionBaselineRevision !== input.sourceRevision) {
      const activeStep = current.steps.find((candidate) => candidate.status === 'executing' || candidate.status === 'validating');
      if (activeStep) {
        throw new Error(`PLAN_EXECUTION_BASELINE_LOCKED: ${current.planId}:${activeStep.id}:${executionBaselineRevision}`);
      }
      nextExecutionBaseline = input.sourceRevision;
    }
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.status === 'executing' || step.status === 'validating') throw new Error(`PLAN_STEP_ALREADY_ACTIVE: ${step.id}`);
    if (step.status === 'completed') throw new Error(`PLAN_STEP_ALREADY_COMPLETED: ${step.id}`);
    const unresolved = step.dependencies.filter((dependency) => current.steps.find((candidate) => candidate.id === dependency)?.status !== 'completed');
    if (unresolved.length > 0) throw new Error(`PLAN_STEP_DEPENDENCIES_PENDING: ${unresolved.join(', ')}`);
    const at = nowIso(options);
    const steps = [...current.steps];
    steps[stepIndex] = { ...step, status: 'executing', workId: input.workId };
    return { plan: { ...current, status: 'executing', steps, updatedAt: at }, executionBaselineRevision: nextExecutionBaseline };
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

export function repairPlanStepForTechnicalRetry(
  options: PlanContractStoreOptions,
  input: { work: WorkContract; cleanupComplete: boolean; reason: string },
): PlanContract {
  const work = input.work;
  const reason = input.reason.trim();
  if (!reason) throw new Error('PLAN_STEP_TECHNICAL_RETRY_REASON_REQUIRED');
  if (work.status !== 'cancelled' && work.status !== 'failed') {
    throw new Error(`PLAN_STEP_TECHNICAL_RETRY_WORK_STATUS_INVALID: ${work.workId}:${work.status}`);
  }
  if (work.phase !== 'cleanup') throw new Error(`PLAN_STEP_TECHNICAL_RETRY_WORK_PHASE_INVALID: ${work.workId}:${work.phase}`);
  if (work.completionReceipt || work.completionOutcome) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_DELIVERY_PRESENT: ${work.workId}`);
  if (work.scopeEvidence?.actualChangedPaths.length !== 0) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_SOURCE_DELTA_PRESENT: ${work.workId}`);
  if (!input.cleanupComplete) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_CLEANUP_INCOMPLETE: ${work.workId}`);
  if (!work.planId?.trim() || !work.planStepId?.trim() || !work.planSourceRevision?.trim()) {
    throw new Error(`PLAN_STEP_TECHNICAL_RETRY_LINEAGE_REQUIRED: ${work.workId}`);
  }
  if (work.status === 'failed') {
    const checks = work.checkRefs ?? [];
    if (checks.length === 0 || checks.some((check) => check.outcome !== 'infrastructure_failure')) {
      throw new Error(`PLAN_STEP_TECHNICAL_RETRY_FAILED_WORK_NOT_INFRASTRUCTURE_ONLY: ${work.workId}`);
    }
  }
  return updatePlanContract(options, work.planId, (current) => {
    if (current.status !== 'replanning') throw new Error(`PLAN_STEP_TECHNICAL_RETRY_PLAN_STATUS_INVALID: ${current.planId}:${current.status}`);
    if (current.sourceRevision !== work.planSourceRevision) {
      throw new Error(`PLAN_STEP_TECHNICAL_RETRY_SEMANTIC_SOURCE_MISMATCH: ${current.planId}:plan=${current.sourceRevision}:work=${work.planSourceRevision}`);
    }
    if (work.requirementId !== current.requirementId) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_REQUIREMENT_MISMATCH: ${work.workId}`);
    const stepIndex = current.steps.findIndex((step) => step.id === work.planStepId);
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${work.planStepId}`);
    const step = current.steps[stepIndex]!;
    if (step.status !== 'ready' || step.workId) {
      throw new Error(`PLAN_STEP_TECHNICAL_RETRY_STEP_STATE_INVALID: ${step.id}:${step.status}:${step.workId ?? 'unbound'}`);
    }
    const dependenciesSatisfied = step.dependencies.every((dependency) => current.steps.find((candidate) => candidate.id === dependency)?.status === 'completed');
    if (!dependenciesSatisfied) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_DEPENDENCY_INVALID: ${step.id}`);
    const contractMatches = work.objective === step.objective
      && sameOrderedStrings(work.acceptanceCriteria, step.acceptanceCriteria)
      && sameOrderedStrings(work.allowedPaths, step.allowedPaths)
      && sameOrderedStrings(work.forbiddenPaths, step.forbiddenPaths)
      && sameOrderedStrings(work.checks, step.checks);
    if (!contractMatches) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_CONTRACT_MISMATCH: ${work.workId}`);
    const at = nowIso(options);
    const steps = [...current.steps];
    steps[stepIndex] = {
      ...step,
      evidenceRefs: [{
        title: 'technical Work retry authorized',
        summary: `${work.workId}: ${reason}`.slice(0, 2_000),
        detailLevel: 'summary' as const,
      }, ...step.evidenceRefs].slice(0, 20),
    };
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
    return { ...current, status: current.pendingRevision ? 'replanning' : delivered ? 'verifying' : 'replanning', steps, updatedAt: at };
  });
}

export function acceptPlanStepEvidence(
  options: PlanContractStoreOptions,
  input: { planId: string; stepId: string; reviewer: string; rationale: string; acceptedSourceRevision?: string },
): PlanContract {
  const reviewer = input.reviewer.trim();
  const rationale = input.rationale.trim();
  if (!reviewer || !rationale) throw new Error('PLAN_STEP_SEMANTIC_ACCEPTANCE_METADATA_REQUIRED');
  return updatePlanContractWithExecutionBaseline(options, input.planId, (current, executionBaselineRevision) => {
    const stepIndex = current.steps.findIndex((step) => step.id === sanitizeFileComponent(input.stepId));
    if (stepIndex < 0) throw new Error(`PLAN_STEP_NOT_FOUND: ${input.stepId}`);
    const step = current.steps[stepIndex];
    if (step.status === 'completed') return { plan: current, executionBaselineRevision };
    if (step.status !== 'validating') throw new Error(`PLAN_STEP_NOT_READY_FOR_SEMANTIC_ACCEPTANCE: ${step.id} is ${step.status}`);
    const steps = [...current.steps];
    steps[stepIndex] = {
      ...step,
      status: 'completed',
      evidenceRefs: [{ title: 'semantic acceptance', summary: `${reviewer}: ${rationale}`, detailLevel: 'summary' as const }, ...step.evidenceRefs].slice(0, 20),
    };
    const allCompleted = steps.every((candidate) => candidate.status === 'completed');
    const projectedSteps = allCompleted ? steps : projectDependencyReadySteps(steps);
    const acceptedSourceRevision = input.acceptedSourceRevision?.trim();
    const updatedAt = nowIso(options);
    return {
      plan: {
        ...current,
        status: current.pendingRevision ? 'replanning' : allCompleted ? 'finalized' : 'executing',
        steps: projectedSteps,
        updatedAt,
      },
      executionBaselineRevision: acceptedSourceRevision || executionBaselineRevision,
    };
  });
}
