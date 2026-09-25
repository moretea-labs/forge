import {
  listUserRequests,
  recordUserRequest,
  resolveUserRequest,
  type CreateUserRequestInput,
  type UserRequest,
} from '../../../../packages/kernel/identity/api/index';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  type HandoffCreationReason,
  type HandoffInboxStore,
  type HandoffItem,
  type HandoffStatus,
  isTerminalHandoffStatus,
} from './types';

export interface HandoffInboxStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface HandoffInboxStoreOptions extends HandoffInboxStoreLocation {
  now?: () => string;
}

export type CreateHandoffInput = Omit<HandoffItem, 'schemaVersion' | 'status' | 'createdAt' | 'updatedAt'> & {
  status?: HandoffStatus;
  createdAt?: string;
  updatedAt?: string;
};

export interface ListHandoffOptions extends HandoffInboxStoreOptions {
  status?: HandoffStatus | 'active' | 'all';
  limit?: number;
  detailLevel?: 'summary' | 'detail' | 'raw';
}

export interface ResolveHandoffInput {
  decision: string;
  resolver: string;
}

export interface HandoffItemSummary {
  id: string;
  repoId: string;
  workId?: string;
  title: string;
  severity: HandoffItem['severity'];
  status: HandoffStatus;
  reason: string;
  creationReason?: HandoffCreationReason;
  updatedAt: string;
  blockingDecision?: string;
}

/** Genuine person-only blockers. Mechanical failures stay in their owning runtime domain. */
export const HANDOFF_ELIGIBLE_REASONS = new Set<HandoffCreationReason>([
  'policy_approval_required',
  'ambiguous_outcome',
  'missing_authorization',
  'invalid_objective',
  'destructive_action_requires_confirmation',
]);

interface HandoffMigrationMarker {
  schemaVersion: 1;
  repoId: string;
  migratedAt: string;
  legacyItemCount: number;
  migratedUserRequestCount: number;
  skippedMechanicalCount: number;
  archivedPath?: string;
}

function nowIso(options: HandoffInboxStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function usesCanonicalUserRequestStore(
  options: HandoffInboxStoreOptions,
): options is HandoffInboxStoreOptions & { controllerHome: string; repoId: string } {
  return Boolean(options.controllerHome && options.repoId && !options.root);
}

function withHandoffInboxWriteLock<T>(
  options: HandoffInboxStoreOptions,
  owner: string,
  operation: () => T,
): T {
  if (!options.controllerHome || !options.repoId || options.root) return operation();
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: 'handoff-inbox-migration' },
    owner,
    operation,
  );
}

export function handoffInboxRoot(location: HandoffInboxStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('handoff inbox requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'handoff-inbox');
  mkdirSync(root, { recursive: true });
  return root;
}

export function handoffInboxPath(location: HandoffInboxStoreLocation): string {
  return join(handoffInboxRoot(location), 'index.json');
}

function handoffMigrationMarkerPath(options: HandoffInboxStoreOptions & { controllerHome: string; repoId: string }): string {
  return join(
    options.controllerHome,
    'system',
    'user-requests',
    'migrations',
    `handoff-inbox-${sanitizeFileComponent(options.repoId)}.json`,
  );
}

export function emptyHandoffInboxStore(updatedAt: string): HandoffInboxStore {
  return { schemaVersion: 1, updatedAt, items: [] };
}

function readLegacyHandoffInboxStore(options: HandoffInboxStoreOptions): HandoffInboxStore {
  return readJsonFile<HandoffInboxStore>(handoffInboxPath(options), emptyHandoffInboxStore(nowIso(options)));
}

export function shouldCreateHandoff(reason: HandoffCreationReason | string | undefined): boolean {
  if (!reason) return false;
  return HANDOFF_ELIGIBLE_REASONS.has(reason as HandoffCreationReason);
}

function userActionForHandoff(item: Pick<HandoffItem, 'creationReason'>): CreateUserRequestInput['actionRequired'] | undefined {
  return item.creationReason === 'missing_authorization' || item.creationReason === 'policy_approval_required'
    ? 'grant_permission'
    : item.creationReason === 'destructive_action_requires_confirmation'
      ? 'confirm_destructive'
      : item.creationReason === 'ambiguous_outcome' || item.creationReason === 'invalid_objective'
        ? 'product_decision'
        : undefined;
}

function canonicalUserRequestInput(item: HandoffItem): CreateUserRequestInput | undefined {
  const actionRequired = userActionForHandoff(item);
  if (!actionRequired) return undefined;
  const rootCauseKey = ['user-request', item.repoId, item.workId ?? 'repo', item.creationReason ?? 'decision', item.reason].join(':');
  return {
    requestId: item.canonicalUserRequestId?.trim() || item.id,
    kind: actionRequired === 'product_decision' ? 'user_decision_request' : 'user_action_request',
    rootCauseKey,
    title: item.title,
    summary: item.summary,
    actionRequired,
    targetScope: {
      scopeKind: item.workId ? 'work' : 'repository',
      scopeId: item.workId ?? item.repoId,
      repoId: item.repoId,
      ...(item.workId ? { workId: item.workId } : {}),
    },
    presentation: {
      legacyHandoffId: item.id,
      severity: item.severity,
      creationReason: item.creationReason,
      reason: item.reason,
      currentState: item.currentState as unknown as Record<string, unknown>,
      attemptedActions: item.attemptedActions,
      evidenceRefs: item.evidenceRefs,
      blockingDecision: item.blockingDecision,
      recommendedDecision: item.recommendedDecision,
      recommendedPrompt: item.recommendedPrompt,
      recommendedContinuationPrompt: item.recommendedContinuationPrompt,
      approvalAction: item.approvalAction,
      suggestedNextActions: item.suggestedNextActions,
    },
  };
}

function projectedStatus(request: UserRequest): HandoffStatus {
  if (request.status === 'pending') return 'pending';
  const decision = request.resolution?.decision.trim().toLowerCase() ?? '';
  return request.status === 'cancelled' || decision === 'dismissed' || decision.startsWith('dismissed:')
    ? 'dismissed'
    : 'resolved';
}

function projectedCreationReason(value: string | undefined): HandoffCreationReason | undefined {
  return value && HANDOFF_ELIGIBLE_REASONS.has(value as HandoffCreationReason)
    ? value as HandoffCreationReason
    : undefined;
}

function projectUserRequest(request: UserRequest, fallbackRepoId: string): HandoffItem {
  const presentation = request.presentation;
  const repoId = request.targetScope?.repoId ?? fallbackRepoId;
  const workId = request.targetScope?.workId;
  const id = presentation?.legacyHandoffId?.trim() || request.requestId;
  const status = projectedStatus(request);
  return {
    schemaVersion: 1,
    id,
    repoId,
    ...(workId ? { workId } : {}),
    canonicalUserRequestId: request.requestId,
    title: request.title,
    severity: presentation?.severity ?? 'needs_review',
    status,
    reason: presentation?.reason ?? request.summary,
    creationReason: projectedCreationReason(presentation?.creationReason),
    summary: request.summary,
    currentState: (presentation?.currentState ?? {
      repoId,
      ...(workId ? { workId } : {}),
      statusSummary: status === 'pending' ? 'waiting for user action or decision' : 'user request resolved',
    }) as unknown as HandoffItem['currentState'],
    attemptedActions: presentation?.attemptedActions ?? [],
    evidenceRefs: (presentation?.evidenceRefs ?? []) as HandoffItem['evidenceRefs'],
    blockingDecision: presentation?.blockingDecision,
    recommendedDecision: presentation?.recommendedDecision ?? 'Complete the requested user action or decision.',
    recommendedPrompt: presentation?.recommendedPrompt ?? `Resolve UserRequest ${request.requestId}.`,
    recommendedContinuationPrompt: presentation?.recommendedContinuationPrompt,
    approvalAction: presentation?.approvalAction as HandoffItem['approvalAction'],
    suggestedNextActions: (presentation?.suggestedNextActions ?? []) as HandoffItem['suggestedNextActions'],
    decision: request.resolution?.decision,
    resolver: request.resolution?.resolvedBy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function userRequestsForRepository(
  options: HandoffInboxStoreOptions & { controllerHome: string; repoId: string },
): UserRequest[] {
  return listUserRequests(options.controllerHome, 'all')
    .filter((request) => request.targetScope?.repoId === options.repoId);
}

function requestForHandoffId(
  options: HandoffInboxStoreOptions & { controllerHome: string; repoId: string },
  id: string,
): UserRequest | undefined {
  const normalized = sanitizeFileComponent(id);
  return userRequestsForRepository(options).find((request) => (
    request.requestId === normalized
    || request.presentation?.legacyHandoffId === normalized
  ));
}

/**
 * One-time authority migration. Genuine human Handoffs become canonical
 * UserRequests; mechanical/worker-review rows are archived as history only.
 * After the marker is written, the legacy index is never read again.
 */
export function migrateLegacyHandoffInbox(
  options: HandoffInboxStoreOptions & { controllerHome: string; repoId: string },
): HandoffMigrationMarker {
  const markerPath = handoffMigrationMarkerPath(options);
  if (existsSync(markerPath)) return readJsonFile<HandoffMigrationMarker>(markerPath);
  return withHandoffInboxWriteLock(options, `migrate-handoff-inbox:${options.repoId}`, () => {
    if (existsSync(markerPath)) return readJsonFile<HandoffMigrationMarker>(markerPath);
    const legacyPath = handoffInboxPath(options);
    const legacyStore = existsSync(legacyPath)
      ? readJsonFile<HandoffInboxStore>(legacyPath, emptyHandoffInboxStore(nowIso(options)))
      : emptyHandoffInboxStore(nowIso(options));
    let migratedUserRequestCount = 0;
    let skippedMechanicalCount = 0;
    for (const item of legacyStore.items) {
      const input = canonicalUserRequestInput(item);
      if (!input) {
        skippedMechanicalCount += 1;
        continue;
      }
      let request = recordUserRequest(options.controllerHome, input);
      if (isTerminalHandoffStatus(item.status) && request.status === 'pending') {
        request = resolveUserRequest(options.controllerHome, {
          requestId: request.requestId,
          decision: item.decision?.trim() || item.status,
          resolvedBy: item.resolver?.trim() || 'handoff-migration',
        });
      }
      void request;
      migratedUserRequestCount += 1;
    }
    const migratedAt = nowIso(options);
    let archivedPath: string | undefined;
    const marker: HandoffMigrationMarker = {
      schemaVersion: 1,
      repoId: options.repoId,
      migratedAt,
      legacyItemCount: legacyStore.items.length,
      migratedUserRequestCount,
      skippedMechanicalCount,
    };
    mkdirSync(dirname(markerPath), { recursive: true });
    writeJsonAtomic(markerPath, marker);
    if (existsSync(legacyPath)) {
      archivedPath = `${legacyPath}.migrated-${Date.now()}`;
      try {
        renameSync(legacyPath, archivedPath);
      } catch {
        archivedPath = undefined;
      }
    }
    const persisted = { ...marker, ...(archivedPath ? { archivedPath } : {}) };
    if (archivedPath) writeJsonAtomic(markerPath, persisted);
    return persisted;
  });
}

export function readHandoffInboxStore(options: HandoffInboxStoreOptions): HandoffInboxStore {
  if (!usesCanonicalUserRequestStore(options)) return readLegacyHandoffInboxStore(options);
  migrateLegacyHandoffInbox(options);
  const items = userRequestsForRepository(options).map((request) => projectUserRequest(request, options.repoId));
  const updatedAt = items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, nowIso(options));
  return { schemaVersion: 1, updatedAt, items };
}

export function createHandoffItem(options: HandoffInboxStoreOptions, input: CreateHandoffInput): HandoffItem {
  if (input.creationReason && !shouldCreateHandoff(input.creationReason)) {
    throw new Error(`handoff creation reason is not eligible: ${input.creationReason}`);
  }
  const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
  const item: HandoffItem = {
    ...input,
    id: sanitizeFileComponent(input.id),
    schemaVersion: 1,
    status: input.status ?? 'pending',
    attemptedActions: (input.attemptedActions ?? []).slice(0, 20),
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 20),
    suggestedNextActions: (input.suggestedNextActions ?? []).slice(0, 8),
    recommendedContinuationPrompt: input.recommendedContinuationPrompt ?? input.recommendedPrompt,
    createdAt: at,
    updatedAt: input.updatedAt ?? at,
  };
  if (!usesCanonicalUserRequestStore(options)) {
    throw new Error('HANDOFF_LEGACY_STORE_READ_ONLY: provide controllerHome + repoId so UserRequest owns the durable write');
  }
  migrateLegacyHandoffInbox(options);
  const requestInput = canonicalUserRequestInput(item);
  if (!requestInput) {
    throw new Error('HANDOFF_USER_REQUEST_REQUIRED: mechanical failures must remain in their owning runtime domain');
  }
  const request = recordUserRequest(options.controllerHome, requestInput);
  return projectUserRequest(request, options.repoId);
}

export function listHandoffItems(options: ListHandoffOptions): HandoffItem[] {
  const store = readHandoffInboxStore(options);
  const status = options.status ?? 'pending';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return store.items
    .filter((item) => {
      if (status === 'all') return true;
      if (status === 'active') return !isTerminalHandoffStatus(item.status);
      return item.status === status;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function countHandoffItems(options: Omit<ListHandoffOptions, 'limit' | 'detailLevel'>): number {
  const store = readHandoffInboxStore(options);
  const status = options.status ?? 'pending';
  return store.items.reduce((count, item) => {
    if (status === 'all') return count + 1;
    if (status === 'active') return count + (isTerminalHandoffStatus(item.status) ? 0 : 1);
    return count + (item.status === status ? 1 : 0);
  }, 0);
}

export function summarizeHandoffItem(item: HandoffItem): HandoffItemSummary {
  return {
    id: item.id,
    repoId: item.repoId,
    workId: item.workId,
    title: item.title,
    severity: item.severity,
    status: item.status,
    reason: item.reason.slice(0, 240),
    creationReason: item.creationReason,
    updatedAt: item.updatedAt,
    blockingDecision: item.blockingDecision,
  };
}

export function getHandoffItem(options: HandoffInboxStoreOptions, id: string): HandoffItem | undefined {
  if (!usesCanonicalUserRequestStore(options)) {
    const sanitizedId = sanitizeFileComponent(id);
    return readLegacyHandoffInboxStore(options).items.find((item) => item.id === sanitizedId);
  }
  migrateLegacyHandoffInbox(options);
  const request = requestForHandoffId(options, id);
  return request ? projectUserRequest(request, options.repoId) : undefined;
}

function setHandoffStatus(
  options: HandoffInboxStoreOptions,
  id: string,
  status: HandoffStatus,
  patch: Partial<Pick<HandoffItem, 'decision' | 'resolver'>> = {},
): HandoffItem {
  const sanitizedId = sanitizeFileComponent(id);
  if (!usesCanonicalUserRequestStore(options)) {
    throw new Error('HANDOFF_LEGACY_STORE_READ_ONLY: legacy Handoff records are migration input only');
  }
  migrateLegacyHandoffInbox(options);
  const request = requestForHandoffId(options, sanitizedId);
  if (!request) throw new Error(`handoff not found: ${sanitizedId}`);
  if (status === 'acknowledged') return projectUserRequest(request, options.repoId);
  const resolved = request.status === 'pending'
    ? resolveUserRequest(options.controllerHome, {
        requestId: request.requestId,
        decision: patch.decision?.trim() || status,
        resolvedBy: patch.resolver?.trim() || 'system',
      })
    : request;
  return projectUserRequest(resolved, options.repoId);
}

export function acknowledgeHandoffItem(options: HandoffInboxStoreOptions, id: string): HandoffItem {
  return setHandoffStatus(options, id, 'acknowledged');
}

export function resolveHandoffItem(
  options: HandoffInboxStoreOptions,
  id: string,
  input?: ResolveHandoffInput,
): HandoffItem {
  return setHandoffStatus(options, id, 'resolved', {
    decision: input?.decision?.trim().slice(0, 1_000) || 'resolved',
    resolver: input?.resolver?.trim().slice(0, 200) || 'system',
  });
}

export function dismissHandoffItem(
  options: HandoffInboxStoreOptions,
  id: string,
  input?: ResolveHandoffInput,
): HandoffItem {
  return setHandoffStatus(options, id, 'dismissed', {
    decision: input?.decision?.trim().slice(0, 1_000) || 'dismissed',
    resolver: input?.resolver?.trim().slice(0, 200) || 'system',
  });
}
