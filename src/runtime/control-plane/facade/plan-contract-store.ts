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
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../persistence/sqlite-store';
import { readRequirement } from '../persistence/requirement-store';
import type { ScopeRef } from '../../../../packages/kernel/identity/api/index';
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

function normalizePlanSemanticItems(items: readonly { id: string; objective: string; dependencies?: string[] }[] | undefined) {
  const normalized = (items ?? []).slice(0, 100).map((item) => ({
    id: String(item.id).trim().slice(0, 200),
    objective: String(item.objective).trim().slice(0, 2_000),
    dependencies: [...new Set((item.dependencies ?? []).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100),
  }));
  if (normalized.some((item) => !item.id || !item.objective) || new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    throw new Error('PLAN_SEMANTIC_ITEMS_INVALID');
  }
  return normalized;
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
  semanticScope: ScopeRef;
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

export interface CreatePlanSemanticInput {
  planId: string;
  repoId: string;
  requirementId?: string;
  requirementBasisRevision?: number;
  scopeKey?: string;
  sourceBasisRevision?: string;
  goal: string;
  nonGoals?: string[];
  assumptions?: string[];
  resolvedDecisions?: string[];
  stopConditions?: string[];
  replanConditions?: string[];
  integrationStrategy?: string;
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
  const semanticScope: ScopeRef = plan.requirementId?.trim()
    ? { schemaVersion: 1, kind: 'requirement', id: plan.requirementId.trim() }
    : { schemaVersion: 1, kind: 'plan', id: plan.planId };
  return {
    planId: plan.planId,
    revision: currentPlanSemanticRevision(plan),
    semanticScope,
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

function planRevisionRecordKey(planId: string, revision: number): string {
  return `${sanitizeFileComponent(planId)}:r${revision}`;
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
      .map((record) => ({
        ...record,
        semanticScope: record.semanticScope ?? (record.requirementId
          ? { schemaVersion: 1, kind: 'requirement', id: record.requirementId }
          : { schemaVersion: 1, kind: 'plan', id: record.planId }),
      } as PlanSemanticRevisionRecord))
      .sort((left, right) => right.revision - left.revision);
  }
  return listControlPlaneRecords<PlanSemanticRevisionRecord>(options.controllerHome, {
    namespace: 'plan_semantic_revision', scope: options.repoId, limit: 5_000,
  }).map((record) => record.value)
    .filter((record) => !normalizedPlanId || record.planId === normalizedPlanId)
    .map((record) => ({
      ...record,
      semanticScope: record.semanticScope ?? (record.requirementId
        ? { schemaVersion: 1, kind: 'requirement', id: record.requirementId }
        : { schemaVersion: 1, kind: 'plan', id: record.planId }),
    } as PlanSemanticRevisionRecord))
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



function assertRevisionScopeAuthority(current: PlanContract, allPlans: readonly PlanContract[]): void {
  const conflicting = allPlans.find((plan) => plan.planId !== current.planId
    && !isTerminalPlanContractStatus(plan.status) && plan.scopeKey === current.scopeKey);
  if (conflicting) throw new Error(`PLAN_SCOPE_ALREADY_OWNED: ${current.scopeKey}:${conflicting.planId}`);
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
  assertRevisionScopeAuthority(current, store.contracts);
  const requestedRevisionLabel = sanitizeFileComponent(input.planId);
  const pendingRevision = revisionDraftFromCandidate(candidate, {
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
  const candidateWithLineage = {
    ...candidate,
    ...(current.supersedes?.length ? { supersedes: [...current.supersedes] } : {}),
  };
  const contentErrors = draftContentErrors(candidateWithLineage);
  if (contentErrors.length > 0) {
    throw new Error(`PLAN_DRAFT_REPAIR_INVALID: ${contentErrors.join('; ')}`);
  }
  if (pending) {
    if (normalizeScopeKey(input.scopeKey) !== current.scopeKey) throw new Error(`PLAN_REVISION_SCOPE_IDENTITY_MISMATCH: ${current.scopeKey}`);
    assertRevisionScopeAuthority(current, store.contracts);
    let revisionCandidate: PlanContract = { ...candidateWithLineage, revision: pending.revision, supersedes: current.supersedes ? [...current.supersedes] : undefined };
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
  const repaired: PlanContract = {
    ...candidateWithLineage,
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

export function createPlanSemanticContext(options: PlanContractStoreOptions, input: CreatePlanSemanticInput): PlanContract {
  return withPlanAdmissionLock(options, () => {
    assertRequirementReference(options, input.requirementId);
    const store = readPlanContractStore(options);
    const planId = sanitizeFileComponent(input.planId);
    if (!String(input.planId ?? '').trim() || planId === 'unknown') throw new Error('plan_id is required');
    if (store.contracts.some((existing) => existing.planId === planId)) throw new Error(`plan contract already exists: ${planId}`);

    // Thin Plan scope is descriptive discovery/lineage metadata only. It is not
    // execution ownership and therefore must never reject another semantic Plan.
    // Defaulting the compatibility field to planId keeps legacy storage readable
    // without creating a synthetic mutex.
    const scopeKey = normalizeScopeKey(input.scopeKey?.trim() || planId);

    const goal = String(input.goal ?? '').trim().slice(0, 2_000);
    if (!goal) throw new Error('PLAN_GOAL_REQUIRED');
    const requirementBasisRevision = input.requirementBasisRevision === undefined
      ? undefined
      : (() => {
          if (!Number.isInteger(input.requirementBasisRevision) || Number(input.requirementBasisRevision) < 1) {
            throw new Error('PLAN_REQUIREMENT_BASIS_REVISION_INVALID');
          }
          return Number(input.requirementBasisRevision);
        })();
    const sourceBasisRevision = String(input.sourceBasisRevision ?? '').trim().slice(0, 200);
    const items = normalizePlanSemanticItems(input.items);
    const at = nowIso(options);
    const semanticContext = {
      requirementBasisRevision,
      sourceBasisRevision,
      goal,
      nonGoals: bounded(input.nonGoals, 20),
      assumptions: bounded(input.assumptions, 30),
      resolvedDecisions: bounded(input.resolvedDecisions, 30),
      stopConditions: bounded(input.stopConditions, 20),
      replanConditions: bounded(input.replanConditions, 20),
      integrationStrategy: input.integrationStrategy?.trim().slice(0, 1_000) || undefined,
      items,
    };
    const plan: PlanContract = {
      schemaVersion: 1,
      planId,
      revision: 1,
      semanticRevision: 1,
      semanticUpdatedAt: at,
      semanticContext,
      repoId: input.repoId,
      requirementId: input.requirementId?.trim().slice(0, 160) || undefined,
      scopeKey,
      sourceRevision: sourceBasisRevision,
      goal,
      nonGoals: [...semanticContext.nonGoals],
      assumptions: [...semanticContext.assumptions],
      resolvedDecisions: [...semanticContext.resolvedDecisions],
      stopConditions: [...semanticContext.stopConditions],
      replanConditions: [...semanticContext.replanConditions],
      integrationStrategy: semanticContext.integrationStrategy,
      // Legacy lifecycle projection only. Thin Plan items never become PlanSteps.
      status: 'approved',
      steps: [],
      evidenceRefs: [],
      createdAt: at,
      updatedAt: at,
    };
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts: [plan, ...store.contracts] });
    return plan;
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
      const items = input.items === undefined ? previous.items : normalizePlanSemanticItems(input.items);
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
    // A Plan revision is authored content only. Activating it never refreshes,
    // retires or re-scopes Work, and never promotes Plan item status.
    const candidate: PlanContract = { ...planFromPendingRevision(predecessor, staged, at), status: 'approved', deliveryCarries: undefined, updatedAt: at };
    const allPlans = readPlanContractStore(options).contracts;
    assertRevisionScopeAuthority(predecessor, allPlans);
    const revisionKey = planRevisionRecordKey(predecessor.planId, currentPlanRevision(predecessor));
    if (readControlPlaneRecordWithinTransaction<PlanRevisionRecord>(database, 'plan_revision', options.repoId, revisionKey)) {
      throw new Error(`PLAN_REVISION_ALREADY_EXISTS: ${predecessor.planId}:r${currentPlanRevision(predecessor)}`);
    }
    writeControlPlaneRecordWithinTransaction(database, { namespace: 'plan_revision', scope: options.repoId, key: revisionKey, schemaVersion: 1, value: archived, action: 'plan_revision_archived', expectedRevision: null });
    writeControlPlaneRecordWithinTransaction(database, { namespace: 'plan_contract', scope: options.repoId, key: predecessor.planId, schemaVersion: 1, value: candidate, action: 'plan_revision_approved', expectedRevision: currentRecord.revision });
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
  // Legacy Plan identity bookkeeping only: approval never promotes Plan item
  // status, materializes delivery carries or rewrites bound Work.
  const next = {
    ...current,
    status: 'approved' as const,
    updatedAt: at,
  };
  const stagedPredecessor = current.supersedes?.length === 1
    ? store.contracts.find((candidate) => candidate.planId === current.supersedes![0] && candidate.status === 'replanning')
    : undefined;
  if (stagedPredecessor) {
    const predecessorNext: PlanContract = { ...stagedPredecessor, status: 'superseded', supersededBy: next.planId, supersessionReason: 'extend_existing', updatedAt: at };
    const contracts = store.contracts.map((candidate) => candidate.planId === predecessorNext.planId ? predecessorNext : candidate.planId === next.planId ? next : candidate);
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
    return next;
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
    writePlanContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
    return next;
  });
}


