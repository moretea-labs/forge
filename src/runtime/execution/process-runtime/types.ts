/**
 * Unified Process Runtime types.
 * Direct (interactive wait) and Managed (handle returned on wait expiry)
 * share one spawn path — never re-executes a command that already started.
 */

import type { ResolvedExecutionIdentity } from '../../control-plane/execution/execution-identity';

export type ProcessRuntimeStatus =
  | 'starting'
  | 'running'
  | 'running_recovered'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'orphaned'
  | 'completed_unknown'
  | 'unknown';

export type ProcessRouteMode = 'direct' | 'managed' | 'durable';

/** Stable Process state exposed to SuperControllers. */
export type ProcessContractStatus = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export function processContractStatus(status: ProcessRuntimeStatus): ProcessContractStatus {
  if (status === 'starting') return 'created';
  if (status === 'running' || status === 'running_recovered') return 'running';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'timed_out' || status === 'orphaned') return 'failed';
  return 'unknown';
}

export interface ProcessIdentityRecord {
  pid: number;
  processStartTime: string;
  executableFingerprint: string;
  processGroupId?: number;
}

export interface ProcessResourceClaim {
  resourceKey: string;
  mode: 'read' | 'write' | 'exclusive';
  repoId?: string;
  checkoutId?: string;
  workId?: string;
}

/** Durable lease ownership held by a managed process (not only recorded claims). */
export interface ProcessLeaseRef {
  leaseId: string;
  resourceKey: string;
  fencingToken: number;
  expiresAt?: string;
  repoId?: string;
  checkoutId?: string;
  workId?: string;
}

export interface ProcessCommandSpec {
  kind: 'argv' | 'shell';
  executable?: string;
  args?: string[];
  shellCommand?: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

/** Persistent request binding claimed before any Process Runner is spawned. */
export interface ProcessRequestBinding {
  schemaVersion: 1;
  repoId: string;
  checkoutId?: string;
  requestId: string;
  commandFingerprint: string;
  processId: string;
  createdAt: string;
}

/** Persistent logical invocation binding claimed before any child Process is spawned. */
export interface ProcessInvocationBinding {
  schemaVersion: 1;
  repoId: string;
  checkoutId?: string;
  requestId: string;
  invocationFingerprint: string;
  createdAt: string;
}

export interface ManagedProcessRecord {
  schemaVersion: 1;
  processId: string;
  repoId: string;
  checkoutId?: string;
  /** Optional facade WorkContract that owns this command. */
  workId?: string;
  /** Caller-stable command identity; defaults to processId when omitted. */
  commandId?: string;
  /** Fingerprint bound to origin.requestId before spawn. */
  requestFingerprint?: string;
  controllerHome: string;
  status: ProcessRuntimeStatus;
  route: ProcessRouteMode;
  command: ProcessCommandSpec;
  identity?: ProcessIdentityRecord;
  resourceClaims: ProcessResourceClaim[];
  /** Real execution leases acquired before spawn; released exactly once on terminal. */
  leaseRefs?: ProcessLeaseRef[];
  /** True after leases were released (prevents double-release on recovery/cancel). */
  leasesReleased?: boolean;
  interactiveWaitMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** Bytes actually stored on disk (may be < stdoutBytes when quota truncates). */
  stdoutStoredBytes?: number;
  stderrStoredBytes?: number;
  logPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  /** Structured command descriptor for the independent Process Runner. */
  commandDescriptorPath?: string;
  /** Fencing token — only the owner with this token may write terminal status. */
  terminalFenceToken: number;
  terminalWritten?: boolean;
  /** Owner controller generation / authority epoch when known. */
  writerAuthorityEpoch?: string;
  /** Optional correlation for MCP / check / command tools. */
  origin?: {
    surface: 'mcp' | 'check' | 'command' | 'system';
    toolName?: string;
    requestId?: string;
    checkId?: string;
    correlationId?: string;
    /** Controller MCP session that initiated this check, when applicable. */
    executionSessionId?: string;
    /** Exact direct-edit session binding for verification receipts. */
    editSessionId?: string;
    editRevision?: number;
    /** Optional durable task identity consuming the same receipt. */
    issueId?: string;
    taskId?: string;
  };
  error?: { code: string; message: string };
  /** Sidecar exit receipt path written by wrapper (survives controller restart). */
  exitReceiptPath?: string;
  /** True when PID identity used fallback without startTime — signals forbidden. */
  identityUntrusted?: boolean;
  /** Log truncated due to quota. */
  logTruncated?: boolean;
  /** Metadata only; never contains the removed sensitive values. */
  outputRedaction?: {
    schemaVersion: 1;
    sanitizedAt: string;
    filesExamined: number;
    filesChanged: number;
    redactionCount: number;
    descriptorRemoved?: boolean;
  };
}

export interface SpawnManagedProcessInput {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  /** Immutable resolved execution identity — required; validated immediately before spawn. */
  executionIdentity: ResolvedExecutionIdentity;
  workId?: string;
  commandId?: string;
  command: ProcessCommandSpec;
  interactiveWaitMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resourceClaims?: ProcessResourceClaim[];
  origin?: ManagedProcessRecord['origin'];
  writerAuthorityEpoch?: string;
  signal?: AbortSignal;
  /** When true, never block the caller waiting for completion. */
  returnHandleImmediately?: boolean;
}

export interface ProcessHandle {
  processId: string;
  workId?: string;
  commandId: string;
  status: ProcessRuntimeStatus;
  contractStatus: ProcessContractStatus;
  route: ProcessRouteMode;
  pid?: number;
  startedAt: string;
  interactiveWaitMs: number;
  timeoutMs: number;
  completed?: boolean;
  /** True when this response reused a previously claimed request binding. */
  deduplicated?: boolean;
  requestId?: string;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTail?: string;
  stderrTail?: string;
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
}

export interface WaitProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessLogSlice {
  processId: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export const DEFAULT_INTERACTIVE_WAIT_MS = 8_000;
export const DEFAULT_PROCESS_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const PROCESS_LOG_TAIL_BYTES = 32 * 1024;
