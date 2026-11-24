import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { repositoryControllerRoot } from '../../../effects/controller-home';
import {
  FAST_RECEIPT_MAX_SUMMARY_BYTES,
  FAST_RECEIPT_RETENTION,
  type FastExecutionReceipt,
  type FastOutcome,
  type LatencyBreakdown,
  type RuntimeObservability,
} from './types';

export interface CreateFastReceiptInput {
  repoId: string;
  checkoutId: string;
  operation: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  outcome: FastOutcome;
  changedPaths?: string[];
  repositoryChanged?: boolean;
  authorizationDecision?: string;
  policyDecision?: string;
  outputSummary?: string;
  artifactRefs?: string[];
  latency?: LatencyBreakdown;
  /** Internal measurement used for receipt observability even when latency detail is not returned. */
  observabilityLatency?: LatencyBreakdown;
  stepCount?: number;
  laneCount?: number;
  reasons?: string[];
  executionId?: string;
  requestId?: string;
  fencingToken?: number;
  baseHead?: string | null;
  inputHash?: string;
}

function observabilityFor(input: CreateFastReceiptInput): RuntimeObservability {
  const latency = input.observabilityLatency ?? input.latency;
  const commandRuntimeMs = Math.max(0, latency?.executionMs ?? 0);
  const controllerWaitMs = Math.max(0, latency?.schedulerWaitMs ?? 0);
  return {
    framework_overhead_ms: Math.max(0, Math.round((input.durationMs - commandRuntimeMs - controllerWaitMs) * 100) / 100),
    command_runtime_ms: Math.round(commandRuntimeMs * 100) / 100,
    controller_wait_ms: Math.round(controllerWaitMs * 100) / 100,
    // A Fast receipt is the single durable command event for its executionId.
    duplicate_event_count: 0,
    automatic_retry_count: 0,
    // Read operations do not refresh projections or write runtime state.
    read_path_write_count: 0,
  };
}

export interface WriteReceiptResult {
  receipt?: FastExecutionReceipt;
  persisted: boolean;
  warning?: string;
}

function receiptsDir(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'fast-receipts');
}

function receiptPath(controllerHome: string, repoId: string, executionId: string): string {
  const safe = executionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
  return join(receiptsDir(controllerHome, repoId), `${safe}.json`);
}

function boundSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= FAST_RECEIPT_MAX_SUMMARY_BYTES) return value;
  return `${value.slice(0, FAST_RECEIPT_MAX_SUMMARY_BYTES)}…[truncated ${bytes} bytes]`;
}

let pruneCounter = 0;

/**
 * Persist one bounded Fast Path receipt.
 * Failures never throw to callers that already completed mutations.
 */
export function writeFastReceipt(controllerHome: string, input: CreateFastReceiptInput): WriteReceiptResult {
  const executionId = input.executionId ?? `fast_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const receipt: FastExecutionReceipt = {
    schemaVersion: 1,
    executionId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    mode: 'fast',
    operation: input.operation,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, Math.round(input.durationMs * 100) / 100),
    outcome: input.outcome,
    changedPaths: [...new Set(input.changedPaths ?? [])].slice(0, 200),
    repositoryChanged: input.repositoryChanged === true,
    authorizationDecision: input.authorizationDecision ?? 'session_or_policy',
    policyDecision: input.policyDecision ?? 'allowed',
    outputSummary: boundSummary(input.outputSummary),
    artifactRefs: input.artifactRefs?.slice(0, 20),
    latency: input.latency,
    observability: observabilityFor(input),
    stepCount: input.stepCount,
    laneCount: input.laneCount,
    reasons: input.reasons?.slice(0, 20),
    requestId: input.requestId,
    fencingToken: input.fencingToken,
    baseHead: input.baseHead,
    inputHash: input.inputHash,
  };

  try {
    const dir = receiptsDir(controllerHome, input.repoId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = receiptPath(controllerHome, input.repoId, executionId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
    pruneCounter += 1;
    if (pruneCounter % 25 === 0) pruneFastReceipts(controllerHome, input.repoId);
    return { receipt, persisted: true };
  } catch (error) {
    return {
      receipt,
      persisted: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function pruneFastReceipts(controllerHome: string, repoId: string): void {
  const dir = receiptsDir(controllerHome, repoId);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort()
    .reverse();
  for (const path of files.slice(FAST_RECEIPT_RETENTION)) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function hashRequestInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
}
