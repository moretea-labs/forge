import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneRecord,
  type SqliteDatabase,
} from './sqlite-store';

export const REQUIREMENT_STATES = ['planned', 'active', 'waiting_for_user', 'done', 'cancelled'] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

export interface Requirement {
  schemaVersion: 1;
  requirementId: string;
  legacyAliases: string[];
  title: string;
  outcomeStatement: string;
  acceptanceCriteria: string[];
  requiredDeliveryReferences: string[];
  activePlanId?: string;
  state: RequirementState;
  needsAttention: boolean;
  attentionSummary?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  auditRefs: string[];
}

export interface RequirementStoreOptions {
  controllerHome: string;
  now?: () => string;
}

export interface CreateRequirementInput {
  requirementId: string;
  legacyAliases?: string[];
  title: string;
  outcomeStatement: string;
  acceptanceCriteria?: string[];
  requiredDeliveryReferences?: string[];
}

const NAMESPACE = 'requirement';
const SCOPE = 'controller';
const SCHEMA_VERSION = 1;

function nowIso(options: RequirementStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function id(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) throw new Error('REQUIREMENT_ID_INVALID');
  return normalized.slice(0, 160);
}

function bounded(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] {
  return (values ?? []).map((value) => String(value).trim()).filter(Boolean).slice(0, limit).map((value) => value.slice(0, maxLength));
}

function readWithin(database: SqliteDatabase, requirementId: string): ControlPlaneRecord<Requirement> | undefined {
  return readControlPlaneRecordWithinTransaction(database, NAMESPACE, SCOPE, requirementId);
}

export function readRequirement(
  options: RequirementStoreOptions,
  requirementId: string,
): ControlPlaneRecord<Requirement> | undefined {
  return readControlPlaneRecord<Requirement>(options.controllerHome, NAMESPACE, SCOPE, id(requirementId));
}

export function listRequirements(
  options: RequirementStoreOptions,
  limit = 500,
): ControlPlaneRecord<Requirement>[] {
  return listControlPlaneRecords<Requirement>(options.controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    limit,
  });
}

export function createRequirement(
  options: RequirementStoreOptions,
  input: CreateRequirementInput,
): Requirement {
  const requirementId = id(input.requirementId);
  const at = nowIso(options);
  const requirement: Requirement = {
    schemaVersion: 1,
    requirementId,
    legacyAliases: bounded(input.legacyAliases, 20, 160),
    title: String(input.title ?? '').trim().slice(0, 500),
    outcomeStatement: String(input.outcomeStatement ?? '').trim().slice(0, 2_000),
    acceptanceCriteria: bounded(input.acceptanceCriteria, 50),
    requiredDeliveryReferences: bounded(input.requiredDeliveryReferences, 50),
    state: 'planned',
    needsAttention: false,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    auditRefs: [],
  };
  if (!requirement.title || !requirement.outcomeStatement) throw new Error('REQUIREMENT_CONTENT_REQUIRED');
  withControlPlaneTransaction(options.controllerHome, (database) => {
    if (readWithin(database, requirementId)) throw new Error(`REQUIREMENT_ALREADY_EXISTS: ${requirementId}`);
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE,
      scope: SCOPE,
      key: requirementId,
      schemaVersion: SCHEMA_VERSION,
      value: requirement,
      action: 'requirement_created',
      expectedRevision: null,
    });
  });
  return requirement;
}

const ALLOWED_TRANSITIONS: Readonly<Record<RequirementState, readonly RequirementState[]>> = {
  planned: ['planned', 'active', 'waiting_for_user', 'cancelled'],
  active: ['active', 'waiting_for_user', 'done', 'cancelled'],
  waiting_for_user: ['waiting_for_user', 'planned', 'active', 'cancelled'],
  done: ['done', 'cancelled'],
  cancelled: ['cancelled'],
};

export function updateRequirement(
  options: RequirementStoreOptions,
  input: {
    requirementId: string;
    action: string;
    mutate: (current: Requirement) => Requirement;
  },
): Requirement {
  const requirementId = id(input.requirementId);
  return withControlPlaneTransaction(options.controllerHome, (database) => {
    const current = readWithin(database, requirementId);
    if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
    const next = input.mutate(current.value);
    if (!ALLOWED_TRANSITIONS[current.value.state].includes(next.state)) {
      throw new Error(`REQUIREMENT_STATE_TRANSITION_INVALID: ${current.value.state} -> ${next.state}`);
    }
    if (next.requirementId !== requirementId) throw new Error('REQUIREMENT_ID_IMMUTABLE');
    const updated: Requirement = {
      ...next,
      schemaVersion: 1,
      revision: current.value.revision + 1,
      updatedAt: nowIso(options),
    };
    return writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE,
      scope: SCOPE,
      key: requirementId,
      schemaVersion: SCHEMA_VERSION,
      value: updated,
      action: input.action,
      expectedRevision: current.revision,
    }).value;
  });
}

export function setRequirementPlan(
  options: RequirementStoreOptions,
  input: { requirementId: string; planId: string; action?: string },
): Requirement {
  return updateRequirement(options, {
    requirementId: input.requirementId,
    action: input.action ?? 'requirement_active_plan_bound',
    mutate: (current) => ({ ...current, activePlanId: id(input.planId) }),
  });
}
