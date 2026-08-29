import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { processLogDir } from './store';
import type { ManagedProcessRecord } from './types';

export interface PersistedCheckResultReceipt {
  schemaVersion: 1;
  receiptId: string;
  checkId: string;
  cacheKey: string;
  ok: boolean;
  status: number;
  timedOut: boolean;
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
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
    return value?.schemaVersion === 1 && typeof value.receiptId === 'string' && typeof value.cacheKey === 'string' ? value : undefined;
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
    ? { ...classified, failureClass: structuredMatches ? structured?.failureClass : legacy?.failureClass }
    : classified;
}
