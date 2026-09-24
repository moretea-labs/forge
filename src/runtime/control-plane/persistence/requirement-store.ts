import {
  listControlPlaneRecords,
  listControlPlaneRecordsWithinTransaction,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneRecord,
  type SqliteDatabase,
} from './sqlite-store';
import { isRepositoryCompletionReceipt, type WorkContract } from '../facade/types';
import { REQUIREMENT_STATE_TRANSITIONS, type RequirementState } from '../../../../packages/kernel/goal/api/index';
export { REQUIREMENT_STATES, type RequirementState } from '../../../../packages/kernel/goal/api/index';

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
  semanticAcceptance?: {
    reviewer: string;
    rationale: string;
    planIds: string[];
    acceptedAt: string;
  };
  /** Semantic authored-context revision. Legacy rows normalize to semantic revision 1 until first thin semantic write. */
  semanticRevision?: number;
  /** Timestamp of the authored semantic content; mechanical Requirement updates must not change it. */
  semanticUpdatedAt?: string;
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
  /** Authority-derived provenance only; raw transports must not pass arbitrary audit refs. */
  auditRefs?: string[];
}

export type SemanticRequirementState = 'open' | 'completed' | 'cancelled';

export interface RequirementSemanticView {
  requirementId: string;
  revision: number;
  title: string;
  outcomeStatement: string;
  acceptanceCriteria: string[];
  requiredDeliveryReferences: string[];
  state: SemanticRequirementState;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementRevisionRecord extends RequirementSemanticView {
  schemaVersion: 1;
  recordedAt: string;
}

export interface ReviseRequirementSemanticInput {
  expectedRevision: number;
  title?: string;
  outcomeStatement?: string;
  acceptanceCriteria?: string[];
  requiredDeliveryReferences?: string[];
  state?: SemanticRequirementState;
}

const NAMESPACE = 'requirement';
const REVISION_NAMESPACE = 'requirement_revision';
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

export function currentRequirementSemanticRevision(requirement: Requirement): number {
  const semantic = Number(requirement.semanticRevision);
  return Number.isInteger(semantic) && semantic > 0 ? semantic : 1;
}

export function semanticRequirementState(requirement: Pick<Requirement, 'state'>): SemanticRequirementState {
  if (requirement.state === 'done') return 'completed';
  if (requirement.state === 'cancelled') return 'cancelled';
  return 'open';
}

export function requirementSemanticView(requirement: Requirement): RequirementSemanticView {
  return {
    requirementId: requirement.requirementId,
    revision: currentRequirementSemanticRevision(requirement),
    title: requirement.title,
    outcomeStatement: requirement.outcomeStatement,
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    requiredDeliveryReferences: [...requirement.requiredDeliveryReferences],
    state: semanticRequirementState(requirement),
    createdAt: requirement.createdAt,
    updatedAt: requirement.semanticUpdatedAt ?? requirement.createdAt,
  };
}

function requirementRevisionKey(requirementId: string, revision: number): string {
  return `${id(requirementId)}:r${revision}`;
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

export function listRequirementRevisionRecords(
  options: RequirementStoreOptions,
  requirementId?: string,
  limit = 200,
): RequirementRevisionRecord[] {
  const normalizedId = requirementId ? id(requirementId) : undefined;
  return listControlPlaneRecords<RequirementRevisionRecord>(options.controllerHome, {
    namespace: REVISION_NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1000)),
  }).map((record) => record.value)
    .filter((record) => !normalizedId || record.requirementId === normalizedId)
    .sort((left, right) => right.revision - left.revision);
}

export function reviseRequirementSemantic(
  options: RequirementStoreOptions,
  requirementIdInput: string,
  input: ReviseRequirementSemanticInput,
): Requirement {
  const requirementId = id(requirementIdInput);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('REQUIREMENT_EXPECTED_REVISION_INVALID');
  return withControlPlaneTransaction(options.controllerHome, (database) => {
    const current = readWithin(database, requirementId);
    if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
    const semanticRevision = currentRequirementSemanticRevision(current.value);
    if (semanticRevision !== input.expectedRevision) {
      throw new Error(`REQUIREMENT_REVISION_CONFLICT:${requirementId}:expected=${input.expectedRevision}:actual=${semanticRevision}`);
    }
    const at = nowIso(options);
    const revisionKey = requirementRevisionKey(requirementId, semanticRevision);
    if (!readControlPlaneRecordWithinTransaction<RequirementRevisionRecord>(database, REVISION_NAMESPACE, SCOPE, revisionKey)) {
      const archived: RequirementRevisionRecord = { schemaVersion: 1, ...requirementSemanticView(current.value), recordedAt: at };
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: REVISION_NAMESPACE, scope: SCOPE, key: revisionKey, schemaVersion: 1,
        value: archived, action: 'requirement_semantic_revision_archived', expectedRevision: null,
      });
    }
    const requestedState = input.state;
    if (requestedState === 'open' && (current.value.state === 'done' || current.value.state === 'cancelled')) {
      throw new Error(`REQUIREMENT_SEMANTIC_REOPEN_FORBIDDEN:${requirementId}:${current.value.state}`);
    }
    const legacyState: RequirementState = requestedState === 'completed'
      ? 'done'
      : requestedState === 'cancelled'
        ? 'cancelled'
        : requestedState === 'open'
          ? 'active'
          : current.value.state;
    const title = input.title === undefined ? current.value.title : String(input.title).trim().slice(0, 500);
    const outcomeStatement = input.outcomeStatement === undefined ? current.value.outcomeStatement : String(input.outcomeStatement).trim().slice(0, 2_000);
    if (!title || !outcomeStatement) throw new Error('REQUIREMENT_CONTENT_REQUIRED');
    const updated: Requirement = {
      ...current.value,
      title,
      outcomeStatement,
      acceptanceCriteria: input.acceptanceCriteria === undefined ? [...current.value.acceptanceCriteria] : bounded(input.acceptanceCriteria, 50),
      requiredDeliveryReferences: input.requiredDeliveryReferences === undefined ? [...current.value.requiredDeliveryReferences] : bounded(input.requiredDeliveryReferences, 50),
      state: legacyState,
      ...(requestedState ? { needsAttention: false, attentionSummary: undefined } : {}),
      semanticRevision: semanticRevision + 1,
      semanticUpdatedAt: at,
      revision: current.value.revision + 1,
      updatedAt: at,
    };
    return writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE, scope: SCOPE, key: requirementId, schemaVersion: SCHEMA_VERSION,
      value: updated, action: 'requirement_semantic_revised', expectedRevision: current.revision,
    }).value;
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
    auditRefs: bounded(input.auditRefs, 50),
    state: 'planned',
    needsAttention: false,
    semanticRevision: 1,
    semanticUpdatedAt: at,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  if (!requirement.title || !requirement.outcomeStatement) throw new Error('REQUIREMENT_CONTENT_REQUIRED');
  withControlPlaneTransaction(options.controllerHome, (database) => {
    if (readWithin(database, requirementId)) throw new Error(`REQUIREMENT_ALREADY_EXISTS: ${requirementId}`);
    const exclusiveCandidateRefs = requirement.auditRefs.filter(ref => ref.startsWith('cognitive-requirement-candidate:'));
    if (exclusiveCandidateRefs.length > 0) {
      const existing = listControlPlaneRecordsWithinTransaction<Requirement>(database, {
        namespace: NAMESPACE,
        scope: SCOPE,
        limit: 1000,
      });
      if (existing.length >= 1000) throw new Error('REQUIREMENT_CANDIDATE_BINDING_LOOKUP_LIMIT');
      const alreadyBound = existing.find(record => exclusiveCandidateRefs.some(ref => record.value.auditRefs.includes(ref)));
      if (alreadyBound) throw new Error('REQUIREMENT_CANDIDATE_ALREADY_PROMOTED');
    }
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

export function bindRequirementCandidateAuditRef(
  options: RequirementStoreOptions,
  requirementIdInput: string,
  candidateAuditRefInput: string,
): Requirement {
  const requirementId = id(requirementIdInput);
  const candidateAuditRef = String(candidateAuditRefInput ?? '').trim().slice(0, 500);
  if (!candidateAuditRef.startsWith('cognitive-requirement-candidate:')) {
    throw new Error('REQUIREMENT_CANDIDATE_AUDIT_REF_INVALID');
  }
  return withControlPlaneTransaction(options.controllerHome, (database) => {
    const records = listControlPlaneRecordsWithinTransaction<Requirement>(database, {
      namespace: NAMESPACE,
      scope: SCOPE,
      limit: 1000,
    });
    if (records.length >= 1000) throw new Error('REQUIREMENT_CANDIDATE_BINDING_LOOKUP_LIMIT');
    const bound = records.find(record => record.value.auditRefs.includes(candidateAuditRef));
    if (bound && bound.value.requirementId !== requirementId) {
      throw new Error('REQUIREMENT_CANDIDATE_ALREADY_PROMOTED');
    }
    const current = readWithin(database, requirementId);
    if (!current) throw new Error(`REQUIREMENT_NOT_FOUND: ${requirementId}`);
    if (current.value.auditRefs.includes(candidateAuditRef)) return current.value;
    const updated: Requirement = {
      ...current.value,
      auditRefs: [...new Set([...current.value.auditRefs, candidateAuditRef])].slice(-50),
      revision: current.value.revision + 1,
      updatedAt: nowIso(options),
    };
    return writeControlPlaneRecordWithinTransaction(database, {
      namespace: NAMESPACE,
      scope: SCOPE,
      key: requirementId,
      schemaVersion: SCHEMA_VERSION,
      value: updated,
      action: 'requirement_candidate_promoted',
      expectedRevision: current.revision,
    }).value;
  });
}

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
    if (next === current.value) return current.value;
    if (!REQUIREMENT_STATE_TRANSITIONS[current.value.state].includes(next.state)) {
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
