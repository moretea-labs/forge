import { mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  isTerminalPlanContractStatus,
  type EvidenceRef,
  type PlanContract,
  type PlanContractStatus,
  type PlanContractStore,
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

export interface PlanContractSummary {
  planId: string;
  repoId: string;
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
  return sanitizeFileComponent(value).toLowerCase().slice(0, 160);
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
    evidenceRefs: (step.evidenceRefs ?? []).slice(0, 20),
  };
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

export function readPlanContractStore(options: PlanContractStoreOptions): PlanContractStore {
  return readJsonFile<PlanContractStore>(planContractStorePath(options), emptyPlanContractStore(nowIso(options)));
}

function writePlanContractStore(options: PlanContractStoreOptions, store: PlanContractStore): PlanContractStore {
  writeJsonAtomic(planContractStorePath(options), store);
  return store;
}

export function createPlanContract(options: PlanContractStoreOptions, input: CreatePlanContractInput): PlanContract {
  const at = nowIso(options);
  const planId = sanitizeFileComponent(input.planId);
  if (!String(input.planId ?? '').trim() || planId === 'unknown') throw new Error('plan_id is required');
  const plan: PlanContract = {
    schemaVersion: 1,
    planId,
    repoId: input.repoId,
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

export function approvePlanContract(options: PlanContractStoreOptions, planId: string): PlanContract {
  const store = readPlanContractStore(options);
  const index = store.contracts.findIndex((contract) => contract.planId === sanitizeFileComponent(planId));
  if (index < 0) throw new Error(`plan contract not found: ${sanitizeFileComponent(planId)}`);
  const current = store.contracts[index];
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
