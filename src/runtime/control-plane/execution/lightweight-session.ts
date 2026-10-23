import { createHash } from 'crypto';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';
import { sanitizeFileComponent } from '../../shared/json-files';

/**
 * LightweightWorkSession provides a minimal execution context for simple
 * repository operations that don't require full Work isolation.
 *
 * Use cases:
 * - Quick edits on current branch (isolation=reuse)
 * - Read-only exploration
 * - Simple command execution
 *
 * Benefits over full Work:
 * - No WorkHandle/WorkContract creation
 * - No PrepareRequest locking
 * - Minimal state persistence
 * - Fast preparation (~5ms vs ~50ms)
 *
 * When to upgrade to full Work:
 * - Need isolated worktree
 * - Long-running feature development
 * - Requires validation gates
 * - Multiple concurrent work streams
 */
export interface LightweightWorkSession {
  schemaVersion: 1;
  sessionId: string;
  repoId: string;
  checkoutId: string;
  /** Current branch name */
  branch: string;
  /** Git HEAD at session start */
  baselineHead: string;
  /** Dirty files at session start (to distinguish from session changes) */
  baselineDirtyPaths?: string[];
  baselineDirtyPathCount?: number;
  /** When this lightweight session was created */
  createdAt: string;
  /** Last activity timestamp */
  updatedAt: string;
}

export interface LightweightWorkSessionInput {
  sessionId: string;
  repoId: string;
  checkoutId: string;
  branch: string;
  baselineHead: string;
  baselineDirtyPaths?: string[];
}

function sessionKey(sessionId: string, repoId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ sessionId, repoId }))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Create or update a lightweight work session.
 *
 * Lightweight sessions are persisted for recovery but don't create
 * WorkHandle or WorkContract records. They track minimal state needed
 * for diff/rollback operations.
 */
export function createLightweightSession(
  controllerHome: string,
  input: LightweightWorkSessionInput,
): LightweightWorkSession {
  const at = new Date().toISOString();
  const key = sessionKey(input.sessionId, input.repoId);

  const session: LightweightWorkSession = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    branch: input.branch,
    baselineHead: input.baselineHead,
    baselineDirtyPaths: input.baselineDirtyPaths?.slice(0, 2_000),
    baselineDirtyPathCount: input.baselineDirtyPaths?.length,
    createdAt: at,
    updatedAt: at,
  };

  writeControlPlaneRecord<LightweightWorkSession>(controllerHome, {
    namespace: 'lightweight_work_session',
    scope: input.repoId,
    key,
    schemaVersion: 1,
    value: session,
  });

  return session;
}

/**
 * Read an existing lightweight work session.
 */
export function readLightweightSession(
  controllerHome: string,
  sessionId: string,
  repoId: string,
): LightweightWorkSession | undefined {
  const key = sessionKey(sessionId, repoId);

  const record = readOrImportControlPlaneRecord<LightweightWorkSession>(controllerHome, {
    namespace: 'lightweight_work_session',
    scope: repoId,
    key,
    schemaVersion: 1,
    readLegacy: () => undefined, // No legacy format
  });

  return record?.value;
}

/**
 * Update lightweight session timestamp (for heartbeat/activity tracking).
 */
export function touchLightweightSession(
  controllerHome: string,
  sessionId: string,
  repoId: string,
): LightweightWorkSession | undefined {
  const existing = readLightweightSession(controllerHome, sessionId, repoId);
  if (!existing) return undefined;

  const updated: LightweightWorkSession = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };

  const key = sessionKey(sessionId, repoId);
  writeControlPlaneRecord<LightweightWorkSession>(controllerHome, {
    namespace: 'lightweight_work_session',
    scope: repoId,
    key,
    schemaVersion: 1,
    value: updated,
  });

  return updated;
}

/**
 * Check if a session should use lightweight mode.
 *
 * Lightweight mode is appropriate when:
 * - isolation=reuse (working on current branch)
 * - No work_id specified (not resuming existing Work)
 * - Simple operations (not long-running features)
 *
 * For now, lightweight mode is opt-in via explicit flag to maintain
 * backward compatibility. Will become default in future phases.
 */
export function shouldUseLightweightMode(args: Record<string, unknown>): boolean {
  // Opt-in flag for lightweight mode (Phase 2 conservative rollout)
  // This prevents breaking existing tests and workflows
  if (args.lightweight !== true) return false;

  // Must be explicit reuse or auto that resolves to reuse
  const isolation = typeof args.isolation === 'string' ? args.isolation : 'auto';
  if (isolation === 'new_worktree') return false;

  // Must not be resuming existing Work
  if (args.work_id) return false;

  // Must not be relocating
  if (args.relocate_to_new_worktree === true) return false;

  // Must not be recovering
  if (args.expected_previous_head || args.adopt_candidate_head) return false;

  return isolation === 'reuse';
}

/**
 * Get the current changes since lightweight session baseline.
 *
 * Returns files that are dirty now but weren't at baseline,
 * indicating they were modified during this session.
 */
export function getLightweightSessionChanges(
  session: LightweightWorkSession,
  currentDirtyPaths: Set<string>,
): string[] {
  if (!session.baselineDirtyPaths) {
    // All current dirty files are session changes
    return [...currentDirtyPaths].sort();
  }

  const baseline = new Set(session.baselineDirtyPaths);
  const changes: string[] = [];

  for (const path of currentDirtyPaths) {
    if (!baseline.has(path)) {
      changes.push(path);
    }
  }

  return changes.sort();
}
