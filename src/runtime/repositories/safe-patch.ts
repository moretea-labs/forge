import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { findOccurrence, normalizeEditOperation, type EditOperation } from '../editing/edit-operation-contract';
import { getToolPolicy } from '../control-plane/tool-policy';
import {
  atomicApplyPathMutationGroup,
  atomicCompareAndDeleteText,
  atomicCompareAndMoveText,
  atomicCompareAndSwapText,
  atomicCompareAndSwapTextGroup,
  atomicCreateText,
  recoverPendingAtomicPathMutationGroups,
  recoverPendingAtomicTextGroups,
  type AtomicPathMutationEntry,
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
    | 'SEMANTIC_CONFLICT'
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
): { path: string; absolute: string; exists: boolean; content: string; sha256?: string; mode?: number } {
  const path = repoRelativePath(repository, rawPath);
  const absolute = join(repository.canonicalRoot, path);
  if (!existsSync(absolute)) return { path, absolute, exists: false, content: '' };
  const content = readFileSync(absolute, 'utf-8');
  const mode = lstatSync(absolute).mode & 0o777;
  return { path, absolute, exists: true, content, sha256: hash(content), mode };
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
  const occurrence = Math.max(1, Math.trunc(anchored.occurrence ?...