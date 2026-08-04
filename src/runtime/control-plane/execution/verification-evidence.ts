import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import type { RepositoryGitStatusSnapshot } from '../../../cli/repositories/structured-git';
import type { VerificationRecord } from '../facade/types';

const MAX_VALIDATION_PATHS = 256;
const MAX_VALIDATION_FILE_BYTES = 32 * 1024 * 1024;
const MAX_VALIDATION_TOTAL_BYTES = 64 * 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = '[output truncated after ';

export interface VerificationEvidenceIdentity {
  sourceRevision: string;
  workspaceFingerprint?: string;
  checkId: string;
  requestedChecks: string[];
  commandId?: string;
}

export interface EffectiveVerificationEvidence {
  record: VerificationRecord;
  current: boolean;
  staleReason?: string;
}

function decodeGitQuotedPath(rawPath: string): string {
  if (!rawPath.startsWith('"') && !rawPath.endsWith('"')) return rawPath;
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) {
    throw new Error(`WORK_VALIDATION_PATH_UNSUPPORTED: malformed Git quoted path: ${rawPath}`);
  }
  const bytes: number[] = [];
  const body = rawPath.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== '\\') {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const escaped = body[index + 1];
    if (!escaped) throw new Error(`WORK_VALIDATION_PATH_UNSUPPORTED: malformed Git escape: ${rawPath}`);
    index += 1;
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) {
        octal += body[index + 1];
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    throw new Error(`WORK_VALIDATION_PATH_UNSUPPORTED: unsupported Git escape in ${rawPath}`);
  }
  return Buffer.from(bytes).toString('utf8');
}

function statusPath(rawPath: string): string {
  const renamed = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath;
  return decodeGitQuotedPath(renamed);
}

/**
 * Exact content identity for the workspace that a check observes.
 *
 * Git status supplies the bounded changed-path set; every current path is then
 * hashed from the filesystem so edits that retain the same HEAD and porcelain
 * shape still invalidate previous evidence. The index is intentionally not a
 * separate authority because Work finalization stages the current filesystem.
 */
export function workspaceValidationFingerprint(
  root: string,
  status: Pick<RepositoryGitStatusSnapshot, 'head' | 'branch' | 'porcelain' | 'staged' | 'unstaged' | 'untracked'>,
): string {
  const canonicalRoot = resolve(root);
  if (status.porcelain.includes(OUTPUT_TRUNCATION_MARKER)) {
    throw new Error('WORK_VALIDATION_STATUS_TRUNCATED: exact changed-path identity is unavailable');
  }
  const changedPaths = [...new Set([...status.staged, ...status.unstaged, ...status.untracked].map(statusPath))].sort();
  if (changedPaths.length > MAX_VALIDATION_PATHS) {
    throw new Error(`WORK_VALIDATION_TOO_MANY_PATHS: ${changedPaths.length} exceeds ${MAX_VALIDATION_PATHS}`);
  }
  const hash = createHash('sha256');
  let totalBytes = 0;
  hash.update(JSON.stringify({
    head: status.head,
    branch: status.branch,
    porcelain: status.porcelain,
    changedPaths,
  }));

  for (const path of changedPaths) {
    const absolutePath = resolve(canonicalRoot, path);
    const relativePath = relative(canonicalRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`WORK_VALIDATION_PATH_OUTSIDE_CHECKOUT: ${path}`);
    }
    hash.update(`\npath:${path}\n`);
    if (!existsSync(absolutePath)) {
      hash.update('deleted');
      continue;
    }
    const stat = lstatSync(absolutePath);
    hash.update(`mode:${stat.mode};size:${stat.size};`);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${readlinkSync(absolutePath)}`);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`WORK_VALIDATION_PATH_TYPE_UNSUPPORTED: ${path}`);
    }
    if (stat.size > MAX_VALIDATION_FILE_BYTES) {
      throw new Error(`WORK_VALIDATION_FILE_TOO_LARGE: ${path} exceeds ${MAX_VALIDATION_FILE_BYTES} bytes`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_VALIDATION_TOTAL_BYTES) {
      throw new Error(`WORK_VALIDATION_WORKSPACE_TOO_LARGE: changed files exceed ${MAX_VALIDATION_TOTAL_BYTES} bytes`);
    }
    hash.update(readFileSync(absolutePath));
  }
  return hash.digest('hex');
}

export function workValidationInputFingerprint(
  sourceRevision: string,
  workspaceFingerprint: string,
  requestedChecks: string[],
): string {
  return createHash('sha256').update(JSON.stringify({
    sourceRevision,
    workspaceFingerprint,
    requestedChecks: [...requestedChecks].sort(),
  })).digest('hex');
}

/** Stable identity for inputs that make a check result reusable. */
export function verificationInputFingerprint(input: VerificationEvidenceIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.workspaceFingerprint ?? null,
    checkId: input.checkId,
    requestedChecks: [...input.requestedChecks].sort(),
    commandId: input.commandId ?? null,
  })).digest('hex');
}

export function commandFingerprint(checkId: string, commandId: string | undefined): string {
  return createHash('sha256').update(JSON.stringify({ checkId, commandId: commandId ?? null })).digest('hex');
}

/**
 * Keeps historical evidence auditable while preventing a previous revision or
 * changed check inputs from being selected as proof for the current Work.
 */
export function effectiveVerificationEvidence(
  records: VerificationRecord[],
  expected: Pick<VerificationEvidenceIdentity, 'sourceRevision' | 'workspaceFingerprint' | 'checkId' | 'requestedChecks'>,
): EffectiveVerificationEvidence[] {
  const expectedFingerprint = verificationInputFingerprint({ ...expected });
  return records
    .filter((record) => record.checkId === expected.checkId)
    .map((record) => {
      if (record.supersedes) return { record, current: false, staleReason: 'superseded' };
      if (!record.sourceRevision || !record.verificationInputFingerprint) {
        return { record, current: false, staleReason: 'legacy evidence has no exact input identity' };
      }
      if (record.sourceRevision !== expected.sourceRevision) {
        return { record, current: false, staleReason: `source revision changed: ${record.sourceRevision} -> ${expected.sourceRevision}` };
      }
      if (expected.workspaceFingerprint && record.workspaceFingerprint !== expected.workspaceFingerprint) {
        return { record, current: false, staleReason: 'workspace content changed' };
      }
      if (record.verificationInputFingerprint !== expectedFingerprint) {
        return { record, current: false, staleReason: 'verification inputs changed' };
      }
      return { record, current: true };
    });
}
