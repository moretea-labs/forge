import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneRecord,
  type SqliteDatabase,
} from './sqlite-store';
import { isRepositoryCompletionReceipt, type WorkContract } from '../facade/types';

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
  /** @deprecated Migration compatibility pointer only. Current Plan.requirementId is the relationship authority. */
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

export function isLegacyMachineRequirementWait(requirement: Pick<Requirement, 'state' | 'attentionSummary'>): boolean {
  return requirement.state === 'waiting_for_user'
    && /^Work .+ delivered machine-valid evidence \(.+\); ChatGPT\/user semantic acceptance is still required\.$/.test(requirement.attentionSummary ?? '');
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
  waiting_for_user: ['waiting_for_user', 'planned', 'active', 'done', 'cancelled'],
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

export interface RequirementCompletionInput {
  requirementId: string;
  work: Pick<WorkContract,
    | 'workId'
    | 'requirementId'
    | 'status'
    | 'phase'
    | 'evidenceState'
    | 'completionOutcome'
    | 'completionReceipt'
  >;
}

/**
 * Project machine-complete Work delivery evidence into a Requirement without
 * asserting Requirement-level semantic acceptance. A Work is only one Plan-step
 * execution fact; it must not move the whole Requirement to waiting_for_user
 * while sibling/current Plan slices still exist. Requirement acceptance is a
 * separate lifecycle decision after current Plan/Work authority converges.
 *
 * The legacy function name is retained for compatibility with completion
 * callers. Its authority is evidence projection only, not semantic completion.
 */
export function completeRequirementFromWork(
  options: RequirementStoreOptions,
  input: RequirementCompletionInput,
): Requirement {
  const requirementId = id(input.requirementId);
  const current = readRequirement(options, requirementId);
  if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
  if (current.value.state === 'done') return current.value;
  if (current.value.state === 'cancelled') throw new Error('REQUIREMENT_CANCELLED');

  const work = input.work;
  if (work.requirementId !== requirementId) throw new Error('REQUIREMENT_WORK_IDENTITY_MISMATCH');
  if (work.status !== 'completed') throw new Error('REQUIREMENT_WORK_NOT_COMPLETED');
  if (work.phase !== 'cleanup') throw new Error('REQUIREMENT_WORK_CLEANUP_REQUIRED');
  if (work.evidenceState !== 'valid') throw new Error('REQUIREMENT_WORK_EVIDENCE_NOT_VALID');
  if (!work.completionOutcome) throw new Error('REQUIREMENT_WORK_COMPLETION_OUTCOME_REQUIRED');
  if (work.completionOutcome === 'superseded') throw new Error('REQUIREMENT_WORK_OUTCOME_NOT_COMPLETED');

  const receipt = work.completionReceipt;
  if (!receipt) throw new Error('REQUIREMENT_WORK_COMPLETION_RECEIPT_REQUIRED');
  if (receipt.workId !== work.workId) throw new Error('REQUIREMENT_WORK_RECEIPT_IDENTITY_MISMATCH');
  if (!isRepositoryCompletionReceipt(receipt)) throw new Error('REQUIREMENT_WORK_REPOSITORY_RECEIPT_REQUIRED');
  if (receipt.delivery.kind === 'superseded' || receipt.delivery.status !== 'integrated' || !receipt.delivery.reachable) throw new Error('REQUIREMENT_WORK_DELIVERY_NOT_PROVEN');
  if (!['complete', 'maintenance_warning'].includes(receipt.cleanup.status) || receipt.cleanup.blockers.length > 0) throw new Error('REQUIREMENT_WORK_CLEANUP_NOT_PROVEN');

  if (current.value.auditRefs.includes(receipt.receiptId)) return current.value;
  return updateRequirement(options, {
    requirementId,
    action: 'requirement_delivery_evidence_recorded',
    mutate: (latest) => {
      // Preserve concurrent terminal or genuinely user-blocked semantic state.
      // Older V2 builds generated waiting_for_user from a single Work receipt;
      // recognize that exact compatibility message and repair it back to active.
      if (latest.state === 'done') return latest;
      if (latest.state === 'cancelled') throw new Error('REQUIREMENT_CANCELLED');
      const legacyMachineWait = latest.state === 'waiting_for_user'
        && /^Work .+ delivered machine-valid evidence \(.+\); ChatGPT\/user semantic acceptance is still required\.$/.test(latest.attentionSummary ?? '');
      const preserveSemanticWait = latest.state === 'waiting_for_user' && !legacyMachineWait;
      return {
        ...latest,
        state: preserveSemanticWait ? 'waiting_for_user' : 'active',
        needsAttention: preserveSemanticWait ? latest.needsAttention : false,
        attentionSummary: preserveSemanticWait ? latest.attentionSummary : undefined,
        auditRefs: Array.from(new Set([...latest.auditRefs, receipt.receiptId])).slice(-50),
      };
    },
  });
}
