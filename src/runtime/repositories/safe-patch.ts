import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { findOccurrence, normalizeEditOperation, type EditOperation } from '../editing/edit-operation-contract';
import { getToolPolicy } from '../control-plane/tool-policy';
import {
  atomicCompareAndDeleteText,
  atomicCompareAndMoveText,
  atomicCompareAndSwapText,
  atomicCompareAndSwapTextGroup,
  atomicCreateText,
  recoverPendingAtomicTextGroups,
} from '../../effects/fs-transaction';
import { globMatches, resolveMcpPath } from '../safe-tooling/path-policy';
import type { RepositoryRecord } from '../../core/repository/types';

export interface SafePatchFingerprint {
  path: string;
  exists: boolean;
  sha256?: string;
}

export interface SafePatchChunkPlan {
  index: number;
  operationCount: number;
  paths: string[];
  fingerprints: SafePatchFingerprint[];
}

export interface SafePatchPlan {
  operationCount: number;
  chunkSize: number;
  chunks: SafePatchChunkPlan[];
  warnings: string[];
}

export interface SafePatchFailureContext {
  line?: number;
  before?: string;
  focus?: string;
  after?: string;
}

export interface SafePatchPreflightFailure {
  chunkIndex: number;
  operationIndex: number;
  type: EditOperation['type'];
  path: string;
  code:
    | 'PATH_DENIED'
    | 'TARGET_MISSING'
    | 'CREATE_TARGET_EXISTS'
    | 'REPLACEMENT_TEXT_NOT_FOUND'
    | 'ANCHOR_NOT_FOUND'
    | 'NO_CHANGE'
    | 'STALE_FILE_SHA'
    | 'MOVE_TARGET_EXISTS'
    | 'SEMANTIC_GROUP_UNSUPPORTED'
    | 'APPLY_FAILED';
  message: string;
  currentSha256?: string;
  expectedSha256?: string;
  context?: SafePatchFailureContext;
}

const DEFAULT_SAFE_PATCH_CHUNK_SIZE = 40;
const MAX_SAFE_PATCH_CHUNK_SIZE = 100;
const MAX_TEXT_PREVIEW = 240;

type NormalizedOperation = EditOperation & { __originalIndex: number; __semanticGroup?: string };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function normalizeOperation(entry: Record<string, unknown>, originalIndex: number): NormalizedOperation {
  const path = String(entry.path ?? '').trim();
  if (!path) throw new Error(`SAFE_PATCH_OPERATION_INVALID: operation ${originalIndex + 1} path is required`);
  try {
    const semanticGroup = String(entry.semantic_group ?? entry.semanticGroup ?? '').trim();
    return {
      ...normalizeEditOperation({ ...entry, path }),
      __originalIndex: originalIndex,
      ...(semanticGroup ? { __semanticGroup: semanticGroup } : {}),
    } as NormalizedOperation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAFE_PATCH_OPERATION_INVALID: operation ${originalIndex + 1} ${message}`);
  }
}

export function normalizeSafePatchOperations(value: unknown): EditOperation[] {
  return objectEntries(value).map((entry, index) => stripInternalIndex(normalizeOperation(entry, index)));
}

function normalizedSafePatchOperations(value: unknown): NormalizedOperation[] {
  return objectEntries(value).map((entry, index) => normalizeOperation(entry, index));
}

function stripInternalIndex(operation: NormalizedOperation): EditOperation {
  const { __originalIndex: _ignored, __semanticGroup: _semanticGroup, ...publicOperation } = operation;
  return publicOperation;
}

function chunkSize(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : DEFAULT_SAFE_PATCH_CHUNK_SIZE;
  if (!Number.isFinite(parsed)) return DEFAULT_SAFE_PATCH_CHUNK_SIZE;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_SAFE_PATCH_CHUNK_SIZE));
}

function repoRelativePath(repository: RepositoryRecord, rawPath: string): string {
  const root = resolve(repository.canonicalRoot);
  const resolved = resolve(root, rawPath.replace(/\\/g, '/'));
  const rel = relative(root, resolved).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../'))
    throw new Error(`SAFE_PATCH_PATH_DENIED: ${rawPath} escapes the repository`);
  return rel;
}

function fingerprint(repository: RepositoryRecord, rawPath: string): SafePatchFingerprint {
  const path = repoRelativePath(repository, rawPath);
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, exists: false };
  return { path, exists: true, sha256: hash(readFileSync(absolute, 'utf-8')) };
}

function currentFile(
  repository: RepositoryRecord,
  rawPath: string,
): { path: string; absolute: string; exists: boolean; content: string; sha256?: string } {
  const path = repoRelativePath(repository, rawPath);
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, absolute, exists: false, content: '' };
  const content = readFileSync(absolute, 'utf-8');
  return { path, absolute, exists: true, content, sha256: hash(content) };
}

function buildChunks(operations: NormalizedOperation[], size: number): NormalizedOperation[][] {
  const result: NormalizedOperation[][] = [];
  let current: NormalizedOperation[] = [];
  let currentPaths = new Set<string>();
  for (const operation of operations) {
    const path = operation.path.replace(/\\/g, '/');
    if (current.length >= size || currentPaths.has(path)) {
      result.push(current);
      current = [];
      currentPaths = new Set<string>();
    }
    current.push(operation);
    currentPaths.add(path);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function snippetAround(content: string, needle: string): SafePatchFailureContext {
  const lines = content.split(/\r?\n/);
  const index = needle ? content.indexOf(needle.slice(0, Math.min(needle.length, 80))) : -1;
  let lineIndex = 0;
  if (index >= 0) lineIndex = content.slice(0, index).split(/\r?\n/).length - 1;
  else {
    const trimmed = needle.trim().split(/\r?\n/).find(Boolean)?.slice(0, 21) ?? '';
    const found = trimmed ? lines.findIndex((line) => line.includes(trimmed)) : -1;
    lineIndex = Math.max(found, 0);
  }
  const before = lines
    .slice(Math.max(0, lineIndex - 3), lineIndex)
    .join('\n')
    .slice(-MAX_TEXT_PREVIEW);
  const focus = (lines[lineIndex] ?? '').slice(0, MAX_TEXT_PREVIEW);
  const after = lines
    .slice(lineIndex + 1, lineIndex + 4)
    .join('\n')
    .slice(0, MAX_TEXT_PREVIEW);
  return { line: lineIndex + 1, before, focus, after };
}

function applyTextPreview(
  operation: Exclude<EditOperation, { type: 'create' | 'write' | 'delete' }>,
  before: string,
  requireUnique = false,
): string {
  if (operation.type === 'replace') {
    let after = before;
    for (const replacement of operation.replacements) {
      if (!replacement.oldText) throw new Error('replacement oldText is empty');
      const index = after.indexOf(replacement.oldText);
      if (index < 0) throw new Error('replacement text not found');
      if (requireUnique && after.indexOf(replacement.oldText, index + 1) >= 0)
        throw new Error(
          'replacement text is ambiguous; provide unique context or an exact file version for bulk replacement',
        );
      after = replacement.replaceAll
        ? after.split(replacement.oldText).join(replacement.newText)
        : after.slice(0, index) + replacement.newText + after.slice(index + replacement.oldText.length);
    }
    return after;
  }
  if (operation.type === 'prepend') return operation.content + before;
  if (operation.type === 'append') return before + operation.content;
  const anchored = operation as Extract<EditOperation, { type: 'insert_before' | 'insert_after' }>;
  if (!anchored.anchor) throw new Error('anchor is empty');
  const occurrence = Math.max(1, Math.trunc(anchored.occurrence ?? 1));
  const index = findOccurrence(before, anchored.anchor, occurrence);
  if (index < 0) throw new Error('anchor occurrence ' + occurrence + ' not found');
  if (requireUnique && (occurrence !== 1 || before.indexOf(anchored.anchor, index + 1) >= 0))
    throw new Error('anchor is ambiguous; provide unique context or an exact file version for ordinal insertion');
  const insertion = anchored.type === 'insert_before' ? index : index + anchored.anchor.length;
  return before.slice(0, insertion) + anchored.content + before.slice(insertion);
}

function operationRepositoryPaths(repository: RepositoryRecord, operation: EditOperation): string[] {
  const path = repoRelativePath(repository, operation.path);
  return operation.type === 'move' ? [path, repoRelativePath(repository, operation.toPath)] : [path];
}

export function buildSafePatchPlan(
  repository: RepositoryRecord,
  input: { operations: unknown; chunkSize?: unknown },
): SafePatchPlan {
  const operations = normalizedSafePatchOperations(input.operations);
  const size = chunkSize(input.chunkSize);
  const grouped = buildChunks(operations, size);
  const warnings: string[] = [];
  if (operations.length === 0) warnings.push('No operations were provided.');
  if (grouped.length > 1)
    warnings.push(
      `Operations will be applied in ${grouped.length} deterministic chunk(s) of at most ${size}, with repeated paths isolated into separate revisions.`,
    );
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const operation of operations) {
    for (const path of operationRepositoryPaths(repository, operation)) {
      if (seen.has(path)) repeated.add(path);
      seen.add(path);
    }
  }
  for (const path of repeated) warnings.push(`Path appears multiple times and will be split across revisions: ${path}`);
  return {
    operationCount: operations.length,
    chunkSize: size,
    chunks: grouped.map((group, index) => {
      const paths = [...new Set(group.flatMap((operation) => operationRepositoryPaths(repository, operation)))].sort();
      return {
        index: index + 1,
        operationCount: group.length,
        paths,
        fingerprints: paths.map((path) => fingerprint(repository, path)),
      };
    }),
    warnings,
  };
}

/**
 * Sessionless Safe Patch migration path. The planner keeps independent
 * operations independent by default and only forms a larger atomic group when
 * the caller supplies the same semantic_group key.
 */
/** Whether every operation can be routed through the sessionless mutation planner. */
export function isSessionlessTextEditBatch(operations: unknown): boolean {
  return (
    Array.isArray(operations) &&
    operations.length > 0 &&
    operations.every(
      (operation) =>
        typeof operation === 'object' &&
        operation !== null &&
        ['create', 'replace', 'write', 'prepend', 'append', 'insert_before', 'insert_after', 'delete', 'move'].includes(
          String((operation as Record<string, unknown>).type ?? ''),
        ),
    )
  );
}

type SessionlessReceipt = { path: string; toPath?: string; beforeSha256?: string; afterSha256?: string };

type SessionlessGroupResult = {
  groupId: string;
  status: 'applied' | 'failed';
  operationIndexes: number[];
  paths: string[];
  changedFiles: string[];
  failures: SafePatchPreflightFailure[];
  receipts: SessionlessReceipt[];
};

type SessionlessSafePatchResult = {
  status: 'applied' | 'partial' | 'failed';
  sessionless: true;
  createdSession: false;
  changedFiles: string[];
  appliedChunks: Array<{ index: number; operationCount: number; paths: string[] }>;
  failures: SafePatchPreflightFailure[];
  receipt?: SessionlessReceipt;
  receipts?: SessionlessReceipt[];
  groups?: SessionlessGroupResult[];
  plan: SafePatchPlan;
};

function sessionlessFailure(plan: SafePatchPlan, failures: SafePatchPreflightFailure[]): SessionlessSafePatchResult {
  return {
    status: 'failed',
    sessionless: true,
    createdSession: false,
    changedFiles: [],
    appliedChunks: [],
    failures,
    plan,
  };
}

function sessionlessSuccess(
  plan: SafePatchPlan,
  path: string,
  receipt: { toPath?: string; beforeSha256?: string; afterSha256?: string },
): SessionlessSafePatchResult {
  return {
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: [path],
    appliedChunks: [{ index: 1, operationCount: 1, paths: [path] }],
    failures: [],
    receipt: { path, ...receipt },
    plan,
  };
}

function applySessionlessCreate(
  repository: RepositoryRecord,
  path: string,
  operation: Extract<EditOperation, { type: 'create' }>,
  plan: SafePatchPlan,
): SessionlessSafePatchResult {
  const base = { chunkIndex: 1, operationIndex: 1, type: operation.type, path };
  const current = currentFile(repository, path);
  if (current.exists)
    return sessionlessFailure(plan, [
      {
        ...base,
        code: 'CREATE_TARGET_EXISTS',
        message: `create target already exists: ${path}`,
        currentSha256: current.sha256,
      },
    ]);
  try {
    return sessionlessSuccess(plan, path, atomicCreateText(repository.canonicalRoot, path, operation.content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: SafePatchPreflightFailure['code'] = message.startsWith('CREATE_TARGET_EXISTS:')
      ? 'CREATE_TARGET_EXISTS'
      : 'APPLY_FAILED';
    return sessionlessFailure(plan, [{ ...base, code, message, currentSha256: currentFile(repository, path).sha256 }]);
  }
}

function sessionlessMoveErrorCode(message: string): SafePatchPreflightFailure['code'] {
  if (message.startsWith('STALE_FILE_SHA:')) return 'STALE_FILE_SHA';
  if (message.startsWith('TARGET_MISSING:')) return 'TARGET_MISSING';
  if (message.startsWith('MOVE_TARGET_EXISTS:')) return 'MOVE_TARGET_EXISTS';
  if (message.startsWith('NO_CHANGE:')) return 'NO_CHANGE';
  return 'APPLY_FAILED';
}

function applySessionlessMove(
  repository: RepositoryRecord,
  path: string,
  operation: Extract<EditOperation, { type: 'move' }>,
  plan: SafePatchPlan,
  allowedPaths?: unknown,
): SessionlessSafePatchResult {
  const base = { chunkIndex: 1, operationIndex: 1, type: operation.type, path };
  let toPath: string;
  try {
    toPath = resolveSessionlessPath(repository, operation.toPath, allowedPaths);
  } catch (error) {
    return sessionlessFailure(plan, [
      {
        ...base,
        path: operation.toPath,
        code: 'PATH_DENIED',
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
  if (toPath === path) {
    return sessionlessFailure(plan, [
      { ...base, code: 'NO_CHANGE', message: 'move source and destination are identical' },
    ]);
  }
  const current = currentFile(repository, path);
  if (!current.exists || !current.sha256)
    return sessionlessFailure(plan, [{ ...base, code: 'TARGET_MISSING', message: 'move source is no longer present' }]);
  if (operation.expectedSha256 !== current.sha256)
    return sessionlessFailure(plan, [
      {
        ...base,
        code: 'STALE_FILE_SHA',
        message: `stale file version for ${path}`,
        currentSha256: current.sha256,
        expectedSha256: operation.expectedSha256,
        context: snippetAround(current.content, ''),
      },
    ]);
  try {
    const receipt = atomicCompareAndMoveText(repository.canonicalRoot, path, toPath, operation.expectedSha256);
    return {
      status: 'applied',
      sessionless: true,
      createdSession: false,
      changedFiles: [path, toPath],
      appliedChunks: [{ index: 1, operationCount: 1, paths: [path, toPath] }],
      failures: [],
      receipt: { path, toPath, ...receipt },
      receipts: [{ path, toPath, ...receipt }],
      plan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = sessionlessMoveErrorCode(message);
    const latest = currentFile(repository, path);
    return sessionlessFailure(plan, [
      {
        ...base,
        code,
        message,
        currentSha256: latest.sha256,
        expectedSha256: operation.expectedSha256,
        context: snippetAround(latest.content, ''),
      },
    ]);
  }
}

function applySessionlessDelete(
  repository: RepositoryRecord,
  path: string,
  operation: Extract<EditOperation, { type: 'delete' }>,
  plan: SafePatchPlan,
): SessionlessSafePatchResult {
  const base = { chunkIndex: 1, operationIndex: 1, type: operation.type, path };
  const current = currentFile(repository, path);
  if (!current.exists || !current.sha256)
    return sessionlessFailure(plan, [{ ...base, code: 'TARGET_MISSING', message: 'target is no longer present' }]);
  if (operation.expectedSha256 !== current.sha256)
    return sessionlessFailure(plan, [
      {
        ...base,
        code: 'STALE_FILE_SHA',
        message: `stale file version for ${path}`,
        currentSha256: current.sha256,
        expectedSha256: operation.expectedSha256,
        context: snippetAround(current.content, ''),
      },
    ]);
  try {
    return sessionlessSuccess(
      plan,
      path,
      atomicCompareAndDeleteText(repository.canonicalRoot, path, operation.expectedSha256),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: SafePatchPreflightFailure['code'] = message.startsWith('STALE_FILE_SHA:')
      ? 'STALE_FILE_SHA'
      : message.startsWith('TARGET_MISSING:')
        ? 'TARGET_MISSING'
        : 'APPLY_FAILED';
    const latest = currentFile(repository, path);
    return sessionlessFailure(plan, [
      {
        ...base,
        code,
        message,
        currentSha256: latest.sha256,
        expectedSha256: operation.expectedSha256,
        context: snippetAround(latest.content, ''),
      },
    ]);
  }
}

type SessionlessTextOperation = Exclude<EditOperation, { type: 'create' | 'delete' | 'move' }>;

function sessionlessNeedle(operation: SessionlessTextOperation): string {
  if (operation.type === 'replace') return operation.replacements[0]?.oldText ?? '';
  if (operation.type === 'insert_before' || operation.type === 'insert_after') return operation.anchor;
  return '';
}

function isRetryableLocalEdit(operation: SessionlessTextOperation): boolean {
  return operation.type !== 'write' && !operation.expectedSha256;
}

function shouldRetrySessionlessCas(retryLocal: boolean, code: string, attempt: number): boolean {
  return retryLocal && code === 'STALE_FILE_SHA' && attempt < 2;
}

function previewSessionlessText(
  operation: SessionlessTextOperation,
  currentContent: string,
  currentSha256: string,
  retryLocal: boolean,
  base: Pick<SafePatchPreflightFailure, 'chunkIndex' | 'operationIndex' | 'type' | 'path'>,
  needle: string,
): { content: string } | { failure: SafePatchPreflightFailure } {
  try {
    const content =
      operation.type === 'write' ? operation.content : applyTextPreview(operation, currentContent, retryLocal);
    if (content === currentContent)
      return {
        failure: {
          ...base,
          code: 'NO_CHANGE',
          message: 'edit operation produced no change',
          currentSha256,
        },
      };
    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const target =
      operation.type === 'replace'
        ? (operation.replacements.find((replacement) => !currentContent.includes(replacement.oldText))?.oldText ??
          needle)
        : needle;
    return {
      failure: {
        ...base,
        code: operation.type === 'replace' ? 'REPLACEMENT_TEXT_NOT_FOUND' : 'ANCHOR_NOT_FOUND',
        message,
        currentSha256,
        context: snippetAround(currentContent, target),
      },
    };
  }
}

function applySessionlessTextOperation(
  repository: RepositoryRecord,
  path: string,
  operation: SessionlessTextOperation,
  plan: SafePatchPlan,
): SessionlessSafePatchResult {
  const failureResult = (failures: SafePatchPreflightFailure[]) => sessionlessFailure(plan, failures);
  const base = { chunkIndex: 1, operationIndex: 1, type: operation.type, path };
  const retryLocal = isRetryableLocalEdit(operation);
  const needle = sessionlessNeedle(operation);

  for (let attempt = 0; ; attempt++) {
    const current = currentFile(repository, path);
    if (!current.exists || !current.sha256)
      return failureResult([{ ...base, code: 'TARGET_MISSING', message: 'target is no longer present' }]);
    if (operation.expectedSha256 && operation.expectedSha256 !== current.sha256)
      return failureResult([
        {
          ...base,
          code: 'STALE_FILE_SHA',
          message: `stale file version for ${path}`,
          currentSha256: current.sha256,
          expectedSha256: operation.expectedSha256,
          context: snippetAround(current.content, needle),
        },
      ]);

    const preview = previewSessionlessText(operation, current.content, current.sha256, retryLocal, base, needle);
    if ('failure' in preview) return failureResult([preview.failure]);

    try {
      return sessionlessSuccess(
        plan,
        path,
        atomicCompareAndSwapText(repository.canonicalRoot, path, current.sha256, preview.content),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith('STALE_FILE_SHA:') ? 'STALE_FILE_SHA' : 'APPLY_FAILED';
      if (shouldRetrySessionlessCas(retryLocal, code, attempt)) continue;
      const latest = currentFile(repository, path);
      return failureResult([
        {
          ...base,
          code,
          message,
          currentSha256: latest.sha256,
          expectedSha256: current.sha256,
          context: snippetAround(latest.content, needle),
        },
      ]);
    }
  }
}

type SessionlessMutationGroup = {
  groupId: string;
  operations: NormalizedOperation[];
};

function buildSessionlessMutationGroups(operations: NormalizedOperation[]): SessionlessMutationGroup[] {
  const groups = new Map<string, SessionlessMutationGroup>();
  for (const operation of operations) {
    const groupId = operation.__semanticGroup ?? `operation:${operation.__originalIndex + 1}`;
    const existing = groups.get(groupId);
    if (existing) existing.operations.push(operation);
    else groups.set(groupId, { groupId, operations: [operation] });
  }
  return [...groups.values()];
}

function groupOperationIndexes(group: SessionlessMutationGroup): number[] {
  return group.operations.map((operation) => operation.__originalIndex + 1);
}

function groupPaths(repository: RepositoryRecord, group: SessionlessMutationGroup): string[] {
  return [...new Set(group.operations.flatMap((operation) => operationRepositoryPaths(repository, operation)))];
}

function semanticGroupFailure(
  plan: SafePatchPlan,
  group: SessionlessMutationGroup,
  groupIndex: number,
  code: SafePatchPreflightFailure['code'],
  message: string,
): SessionlessSafePatchResult {
  const first = group.operations[0]!;
  return sessionlessFailure(plan, [
    {
      chunkIndex: groupIndex,
      operationIndex: first.__originalIndex + 1,
      type: first.type,
      path: first.path,
      code,
      message,
    },
  ]);
}

function remapSingleOperationGroup(
  result: SessionlessSafePatchResult,
  group: SessionlessMutationGroup,
  groupIndex: number,
  plan: SafePatchPlan,
): SessionlessSafePatchResult {
  const operation = group.operations[0]!;
  return {
    ...result,
    plan,
    appliedChunks: result.appliedChunks.map((chunk) => ({
      ...chunk,
      index: groupIndex,
      operationCount: 1,
    })),
    failures: result.failures.map((failure) => ({
      ...failure,
      chunkIndex: groupIndex,
      operationIndex: operation.__originalIndex + 1,
    })),
  };
}

function explicitGroupExpectedSha256(operations: Array<NormalizedOperation & SessionlessTextOperation>): {
  expectedSha256?: string;
  conflict?: string;
} {
  const hashes = [
    ...new Set(operations.flatMap((operation) => (operation.expectedSha256 ? [operation.expectedSha256] : []))),
  ];
  if (hashes.length <= 1) return { expectedSha256: hashes[0] };
  return {
    conflict: `semantic group has conflicting strict whole-file CAS preconditions: ${hashes.join(', ')}`,
  };
}

function sessionlessTextGroupPreconditionFailure(
  path: string,
  operations: Array<NormalizedOperation & SessionlessTextOperation>,
  groupIndex: number,
  current: ReturnType<typeof currentFile>,
  expectedSha256?: string,
): SafePatchPreflightFailure | undefined {
  const first = operations[0]!;
  if (!current.exists || !current.sha256) {
    return {
      chunkIndex: groupIndex,
      operationIndex: first.__originalIndex + 1,
      type: first.type,
      path,
      code: 'TARGET_MISSING',
      message: 'target is no longer present',
    };
  }
  if (!expectedSha256 || expectedSha256 === current.sha256) return undefined;
  const firstStrict = operations.find((operation) => operation.expectedSha256) ?? first;
  return {
    chunkIndex: groupIndex,
    operationIndex: firstStrict.__originalIndex + 1,
    type: firstStrict.type,
    path,
    code: 'STALE_FILE_SHA',
    message: `stale file version for ${path}`,
    currentSha256: current.sha256,
    expectedSha256,
    context: snippetAround(current.content, sessionlessNeedle(firstStrict)),
  };
}

function previewSessionlessTextGroup(
  path: string,
  operations: Array<NormalizedOperation & SessionlessTextOperation>,
  groupIndex: number,
  currentContent: string,
  currentSha256: string,
  retryLocal: boolean,
): { content: string } | { failure: SafePatchPreflightFailure } {
  let content = currentContent;
  for (const operation of operations) {
    const preview = previewSessionlessText(
      operation,
      content,
      currentSha256,
      retryLocal,
      {
        chunkIndex: groupIndex,
        operationIndex: operation.__originalIndex + 1,
        type: operation.type,
        path,
      },
      sessionlessNeedle(operation),
    );
    if ('failure' in preview) return preview;
    content = preview.content;
  }
  if (content !== currentContent) return { content };
  const first = operations[0]!;
  return {
    failure: {
      chunkIndex: groupIndex,
      operationIndex: first.__originalIndex + 1,
      type: first.type,
      path,
      code: 'NO_CHANGE',
      message: 'semantic group produced no net change',
      currentSha256,
    },
  };
}

function applySessionlessTextGroup(
  repository: RepositoryRecord,
  path: string,
  operations: Array<NormalizedOperation & SessionlessTextOperation>,
  plan: SafePatchPlan,
  groupIndex: number,
): SessionlessSafePatchResult {
  const expected = explicitGroupExpectedSha256(operations);
  if (expected.conflict) {
    const first = operations[0]!;
    return sessionlessFailure(plan, [
      {
        chunkIndex: groupIndex,
        operationIndex: first.__originalIndex + 1,
        type: first.type,
        path,
        code: 'SEMANTIC_GROUP_UNSUPPORTED',
        message: expected.conflict,
      },
    ]);
  }

  const retryLocal = !expected.expectedSha256 && operations.every((operation) => isRetryableLocalEdit(operation));
  const firstNeedle = sessionlessNeedle(operations[0]!);
  for (let attempt = 0; ; attempt++) {
    const current = currentFile(repository, path);
    const preconditionFailure = sessionlessTextGroupPreconditionFailure(
      path,
      operations,
      groupIndex,
      current,
      expected.expectedSha256,
    );
    if (preconditionFailure) return sessionlessFailure(plan, [preconditionFailure]);
    const currentSha256 = current.sha256!;
    const preview = previewSessionlessTextGroup(
      path,
      operations,
      groupIndex,
      current.content,
      currentSha256,
      retryLocal,
    );
    if ('failure' in preview) return sessionlessFailure(plan, [preview.failure]);

    try {
      const receipt = atomicCompareAndSwapText(repository.canonicalRoot, path, currentSha256, preview.content);
      return {
        status: 'applied',
        sessionless: true,
        createdSession: false,
        changedFiles: [path],
        appliedChunks: [{ index: groupIndex, operationCount: operations.length, paths: [path] }],
        failures: [],
        receipt: { path, ...receipt },
        receipts: [{ path, ...receipt }],
        plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith('STALE_FILE_SHA:') ? 'STALE_FILE_SHA' : 'APPLY_FAILED';
      if (shouldRetrySessionlessCas(retryLocal, code, attempt)) continue;
      const latest = currentFile(repository, path);
      const first = operations[0]!;
      return sessionlessFailure(plan, [
        {
          chunkIndex: groupIndex,
          operationIndex: first.__originalIndex + 1,
          type: first.type,
          path,
          code,
          message,
          currentSha256: latest.sha256,
          expectedSha256: currentSha256,
          context: snippetAround(latest.content, firstNeedle),
        },
      ]);
    }
  }
}

function applySessionlessMultiPathTextGroup(
  repository: RepositoryRecord,
  group: SessionlessMutationGroup,
  plan: SafePatchPlan,
  groupIndex: number,
  allowedPaths?: unknown,
): SessionlessSafePatchResult {
  const byPath = new Map<string, Array<NormalizedOperation & SessionlessTextOperation>>();
  try {
    for (const rawOperation of group.operations) {
      const operation = rawOperation as NormalizedOperation & SessionlessTextOperation;
      const path = resolveSessionlessPath(repository, operation.path, allowedPaths);
      const current = byPath.get(path);
      if (current) current.push(operation);
      else byPath.set(path, [operation]);
    }
  } catch (error) {
    return semanticGroupFailure(
      plan,
      group,
      groupIndex,
      'PATH_DENIED',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (byPath.size < 2) {
    return semanticGroupFailure(
      plan,
      group,
      groupIndex,
      'SEMANTIC_GROUP_UNSUPPORTED',
      'multi-path semantic group unexpectedly resolved to fewer than two paths',
    );
  }

  const retryLocal = group.operations.every((operation) => isRetryableLocalEdit(operation as SessionlessTextOperation));

  for (let attempt = 0; ; attempt++) {
    const entries: Array<{ path: string; expectedSha256: string; after: string }> = [];
    for (const [path, operations] of byPath) {
      const expected = explicitGroupExpectedSha256(operations);
      if (expected.conflict) {
        return semanticGroupFailure(plan, group, groupIndex, 'SEMANTIC_GROUP_UNSUPPORTED', expected.conflict);
      }
      const current = currentFile(repository, path);
      const preconditionFailure = sessionlessTextGroupPreconditionFailure(
        path,
        operations,
        groupIndex,
        current,
        expected.expectedSha256,
      );
      if (preconditionFailure) return sessionlessFailure(plan, [preconditionFailure]);
      const preview = previewSessionlessTextGroup(
        path,
        operations,
        groupIndex,
        current.content,
        current.sha256!,
        retryLocal,
      );
      if ('failure' in preview) return sessionlessFailure(plan, [preview.failure]);
      entries.push({ path, expectedSha256: current.sha256!, after: preview.content });
    }

    try {
      const applied = atomicCompareAndSwapTextGroup(repository.canonicalRoot, entries);
      return {
        status: 'applied',
        sessionless: true,
        createdSession: false,
        changedFiles: entries.map((entry) => entry.path),
        appliedChunks: [
          {
            index: groupIndex,
            operationCount: group.operations.length,
            paths: entries.map((entry) => entry.path),
          },
        ],
        failures: [],
        receipts: applied.receipts,
        plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stale = message.match(/^STALE_FILE_SHA: ([^:]+):/);
      const missing = message.match(/^TARGET_MISSING: (.+)$/);
      const failedPath = stale?.[1] ?? missing?.[1] ?? entries[0]!.path;
      const code: SafePatchPreflightFailure['code'] = stale
        ? 'STALE_FILE_SHA'
        : missing
          ? 'TARGET_MISSING'
          : 'APPLY_FAILED';
      if (shouldRetrySessionlessCas(retryLocal, code, attempt)) continue;
      const latest = currentFile(repository, failedPath);
      const failedOperation = byPath.get(failedPath)?.[0] ?? group.operations[0]!;
      return sessionlessFailure(plan, [
        {
          chunkIndex: groupIndex,
          operationIndex: failedOperation.__originalIndex + 1,
          type: failedOperation.type,
          path: failedPath,
          code,
          message,
          currentSha256: latest.sha256,
          expectedSha256: entries.find((entry) => entry.path === failedPath)?.expectedSha256,
          context: snippetAround(latest.content, sessionlessNeedle(failedOperation as SessionlessTextOperation)),
        },
      ]);
    }
  }
}

function executeSessionlessMutationGroup(
  repository: RepositoryRecord,
  group: SessionlessMutationGroup,
  groupIndex: number,
  plan: SafePatchPlan,
  allowedPaths?: unknown,
): SessionlessSafePatchResult {
  if (group.operations.length > 1) {
    try {
      recoverPendingTextTransactionsForOperations(repository, group.operations, allowedPaths);
    } catch (error) {
      return semanticGroupFailure(
        plan,
        group,
        groupIndex,
        'APPLY_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (group.operations.length === 1) {
    try {
      return remapSingleOperationGroup(
        applySessionlessSafePatch(repository, {
          operations: [stripInternalIndex(group.operations[0]!)],
          allowedPaths,
        }),
        group,
        groupIndex,
        plan,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return semanticGroupFailure(
        plan,
        group,
        groupIndex,
        message.startsWith('SAFE_PATCH_PATH_') ? 'PATH_DENIED' : 'APPLY_FAILED',
        message,
      );
    }
  }

  let paths: string[];
  try {
    paths = groupPaths(repository, group);
  } catch (error) {
    return semanticGroupFailure(
      plan,
      group,
      groupIndex,
      'PATH_DENIED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    group.operations.some(
      (operation) => operation.type === 'create' || operation.type === 'delete' || operation.type === 'move',
    )
  ) {
    return semanticGroupFailure(
      plan,
      group,
      groupIndex,
      'SEMANTIC_GROUP_UNSUPPORTED',
      `semantic group ${group.groupId} mixes create/delete/move with other operations; planner refused partial execution before mutation`,
    );
  }

  if (paths.length > 1) {
    return applySessionlessMultiPathTextGroup(repository, group, plan, groupIndex, allowedPaths);
  }

  let path: string;
  try {
    path = resolveSessionlessPath(repository, group.operations[0]!.path, allowedPaths);
  } catch (error) {
    return semanticGroupFailure(
      plan,
      group,
      groupIndex,
      'PATH_DENIED',
      error instanceof Error ? error.message : String(error),
    );
  }
  return applySessionlessTextGroup(
    repository,
    path,
    group.operations as Array<NormalizedOperation & SessionlessTextOperation>,
    plan,
    groupIndex,
  );
}

function recoverPendingTextTransactionsForOperations(
  repository: RepositoryRecord,
  operations: readonly NormalizedOperation[],
  allowedPaths?: unknown,
): number {
  const paths = new Set<string>();
  for (const operation of operations) {
    const rawPaths = operation.type === 'move' ? [operation.path, operation.toPath] : [operation.path];
    for (const rawPath of rawPaths) {
      if (!rawPath) continue;
      try {
        paths.add(resolveSessionlessPath(repository, rawPath, allowedPaths));
      } catch {
        // Invalid or out-of-scope operations are rejected by their normal
        // semantic-group preflight; they must not prevent independent groups.
      }
    }
  }
  return paths.size > 0 ? recoverPendingAtomicTextGroups(repository.canonicalRoot, [...paths]) : 0;
}

export function applySessionlessMutationBatch(
  repository: RepositoryRecord,
  input: {
    operations: unknown;
    allowedPaths?: unknown;
    refreshFingerprints?: unknown;
  },
): SessionlessSafePatchResult {
  const operations = normalizedSafePatchOperations(input.operations);
  if (operations.length === 0) throw new Error('SAFE_PATCH_OPERATIONS_REQUIRED: provide at least one operation');
  if (operations.length === 1) return applySessionlessSafePatch(repository, input);

  const plan = buildSafePatchPlan(repository, {
    operations: operations.map(stripInternalIndex),
    chunkSize: 1,
  });
  const groups = buildSessionlessMutationGroups(operations);
  const changedFiles = new Set<string>();
  const failures: SafePatchPreflightFailure[] = [];
  const appliedChunks: Array<{ index: number; operationCount: number; paths: string[] }> = [];
  const receipts: SessionlessReceipt[] = [];
  const groupResults: SessionlessGroupResult[] = [];

  groups.forEach((group, offset) => {
    const groupIndex = offset + 1;
    const result = executeSessionlessMutationGroup(repository, group, groupIndex, plan, input.allowedPaths);
    for (const path of result.changedFiles) changedFiles.add(path);
    failures.push(...result.failures);
    appliedChunks.push(...result.appliedChunks);
    const groupReceipts = result.receipts ?? (result.receipt ? [result.receipt] : []);
    receipts.push(...groupReceipts);
    let paths: string[];
    try {
      paths = groupPaths(repository, group);
    } catch {
      paths = [...new Set(group.operations.map((operation) => operation.path))];
    }
    groupResults.push({
      groupId: group.groupId,
      status: result.status === 'applied' ? 'applied' : 'failed',
      operationIndexes: groupOperationIndexes(group),
      paths,
      changedFiles: result.changedFiles,
      failures: result.failures,
      receipts: groupReceipts,
    });
  });

  const changed = [...changedFiles];
  const status: SessionlessSafePatchResult['status'] =
    failures.length === 0 ? 'applied' : changed.length > 0 ? 'partial' : 'failed';
  return {
    status,
    sessionless: true,
    createdSession: false,
    changedFiles: changed,
    appliedChunks,
    failures,
    ...(receipts.length === 1 ? { receipt: receipts[0] } : {}),
    ...(receipts.length > 0 ? { receipts } : {}),
    groups: groupResults,
    plan,
  };
}

function resolveSessionlessPath(repository: RepositoryRecord, rawPath: string, allowedPaths?: unknown): string {
  const policy = getToolPolicy('controller', { repoRoot: repository.canonicalRoot });
  const resolved = resolveMcpPath(repository.canonicalRoot, rawPath, policy, 'write');
  if (!resolved.ok || !resolved.relativePath || !resolved.absolutePath)
    throw new Error(`SAFE_PATCH_PATH_DENIED: ${resolved.reason ?? rawPath}`);
  const path = resolved.relativePath;
  const allowed = Array.isArray(allowedPaths) ? allowedPaths.map((value) => String(value).trim()).filter(Boolean) : [];
  if (allowed.length && !allowed.some((pattern) => globMatches(pattern, path)))
    throw new Error(`SAFE_PATCH_PATH_OUTSIDE_SCOPE: ${path}`);
  return path;
}

export function applySessionlessSafePatch(
  repository: RepositoryRecord,
  input: {
    operations: unknown;
    allowedPaths?: unknown;
    refreshFingerprints?: unknown;
  },
): SessionlessSafePatchResult {
  const operations = normalizedSafePatchOperations(input.operations);
  if (
    operations.length !== 1 ||
    !['create', 'replace', 'write', 'prepend', 'append', 'insert_before', 'insert_after', 'delete', 'move'].includes(
      operations[0]!.type,
    )
  ) {
    throw new Error('SESSIONLESS_SAFE_PATCH_SINGLE_TEXT_OPERATION_REQUIRED');
  }
  const operation = operations[0]!;
  const path = resolveSessionlessPath(repository, operation.path, input.allowedPaths);
  recoverPendingTextTransactionsForOperations(repository, operations, input.allowedPaths);

  const plan = buildSafePatchPlan(repository, { operations, chunkSize: 1 });
  if (operation.type === 'create') return applySessionlessCreate(repository, path, operation, plan);
  if (operation.type === 'delete') return applySessionlessDelete(repository, path, operation, plan);
  if (operation.type === 'move') return applySessionlessMove(repository, path, operation, plan, input.allowedPaths);
  return applySessionlessTextOperation(repository, path, operation, plan);
}
