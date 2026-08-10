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

export const ACTIVE_PROCESS_RUNTIME_STATUSES = ['starting', 'running', 'running_recovered'] as const satisfies readonly ProcessRuntimeStatus[];
export const TERMINAL_PROCESS_RUNTIME_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
  'completed_unknown',
  'unknown',
] as const satisfies readonly ProcessRuntimeStatus[];

const ACTIVE_PROCESS_RUNTIME_STATUS_SET = new Set<ProcessRuntimeStatus>(ACTIVE_PROCESS_RUNTIME_STATUSES);
const TERMINAL_PROCESS_RUNTIME_STATUS_SET = new Set<ProcessRuntimeStatus>(TERMINAL_PROCESS_RUNTIME_STATUSES);

export function isActiveProcessStatus(status: ProcessRuntimeStatus): boolean {
  return ACTIVE_PROCESS_RUNTIME_STATUS_SET.has(status);
}

export function isTerminalProcessStatus(status: ProcessRuntimeStatus): boolean {
  return TERMINAL_PROCESS_RUNTIME_STATUS_SET.has(status);
}

export function isManagedProcessTerminal(record: {
  status: ProcessRuntimeStatus;
  terminalWritten?: boolean;
}): boolean {
  return record.terminalWritten === true || isTerminalProcessStatus(record.status);
}

export function isManagedProcessActive(record: {
  status: ProcessRuntimeStatus;
  terminalWritten?: boolean;
}): boolean {
  return !isManagedProcessTerminal(record) && isActiveProcessStatus(record.status);
}

export function effectiveProcessStatus(record: {
  status: ProcessRuntimeStatus;
  terminalWritten?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  finishedAt?: string;
}, completedHint = false): ProcessRuntimeStatus {
  if (isTerminalProcessStatus(record.status)) return record.status;
  if (!record.terminalWritten && !completedHint) return record.status;
  if (record.cancelled) return 'cancelled';
  if (record.timedOut) return 'timed_out';
  if (record.exitCode === 0) return 'succeeded';
  if (typeof record.exitCode === 'number') return 'failed';
  if (record.finishedAt || record.terminalWritten) return 'completed_unknown';
  return record.status;
}

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

/** Retryable diagnostic for terminal lease cleanup; not a second lease state machine. */
export interface ProcessLeaseReleaseFailure {
  code: string;
  message: string;
  attemptedAt: string;
  attempts: number;
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

/** Content-bound Check identity used only to index/reuse Process Runtime evidence. */
export interface ProcessCheckExecutionIdentity {
  schemaVersion: 1;
  checkId: string;
  cacheKey: string;
  revision: string;
  definitionDigest: string;
  environmentFingerprint: string;
  timeoutMs: number;
  reuseScope: 'repository' | 'checkout';
  scopeKey: string;
}

/** Persistent semantic Check binding to one physical Process record. */
export interface ProcessCheckExecutionBinding {
  schemaVersion: 1;
  repoId: string;
  scopeKey: string;
  cacheKey: string;
  processId: string;
  sourceCheckoutId?: string;
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
  /** Semantic Check identity when this Process is eligible for single-flight/reuse. */
  checkExecution?: ProcessCheckExecutionIdentity;
  controllerHome: string;
  status: ProcessRuntimeStatus;
  route: ProcessRouteMode;
  command: ProcessCommandSpec;
  identity?: ProcessIdentityRecord;
  resourceClaims: ProcessResourceClaim[];
  /** Real execution leases acquired before spawn; released exactly once on terminal. */
  leaseRefs?: ProcessLeaseRef[];
  /** Durable terminal cleanup phase; pending remains retryable after controller restart. */
  leaseReleaseState?: 'pending' | 'released';
  /** Last structured cleanup failure while leaseReleaseState remains pending. */
  leaseReleaseFailure?: ProcessLeaseReleaseFailure;
  /** Compatibility projection of leaseReleaseState === released. */
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
  /** Canonical Runtime instance captured when this process was spawned. */
  runtimeInstanceId?: string;
  /** Atomic whole-release authority revision captured at spawn. */
  releaseAuthorityRevision?: number;
  /** Immutable whole-release identity captured at spawn. */
  releaseId?: string;
  artifactIdentity?: string;
  workerProtocolVersion?: number;
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
  /**
   * Bounded lease-conflict wait budget (ms). 0 (default) keeps fail-fast
   * PROCESS_LEASE_CONFLICT behavior; >0 polls lease acquisition until the
   * conflicting claims release, then spawns. Never a second scheduler: the
   * existing Lease store remains the single conflict authority.
   */
  leaseWaitMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resourceClaims?: ProcessResourceClaim[];
  checkExecution?: ProcessCheckExecutionIdentity;
  origin?: ManagedProcessRecord['origin'];
  runtimeInstanceId?: string;
  releaseAuthorityRevision?: number;
  releaseId?: string;
  artifactIdentity?: string;
  workerProtocolVersion?: number;
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
  /** True when a semantic Check identity reused another caller's physical Process. */
  semanticDeduplicated?: boolean;
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
