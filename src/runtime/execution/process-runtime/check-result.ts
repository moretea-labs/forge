import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { processLogDir } from './store';
import type { ManagedProcessRecord } from './types';

export const STRUCTURED_CHECK_RESULT_PATH_ENV = 'FORGE_CHECK_STRUCTURED_RESULT_PATH';
export const MAX_STRUCTURED_CHECK_FAILURE_DETAILS = 32;

export type StructuredCheckFailureDetailClass = 'source' | 'fixture' | 'infrastructure' | 'interrupted';

export interface StructuredCheckFailureDetail {
  file: string;
  failureClass: StructuredCheckFailureDetailClass;
  failureCode: string;
  attempts: number;
  durationMs: number;
  signal?: string;
}

export interface StructuredCheckFailureEvidence {
  schemaVersion: 1;
  producer: 'test-governance';
  gate: string;
  status: 'passed' | 'failed';
  failures: number;
  failureClasses: StructuredCheckFailureDetailClass[];
  failureDetails: StructuredCheckFailureDetail[];
  failureDetailsTruncated: boolean;
  contaminated: boolean;
}

const STRUCTURED_FAILURE_CLASSES = new Set<StructuredCheckFailureDetailClass>(['source', 'fixture', 'infrastructure', 'interrupted']);

export function isStructuredCheckFailureEvidence(value: unknown): value is StructuredCheckFailureEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as StructuredCheckFailureEvidence;
  if (candidate.schemaVersion !== 1 || candidate.producer !== 'test-governance') return false;
  if (typeof candidate.gate !== 'string' || !candidate.gate.trim() || candidate.gate.length > 64) return false;
  if (candidate.status !== 'passed' && candidate.status !== 'failed') return false;
  if (!Number.isInteger(candidate.failures) || candidate.failures < 0 || candidate.failures > 1_000_000) return false;
  if (!Array.isArray(candidate.failureClasses) || candidate.failureClasses.length > STRUCTURED_FAILURE_CLASSES.size) return false;
  if (candidate.failureClasses.some((entry) => !STRUCTURED_FAILURE_CLASSES.has(entry))) return false;
  if (new Set(candidate.failureClasses).size !== candidate.failureClasses.length) return false;
  if (!Array.isArray(candidate.failureDetails) || candidate.failureDetails.length > MAX_STRUCTURED_CHECK_FAILURE_DETAILS) return false;
  if (typeof candidate.failureDetailsTruncated !== 'boolean' || typeof candidate.contaminated !== 'boolean') return false;
  for (const detail of candidate.failureDetails) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
    if (typeof detail.file !== 'string' || !detail.file.startsWith('tests/') || detail.file.length > 512) return false;
    if (!STRUCTURED_FAILURE_CLASSES.has(detail.failureClass)) return false;
    if (typeof detail.failureCode !== 'string' || !/^TEST_[A-Z0-9_]+$/.test(detail.failureCode) || detail.failureCode.length > 128) return false;
    if (!Number.isInteger(detail.attempts) || detail.attempts < 1 || detail.attempts > 100) return false;
    if (!Number.isFinite(detail.durationMs) || detail.durationMs < 0 || detail.durationMs > 24 * 60 * 60_000) return false;
    if (detail.signal !== undefined && (typeof detail.signal !== 'string' || detail.signal.length > 32)) return false;
    if (!candidate.failureClasses.includes(detail.failureClass)) return false;
  }
  if (candidate.failureDetails.length > candidate.failures) return false;
  if (candidate.failureDetailsTruncated !== (candidate.failures > candidate.failureDetails.length)) return false;
  if (candidate.status === 'passed') {
    return candidate.failures === 0
      && candidate.failureClasses.length === 0
      && candidate.failureDetails.length === 0
      && candidate.failureDetailsTruncated === false
      && candidate.contaminated === false;
  }
  return (candidate.failures > 0 || candidate.contaminated) && candidate.failureClasses.length > 0;
}

export interface PersistedCheckResultReceipt {
  schemaVersion: 1;
  receiptId: string;
  checkId: string;
  cacheKey: string;
  ok: boolean;
  status: number;
  timedOut: boolean;
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
  failureEvidence?: StructuredCheckFailureEvidence;
  validatedRevision?: string;
  executedAt: string;
  originalExecutedAt?: string;
  cacheHit?: boolean;
}

export function allocatePersistedCheckResultReceiptPath(
  controllerHome: string,
  repoId: string,
  requestId?: string,
): string {
  const root = join(processLogDir(controllerHome, repoId), 'check-results');
  mkdirSync(root, { recursive: true });
  const stableRequestId = requestId?.trim();
  const receiptId = stableRequestId
    ? `request-${createHash('sha256').update(stableRequestId).digest('hex').slice(0, 32)}`
    : randomUUID();
  return join(root, `${receiptId}.json`);
}

export function writePersistedCheckResultReceipt(path: string, input: Omit<PersistedCheckResultReceipt, 'schemaVersion' | 'receiptId'>): PersistedCheckResultReceipt {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const receipt: PersistedCheckResultReceipt = { schemaVersion: 1, receiptId: `check_result_${digest.slice(0, 24)}`, ...input };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return receipt;
}

export function readPersistedCheckResultReceipt(path: string | undefined): PersistedCheckResultReceipt | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as PersistedCheckResultReceipt;
    if (value?.schemaVersion !== 1 || typeof value.receiptId !== 'string' || typeof value.cacheKey !== 'string') return undefined;
    if (value.failureEvidence !== undefined && !isStructuredCheckFailureEvidence(value.failureEvidence)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export type PersistedCheckTerminalEvidenceState =
  | 'matched'
  | 'process_runtime_failed_before_result'
  | 'missing'
  | 'mismatch';

export interface PersistedCheckTerminalEvidence {
  state: PersistedCheckTerminalEvidenceState;
  failureClass?: PersistedCheckResultReceipt['failureClass'];
  failureEvidence?: StructuredCheckFailureEvidence;
  warning?: string;
  infrastructureReason?: string;
}

export interface TerminalCheckEvidenceClassificationInput {
  processError?: { code: string; message: string };
  structuredPresent: boolean;
  structuredMatches: boolean;
  legacyPresent: boolean;
  legacyMatches: boolean;
}

/**
 * Compatibility-level classifier for terminal Check evidence. Keep this pure so
 * legacy/public callers and the Process Runtime record adapter share one semantic
 * authority instead of carrying duplicate decision trees.
 */
export function classifyTerminalCheckEvidence(
  input: TerminalCheckEvidenceClassificationInput,
): PersistedCheckTerminalEvidence {
  if (input.structuredMatches || input.legacyMatches) return { state: 'matched' };
  if (!input.structuredPresent && !input.legacyPresent && input.processError?.message?.trim()) {
    const reason = input.processError.message.trim().slice(0, 512);
    return {
      state: 'process_runtime_failed_before_result',
      warning: `check process failed before structured result receipt: ${reason}`,
      infrastructureReason: reason,
    };
  }
  if (input.structuredPresent || input.legacyPresent) {
    return { state: 'mismatch', warning: 'check result receipt did not match the terminal Process semantic identity' };
  }
  return { state: 'missing', warning: 'check result receipt is missing for the terminal Check Process' };
}

/**
 * Classify one terminal Check Process using the structured result emitted by
 * the check-runner sidecar. A Process Runtime/admission failure can terminate
 * before that result exists (for example PROCESS_LEASE_CONFLICT); such a
 * Process is infrastructure failure, never evidence that repository checks
 * rejected the candidate. Missing/mismatched result identity also fails closed
 * as infrastructure rather than manufacturing acceptance evidence.
 */
export interface LegacyCheckEvidenceLike {
  cacheKey?: string;
  failureClass?: PersistedCheckResultReceipt['failureClass'];
  failureEvidence?: StructuredCheckFailureEvidence;
}

export function classifyPersistedCheckTerminalEvidence(
  record: ManagedProcessRecord,
  expectedCheckId: string,
  options: { legacyEvidence?: LegacyCheckEvidenceLike } = {},
): PersistedCheckTerminalEvidence {
  const structured = readPersistedCheckResultReceipt(record.origin?.checkResultReceiptPath);
  const structuredMatches = Boolean(
    structured
    && record.checkExecution
    && structured.checkId === expectedCheckId
    && structured.cacheKey === record.checkExecution.cacheKey,
  );
  const legacy = options.legacyEvidence;
  const legacyMatches = Boolean(
    legacy?.cacheKey
    && record.checkExecution?.cacheKey
    && legacy.cacheKey === record.checkExecution.cacheKey,
  );
  const classified = classifyTerminalCheckEvidence({
    processError: record.error,
    structuredPresent: Boolean(structured),
    structuredMatches,
    legacyPresent: Boolean(legacy),
    legacyMatches,
  });
  return classified.state === 'matched'
    ? {
      ...classified,
      failureClass: structuredMatches ? structured?.failureClass : legacy?.failureClass,
      failureEvidence: structuredMatches ? structured?.failureEvidence : legacy?.failureEvidence,
    }
    : classified;
}
