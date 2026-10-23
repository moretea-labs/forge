import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorDatabasePathValue, workflowSupervisorRootPath } from './paths';
import { validateSupervisorObjective } from './protocol';
import type { WorkflowEffectKind, WorkflowEffectOutcome, WorkflowSupervisorCompletion, WorkflowSupervisorContinuationProof, WorkflowSupervisorDiscoverySnapshot, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTaskStall, WorkflowSupervisorTerminalState, WorkflowSupervisorPreflightComposerObservation, WorkflowSupervisorSilentTurn } from './types';
export type { WorkflowSupervisorTaskStall } from './types';

interface Statement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown; finalize?(): void }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const require = createRequire(import.meta.url);

function databaseConstructor(): new (path: string) => Database {
  const module = require(process.versions.bun ? 'bun:sqlite' : 'node:sqlite') as { Database?: new (path: string) => Database; DatabaseSync?: new (path: string) => Database };
  const Constructor = module.Database ?? module.DatabaseSync;
  if (!Constructor) throw new Error('WORKFLOW_SUPERVISOR_SQLITE_UNAVAILABLE');
  return Constructor;
}

function statement<T>(db: Database, sql: string, fn: (statement: Statement) => T): T {
  const prepared = db.prepare(sql);
  try { return fn(prepared); } finally { prepared.finalize?.(); }
}
function now(): string { return new Date().toISOString(); }
function objectiveSha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function projectMetadataFromConversationUrl(value: string, observedTitle?: string, observedUrl?: string): { projectTitle?: string; projectUrl: string } | undefined {
  try {
    const parsed = new URL(value);
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?\/c\/[a-z0-9-]+\/?$/i.exec(parsed.pathname);
    const slug = match?.[2]?.trim();
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || !match?.[1]) return undefined;
    let observedProjectId: string | undefined;
    try {
      const observed = new URL(observedUrl ?? '');
      if (observed.origin === parsed.origin) observedProjectId = /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(observed.pathname)?.[1];
    } catch { /* An unproven title cannot override the canonical route. */ }
    const projectTitle = observedProjectId?.toLowerCase() === match[1].toLowerCase()
      ? observedTitle ?? slug?.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      : slug?.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      ...(projectTitle ? { projectTitle } : {}),
      projectUrl: `https://chatgpt.com/g/${match[1]}/project`,
    };
  } catch {
    return undefined;
  }
}
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => json(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b));
    return `{${entries.map(([key,item]) => `${JSON.stringify(key)}:${json(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function workflowSupervisorCompletionContractSha256(contract: Record<string, unknown>): string {
  return createHash('sha256').update(json(contract)).digest('hex');
}

export { resolveWorkflowSupervisorForgeHome } from './paths';
export function workflowSupervisorRoot(forgeHome?: string): string {
  const root = workflowSupervisorRootPath(forgeHome);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
export function workflowSupervisorDatabasePath(forgeHome?: string): string {
  workflowSupervisorRoot(forgeHome);
  return workflowSupervisorDatabasePathValue(forgeHome);
}

function openDatabase(forgeHome?: string): Database {
  const Constructor = databaseConstructor();
  const db = new Constructor(workflowSupervisorDatabasePath(forgeHome));
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, conversation_url TEXT NOT NULL, objective TEXT NOT NULL,
      completion_contract_json TEXT NOT NULL, continuation_policy_json TEXT NOT NULL, user_blocker_policy_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS completions (
      completion_fingerprint TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), source_effect_id TEXT NOT NULL,
      action TEXT NOT NULL, response_sha256 TEXT NOT NULL, control_block_sha256 TEXT NOT NULL, proposal_json TEXT NOT NULL, committed_at TEXT NOT NULL,
      UNIQUE(task_id, source_effect_id, response_sha256, control_block_sha256)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS completions_one_per_source_effect
      ON completions(task_id, source_effect_id);
    CREATE TABLE IF NOT EXISTS effects (
      effect_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), kind TEXT NOT NULL, origin_key TEXT NOT NULL UNIQUE,
      source_completion_fingerprint TEXT, prompt_text TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(task_id, source_completion_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id), event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, effect_id TEXT, completion_fingerprint TEXT, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_task_order ON events(task_id, event_id);
    -- Terminal probes run for every task on the polling/reconciliation paths.
    -- Index only terminal facts so an open task does not rescan its whole log.
    CREATE INDEX IF NOT EXISTS events_terminal_task_order ON events(task_id, event_id)
      WHERE kind IN ('terminal_done','terminal_needs_user','terminal_stopped');
    CREATE INDEX IF NOT EXISTS events_effect_kind_order ON events(effect_id, kind, event_id);
    CREATE TABLE IF NOT EXISTS discovered_conversations (
      source TEXT NOT NULL, conversation_id TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT,
      project_title TEXT, project_url TEXT, observed_at TEXT NOT NULL,
      PRIMARY KEY(source, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS discovered_conversations_observed ON discovered_conversations(observed_at, conversation_id);
    INSERT OR IGNORE INTO supervisor_schema(version, applied_at) VALUES (1, datetime('now'));
  `);
  const schema = statement(db, 'SELECT MAX(version) AS version FROM supervisor_schema', (s) => s.get()) as { version?: number } | undefined;
  if (schema?.version !== 1) { db.close(); throw new Error(`WORKFLOW_SUPERVISOR_SCHEMA_UNSUPPORTED:${String(schema?.version ?? 'missing')}`); }
  return db;
}

function taskFromRow(row: Record<string, unknown>): WorkflowSupervisorTask {
  return {
    taskId: String(row.task_id), conversationId: String(row.conversation_id), conversationUrl: String(row.conversation_url), objective: String(row.objective),
    completionContract: JSON.parse(String(row.completion_contract_json)) as Record<string, unknown>, continuationPolicy: JSON.parse(String(row.continuation_policy_json)) as Record<string, unknown>,
    userBlockerPolicy: JSON.parse(String(row.user_blocker_policy_json)) as Record<string, unknown>, createdAt: String(row.created_at),
  };
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function explicitRequirementTaskUpgrade(input: WorkflowSupervisorTaskInput): { requirementId: string; repoId: string } | undefined {
  if (input.completionContract.kind !== 'forge_requirement_done'
    || input.continuationPolicy.kind !== 'forge_goal_outer_turn'
    || input.userBlockerPolicy.kind !== 'forge_requirement_waiting_for_user') return undefined;
  const requirementId = boundedText(input.completionContract.requirement_id);
  const blockerRequirementId = boundedText(input.userBlockerPolicy.requirement_id);
  const repoId = boundedText(input.completionContract.repo_id);
  const blockerRepoId = boundedText(input.userBlockerPolicy.repo_id);
  if (!requirementId || blockerRequirementId !== requirementId || !repoId || blockerRepoId !== repoId) return undefined;
  if (boundedText(input.continuationPolicy.exact_conversation_id) !== input.conversationId
    || boundedText(input.continuationPolicy.exact_conversation_url) !== input.conversationUrl) return undefined;
  return { requirementId, repoId };
}
function effectFromRow(row: Record<string, unknown>): WorkflowSupervisorEffect {
  return { effectId: String(row.effect_id), taskId: String(row.task_id), kind: String(row.kind) as WorkflowEffectKind,
    ...(row.source_completion_fingerprint ? { sourceCompletionFingerprint: String(row.source_completion_fingerprint) } : {}), prompt: String(row.prompt_text), createdAt: String(row.created_at) };
}

function completionFromRow(row: Record<string, unknown>): WorkflowSupervisorCompletion {
  return {
    completionFingerprint: String(row.completion_fingerprint), taskId: String(row.task_id), sourceEffectId: String(row.source_effect_id),
    action: String(row.action) as WorkflowSupervisorCompletion['action'], responseSha256: String(row.response_sha256), controlBlockSha256: String(row.control_block_sha256),
    proposal: JSON.parse(String(row.proposal_json)) as WorkflowSupervisorCompletion['proposal'], committedAt: String(row.committed_at),
  };
}
function parsedObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
function storedGeneration(value: unknown): number {
  const generation = Number(parsedObject(value).generation);
  return Number.isInteger(generation) && generation > 0 ? generation : 1;
}
function latestNotAppliedProofEventId(db: Database, effectId: string): number {
  // Delayed negative evidence from an older generation must not authorize
  // another Send while the latest generation is outcome-unknown. Apply this
  // read-side fence to journals written by earlier releases as well.
  const dispatch = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number; payload_json?: string } | undefined;
  if (!dispatch?.event_id) return 0;
  const notApplied = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_not_applied' AND event_id > ? AND json_extract(payload_json,'$.dispatch_generation') = ? ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId, dispatch.event_id, storedGeneration(dispatch.payload_json))) as { event_id?: number } | undefined;
  return Number(notApplied?.event_id ?? 0);
}

/** A durable operator supersession retires an effect from the causal obligation; it is never replayed. */
function effectSuperseded(db: Database, effectId: string): boolean {
  return Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_outcome_unknown_superseded' LIMIT 1", (s) => s.get(effectId)));
}

function appliedEffectAwaitingCompletionWithin(db: Database, taskId: string): boolean {
  return Boolean(statement(db, `SELECT 1 AS ok FROM effects e
    WHERE e.task_id = ?
      AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied')
      AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id)
      -- Once the exact provider recovery actually commits a receipt, the
      -- dispatched parent can no longer commit a competing completion.
      -- Its causal observation is fulfilled by the completed recovery child.
      -- Merely reserving/dispatching/applying a child never lifts this fence.
      AND NOT EXISTS (SELECT 1 FROM effects child
        JOIN completions receipt ON receipt.task_id = child.task_id AND receipt.source_effect_id = child.effect_id
        WHERE child.task_id = e.task_id AND child.kind = 'recovery'
          AND child.origin_key = 'provider-recovery:' || e.effect_id)
    LIMIT 1`, (s) => s.get(taskId)));
}

function providerResumeExhaustedWithin(db: Database, effectId: string): boolean {
  return Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'assistant_recovery_exhausted' LIMIT 1", (s) => s.get(effectId)));
}

function providerRecoveryDepthWithin(db: Database, effectId: string): number {
  let currentEffectId = effectId;
  let depth = 0;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(currentEffectId)) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_RECOVERY_CHAIN_CORRUPT');
    seen.add(currentEffectId);
    const row = statement(db, 'SELECT kind,origin_key FROM effects WHERE effect_id = ?', (s) => s.get(currentEffectId)) as { kind?: string; origin_key?: string } | undefined;
    if (!row) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_RECOVERY_CHAIN_CORRUPT');
    const originKey = String(row.origin_key ?? '');
    if (row.kind !== 'recovery' || !originKey.startsWith('provider-recovery:')) return depth;
    depth += 1;
    currentEffectId = originKey.slice('provider-recovery:'.length).trim();
    if (!currentEffectId) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_RECOVERY_CHAIN_CORRUPT');
  }
}

function operatorAuthorizedRefundCount(db: Database, effectId: string): number {
  const row = statement(db, "SELECT COUNT(*) AS total FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_budget_refunded' AND json_extract(payload_json,'$.reason') = 'operator_authorized_retry'", (s) => s.get(effectId)) as { total?: number } | undefined;
  return Number(row?.total ?? 0);
}

function oldestUnappliedEffect(db: Database, taskId: string): WorkflowSupervisorEffect | undefined {
  const row = statement(db, `SELECT e.* FROM effects e
    WHERE e.task_id = ? AND NOT EXISTS (
      SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied'
    ) AND NOT EXISTS (
      SELECT 1 FROM events superseded WHERE superseded.effect_id = e.effect_id AND superseded.kind = 'effect_outcome_unknown_superseded'
    ) AND NOT (
      e.kind = 'recovery' AND NOT EXISTS (
        SELECT 1 FROM events started
        WHERE started.effect_id = e.effect_id AND started.kind = 'effect_dispatch_started'
      ) AND EXISTS (
        SELECT 1 FROM completions completed
        WHERE completed.task_id = e.task_id
          AND e.origin_key = 'provider-recovery:' || completed.source_effect_id
      )
    ) ORDER BY
      -- A started send owns reconciliation/retry before any fresh successor.
      -- Millisecond timestamps and hashed effect IDs cannot prove causal order.
      CASE WHEN EXISTS (SELECT 1 FROM events started
        WHERE started.effect_id = e.effect_id AND started.kind = 'effect_dispatch_started') THEN 0 ELSE 1 END,
      e.created_at, e.rowid LIMIT 1`, (s) => s.get(taskId)) as Record<string, unknown> | undefined;
  return row ? effectFromRow(row) : undefined;
}

/**
 * Mechanical ceiling on how many times one un-applied Supervisor effect may be
 * submitted to the provider. A proven non-application may legitimately be
 * retried, but ChatGPT is one rate-limited shared resource: without a ceiling a
 * single stuck effect minted an unbounded generation chain (live evidence:
 * single effects were re-sent 130-166 times over hours), which is provider
 * request volume that no Work actually asked for. Three total attempts is the
 * hard ceiling: one normal submission plus at most two causally authorized retries.
 */
export const WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS = 3;
/** A broken preparation cannot silently poll forever across Runtime restarts. */
export const WORKFLOW_SUPERVISOR_MAX_PREFLIGHT_RELEASE_ATTEMPTS = 3;

/**
 * Once a provider has accepted a Supervisor effect, recovery never replays that
 * source mutation. It may emit at most two separately identified recovery turns,
 * matching the repository-wide three-provider-attempt ceiling (initial turn plus
 * two causal retries). The depth is derived from effect origin links, not stored
 * as another lifecycle state.
 */
export const WORKFLOW_SUPERVISOR_MAX_PROVIDER_RECOVERY_TURNS = 2;
/** Stable idle evidence, never Runtime heartbeat, starts the bounded recovery clock. */
export const WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS = 30 * 60_000;
export const WORKFLOW_SUPERVISOR_DISPATCH_RETRY_BASE_MS = 30_000;
export const WORKFLOW_SUPERVISOR_DISPATCH_RETRY_MAX_MS = 10 * 60_000;
export const WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_BASE_MS = 5_000;
export const WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_MAX_MS = 60_000;
/**
 * An explicit operator recovery may refund the mechanical retry budget for an
 * effect whose latest dispatch carries a mechanical pre-send negative proof.
 * That is a safety statement about *this* effect, not a reset of provider
 * budgets, so it stays bounded: exceeding it requires a new explicit decision
 * rather than another silent attempt.
 */
export const WORKFLOW_SUPERVISOR_MAX_OPERATOR_REFUNDS = 2;
/**
 * A standalone Supervisor task's conversation is its delivery surface. If that
 * exact conversation becomes permanently unusable, an explicit operator may
 * move the task to a replacement conversation. The budget keeps a transient
 * provider problem from turning into a conversation-hopping loop.
 */
export const WORKFLOW_SUPERVISOR_MAX_CONVERSATION_MIGRATIONS = 2;

/** Spaced retries keep a persistent local obstacle from becoming a request storm. */
export function workflowSupervisorDispatchRetryDelayMs(generation: number): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(generation) - 1));
  return Math.min(WORKFLOW_SUPERVISOR_DISPATCH_RETRY_MAX_MS, WORKFLOW_SUPERVISOR_DISPATCH_RETRY_BASE_MS * 2 ** exponent);
}

export interface WorkflowSupervisorEffectDispatchBudget {
  effectId: string;
  generations: number;
  maxGenerations: number;
  lastDispatchedAtMs?: number;
  retryDelayMs?: number;
  exhausted: boolean;
}


interface EffectDispatchLedger {
  generations: number;
  budgetRefunds: number;
  lastEventId: number;
  lastGeneration: number;
  lastOccurredAtMs: number;
}

interface EffectUnknownObservationLedger {
  sameFingerprintCount: number;
  lastOccurredAtMs: number;
  fingerprint?: string;
}

function unknownObservationFingerprintFromObject(payload: Record<string, unknown>): string | undefined {
  const explicit = boundedText(payload.observation_fingerprint);
  if (explicit) return `explicit:${explicit}`;
  // A transport may fail before a Browser snapshot exists. The canonical
  // ledger still has to collapse repeated identical transport failures from
  // native messaging, extensions, or older adapters. A changed reason/surface
  // is materially new evidence and receives a fresh bounded budget.
  const reason = boundedText(payload.reason) ?? 'unknown';
  const surface = boundedText(payload.surface) ?? '';
  const reconciliation = payload.reconciliation === true ? 'reconcile' : 'observe';
  return `fallback:${surface}:${reconciliation}:${reason}`;
}

function unknownObservationFingerprint(payloadJson: unknown): string | undefined {
  return unknownObservationFingerprintFromObject(parsedObject(payloadJson));
}

function effectUnknownObservationLedger(db: Database, effectId: string, afterEventId: number): EffectUnknownObservationLedger {
  const rows = statement(db, "SELECT event_id,payload_json,occurred_at FROM events WHERE effect_id = ? AND kind = 'effect_unknown' AND event_id > ? ORDER BY event_id DESC LIMIT 32", (s) => s.all(effectId, afterEventId)) as Array<{ event_id?: number; payload_json?: string; occurred_at?: string }>;
  const latest = rows[0];
  if (!latest) return { sameFingerprintCount: 0, lastOccurredAtMs: 0 };
  const fingerprint = unknownObservationFingerprint(latest.payload_json);
  if (!fingerprint) return { sameFingerprintCount: 0, lastOccurredAtMs: 0 };
  let sameFingerprintCount = 0;
  for (const row of rows) {
    if (unknownObservationFingerprint(row.payload_json) !== fingerprint) break;
    sameFingerprintCount += 1;
  }
  const occurredAtMs = Date.parse(String(latest.occurred_at ?? ''));
  return {
    sameFingerprintCount,
    lastOccurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : 0,
    fingerprint,
  };
}

function unknownObservationDelayMs(count: number): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(count) - 1));
  return Math.min(
    WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_MAX_MS,
    WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_BASE_MS * 2 ** exponent,
  );
}

function unknownObservationDue(db: Database, effectId: string, afterEventId: number, nowMs: number): boolean {
  const observation = effectUnknownObservationLedger(db, effectId, afterEventId);
  return observation.sameFingerprintCount === 0
    || nowMs - observation.lastOccurredAtMs >= unknownObservationDelayMs(observation.sameFingerprintCount);
}

function effectDispatchLedger(db: Database, effectId: string): EffectDispatchLedger {
  const rows = statement(db, "SELECT event_id,payload_json,occurred_at FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id", (s) => s.all(effectId)) as Array<{ event_id?: number; payload_json?: string; occurred_at?: string }>;
  const last = rows[rows.length - 1];
  const refundRows = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_budget_refunded'", (s) => s.all(effectId)) as Array<{ event_id?: number }>;
  const payload = parsedObject(last?.payload_json);
  const payloadMs = Number(payload.dispatched_at_ms);
  const lastOccurredAtMs = Number.isFinite(payloadMs) && payloadMs > 0
    ? payloadMs
    : Date.parse(String(last?.occurred_at ?? ''));
  return {
    generations: rows.length,
    budgetRefunds: refundRows.length,
    lastEventId: Number(last?.event_id ?? 0),
    lastGeneration: last?.event_id ? storedGeneration(last.payload_json) : 0,
    lastOccurredAtMs: Number.isFinite(lastOccurredAtMs) ? lastOccurredAtMs : 0,
  };
}
/** Derived entirely from the Supervisor effect event log; no second retry authority. */
function effectPreflightFailureReleaseIds(db: Database, effectId: string): Array<{ eventId: number; releaseId: string }> {
  const rows = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_preflight_rejected' ORDER BY event_id", (s) => s.all(effectId)) as Array<{ event_id?: number; payload_json?: string }>;
  return rows.map((row) => ({ eventId: Number(row.event_id ?? 0), releaseId: String(parsedObject(row.payload_json).active_release_id ?? 'unidentified-runtime') }));
}

export class WorkflowSupervisorStore {
  private readonly db: Database;
  private closed = false;
  /** Mechanical clock for provider retry spacing. Durable event timestamps keep wall-clock ISO. */
  private readonly clockMs: () => number;
  private readonly activeReleaseId: () => string | undefined;

  constructor(readonly forgeHome?: string, options: { now?: () => number; activeReleaseId?: () => string | undefined } = {}) {
    this.db = openDatabase(forgeHome);
    this.clockMs = options.now ?? Date.now;
    this.activeReleaseId = options.activeReleaseId ?? (() => undefined);
  }

  private preflightBlocked(db: Database, effectId: string): boolean {
    const tried = effectPreflightFailureReleaseIds(db, effectId);
    const releaseId = this.activeReleaseId()?.trim() || 'unidentified-runtime';
    const lastFailure = tried.filter((entry) => entry.releaseId === releaseId).at(-1);
    // Three failed preflights exhaust automatic re-preparation. An explicit
    // operator rearm is scoped to the active release and does not erase prior
    // failures; a failed post-rearm preparation blocks the same effect again.
    const rearm = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_preflight_operator_rearmed' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number } | undefined;
    const rearmedEventId = Number(rearm?.event_id ?? 0);
    if (tried.length >= WORKFLOW_SUPERVISOR_MAX_PREFLIGHT_RELEASE_ATTEMPTS) {
      return rearmedEventId <= (tried.at(-1)?.eventId ?? 0);
    }
    if (!lastFailure) return false;
    return rearmedEventId <= lastFailure.eventId;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private database(): Database {
    if (this.closed) throw new Error('WORKFLOW_SUPERVISOR_STORE_CLOSED');
    return this.db;
  }

  private transaction<T>(fn: (db: Database) => T): T {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private read<T>(fn: (db: Database) => T): T { return fn(this.database()); }

  recordDiscovery(source: string, conversations: readonly WorkflowSupervisorDiscoveredConversation[]): WorkflowSupervisorDiscoverySnapshot {
    const normalizedSource = source.trim();
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(normalizedSource)) throw new Error('WORKFLOW_SUPERVISOR_DISCOVERY_SOURCE_INVALID');
    const observedAt = now();
    this.transaction((db) => {
      for (const conversation of conversations) {
        const project = projectMetadataFromConversationUrl(conversation.canonicalUrl, conversation.projectTitle, conversation.projectUrl)
          ?? { projectTitle: conversation.projectTitle, projectUrl: conversation.projectUrl };
        statement(db, `INSERT INTO discovered_conversations(source,conversation_id,canonical_url,title,project_title,project_url,observed_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(source,conversation_id) DO UPDATE SET canonical_url=excluded.canonical_url,title=excluded.title,
            project_title=CASE WHEN excluded.project_url IS NOT NULL AND discovered_conversations.project_url IS NOT NULL
              AND excluded.project_url<>discovered_conversations.project_url THEN excluded.project_title
              ELSE COALESCE(excluded.project_title,discovered_conversations.project_title) END,
            project_url=COALESCE(excluded.project_url,discovered_conversations.project_url),observed_at=excluded.observed_at`,
        (s) => s.run(normalizedSource, conversation.conversationId, conversation.canonicalUrl, conversation.title ?? null, project.projectTitle ?? null, project.projectUrl ?? null, observedAt));
      }
    });
    return this.discoverySnapshot();
  }

  discoverySnapshot(): WorkflowSupervisorDiscoverySnapshot {
    return this.read((db) => {
      const rows = statement(db, 'SELECT * FROM discovered_conversations ORDER BY observed_at DESC, conversation_id, source', (s) => s.all()) as Record<string, unknown>[];
      const byConversation = new Map<string, WorkflowSupervisorDiscoveredConversation>();
      let observedAt = '';
      for (const row of rows) {
        const conversationId = String(row.conversation_id ?? '');
        const canonicalUrl = String(row.canonical_url ?? '');
        // Validate retained observations too: an older adapter may have tagged
        // every sidebar conversation with the project page it happened to scan.
        const project = projectMetadataFromConversationUrl(canonicalUrl, row.project_title ? String(row.project_title) : undefined, row.project_url ? String(row.project_url) : undefined)
          ?? { projectTitle: row.project_title ? String(row.project_title) : undefined, projectUrl: row.project_url ? String(row.project_url) : undefined };
        const rowObservedAt = String(row.observed_at ?? '');
        if (rowObservedAt > observedAt) observedAt = rowObservedAt;
        const current = byConversation.get(conversationId);
        const candidate: WorkflowSupervisorDiscoveredConversation = {
          conversationId,
          canonicalUrl,
          ...(row.title ? { title: String(row.title) } : {}),
          ...(project.projectTitle ? { projectTitle: project.projectTitle } : {}),
          ...(project.projectUrl ? { projectUrl: project.projectUrl } : {}),
        };
        if (!current) byConversation.set(conversationId, candidate);
        else if (!current.projectTitle && candidate.projectTitle && (!current.projectUrl || current.projectUrl === candidate.projectUrl)) byConversation.set(conversationId, { ...current, projectTitle: candidate.projectTitle, ...(candidate.projectUrl ? { projectUrl: candidate.projectUrl } : {}) });
      }
      return { observedAt, conversations: [...byConversation.values()] };
    });
  }

  registerTask(input: WorkflowSupervisorTaskInput): WorkflowSupervisorTask {
    validateSupervisorObjective(input.objective);
    return this.transaction((db) => {
      const createdAt = now();
      statement(db, 'INSERT OR IGNORE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (s) => s.run(input.taskId, input.conversationId, input.conversationUrl, input.objective, json(input.completionContract), json(input.continuationPolicy), json(input.userBlockerPolicy), createdAt));
      let row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) {
        row = statement(db, 'SELECT * FROM tasks WHERE conversation_id = ?', (s) => s.get(input.conversationId)) as Record<string, unknown> | undefined;
        if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
        const existing = taskFromRow(row);
        if (existing.conversationUrl !== input.conversationUrl) throw new Error('WORKFLOW_SUPERVISOR_TASK_CONVERSATION_CONFLICT');
        const existingRepo = typeof existing.completionContract.repo_id === 'string' ? existing.completionContract.repo_id : existing.continuationPolicy.repo_id;
        const incomingRepo = typeof input.completionContract.repo_id === 'string' ? input.completionContract.repo_id : input.continuationPolicy.repo_id;
        if (typeof existingRepo === 'string' && typeof incomingRepo === 'string' && existingRepo !== incomingRepo) throw new Error('WORKFLOW_SUPERVISOR_TASK_REPOSITORY_CONFLICT');
        return existing;
      }
      const task = taskFromRow(row);
      const taskRepo = typeof task.completionContract.repo_id === 'string' ? task.completionContract.repo_id : task.continuationPolicy.repo_id;
      const inputRepo = typeof input.completionContract.repo_id === 'string' ? input.completionContract.repo_id : input.continuationPolicy.repo_id;
      const { checkout_id: incomingCheckout, ...incomingCompletion } = input.completionContract;
      const { checkout_id: selectedCheckout, ...selectedCompletion } = task.completionContract;
      // Registration may fill an initially missing execution hint. It cannot
      // replace a selected checkout or change task identity/semantic obligations.
      const sameExecutionContextOwner = typeof taskRepo === 'string' && taskRepo === inputRepo
        && task.conversationId === input.conversationId && task.conversationUrl === input.conversationUrl
        && task.objective === input.objective
        && json(selectedCompletion) === json(incomingCompletion)
        && json(task.continuationPolicy) === json(input.continuationPolicy)
        && json(task.userBlockerPolicy) === json(input.userBlockerPolicy);
      // A retry of the original registration cannot erase the selected hint.
      if (sameExecutionContextOwner && selectedCheckout !== undefined && incomingCheckout === undefined) return task;
      const initialCheckoutContext = sameExecutionContextOwner && selectedCheckout === undefined
        && task.continuationPolicy.checkout_id === undefined
        && typeof incomingCheckout === 'string' && /^checkout_[a-zA-Z0-9_-]{8,120}$/.test(incomingCheckout);
      if (initialCheckoutContext) {
        statement(db, 'UPDATE tasks SET completion_contract_json = ? WHERE task_id = ?', s => s.run(json(input.completionContract), task.taskId));
        statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', s => s.run(
          task.taskId, `task-checkout-context:${task.taskId}`, 'task_execution_context_enriched', json({ repo_id: taskRepo, checkout_id: incomingCheckout }), createdAt,
        ));
        return { ...task, completionContract: input.completionContract };
      }
      const bootstrapUpgrade = task.continuationPolicy.bootstrap === true
        && input.continuationPolicy.bootstrap !== true
        && taskRepo === inputRepo
        && task.conversationId === input.conversationId
        && task.conversationUrl === input.conversationUrl;
      if (bootstrapUpgrade) {
        const existingWorkId = boundedText(task.completionContract.work_id);
        const existingRequirementId = boundedText(task.completionContract.requirement_id);
        const incomingWorkId = boundedText(input.completionContract.work_id);
        const incomingRequirementId = boundedText(input.completionContract.requirement_id);
        if ((existingWorkId && incomingWorkId !== existingWorkId)
          || (existingRequirementId && incomingRequirementId !== existingRequirementId)) {
          throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_CONFLICT');
        }
        statement(db, `UPDATE tasks
          SET objective = ?, completion_contract_json = ?, continuation_policy_json = ?, user_blocker_policy_json = ?
          WHERE task_id = ?`, (s) => s.run(
          input.objective,
          json(input.completionContract),
          json(input.continuationPolicy),
          json(input.userBlockerPolicy),
          input.taskId,
        ));
        const upgraded = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
        if (!upgraded) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
        return taskFromRow(upgraded);
      }
      const projectBootstrap = task.continuationPolicy.kind === 'forge_project_conversation_outer_turn';
      const sameProjectBootstrapIdentity = projectBootstrap
        && task.conversationId === input.conversationId
        && task.conversationUrl === input.conversationUrl
        && (!taskRepo || !inputRepo || taskRepo === inputRepo);
      if (sameProjectBootstrapIdentity) {
        const explicitRequirementUpgrade = explicitRequirementTaskUpgrade(input);
        if (input.continuationPolicy.kind === 'forge_goal_outer_turn') {
          if (!explicitRequirementUpgrade || !taskRepo || taskRepo !== explicitRequirementUpgrade.repoId) {
            throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');
          }
          statement(db, `UPDATE tasks
            SET objective = ?, completion_contract_json = ?, continuation_policy_json = ?, user_blocker_policy_json = ?
            WHERE task_id = ?`, (s) => s.run(
            input.objective,
            json(input.completionContract),
            json(input.continuationPolicy),
            json(input.userBlockerPolicy),
            input.taskId,
          ));
          const upgraded = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
          if (!upgraded) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
          return taskFromRow(upgraded);
        }
        return task;
      }
      if (task.conversationId !== input.conversationId
        || task.conversationUrl !== input.conversationUrl
        || task.objective !== input.objective
        || json(task.completionContract) !== json(input.completionContract)
        || json(task.continuationPolicy) !== json(input.continuationPolicy)
        || json(task.userBlockerPolicy) !== json(input.userBlockerPolicy)) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');
      }
      return task;
    });
  }
  reviseTaskObjective(input: {
    taskId: string;
    objective: string;
    expectedObjectiveSha256: string;
    requestId: string;
    authorizedBy: string;
    refreshEffect?: { effectId: string; expectedPrompt: string; prompt: string };
    semanticBinding?: { workId?: string; requirementId?: string; expectedCompletionContractSha256: string };
  }): { task: WorkflowSupervisorTask; changed: boolean; deduplicated: boolean; objectiveSha256: string; completionContractSha256: string; semanticBindingChanged: boolean; refreshedEffect?: WorkflowSupervisorEffect } {
    return this.transaction((db) => {
      const objective = validateSupervisorObjective(input.objective);
      if (!/^[0-9a-f]{64}$/i.test(input.expectedObjectiveSha256)) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_EXPECTED_SHA_INVALID');
      if (!input.requestId.trim()) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_REQUEST_REQUIRED');
      const targetSha = objectiveSha256(objective);
      const semanticBinding = input.semanticBinding;
      const workId = boundedText(semanticBinding?.workId);
      const requirementId = boundedText(semanticBinding?.requirementId);
      if (semanticBinding) {
        if (Boolean(workId) === Boolean(requirementId)) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_TARGET_INVALID');
        if (!/^[0-9a-f]{64}$/i.test(semanticBinding.expectedCompletionContractSha256)) {
          throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_EXPECTED_SHA_INVALID');
        }
      }
      const semanticBindingKind = workId ? 'work' : requirementId ? 'requirement' : undefined;
      const semanticBindingId = workId ?? requirementId;
      const eventKey = `task-objective-revise:${input.taskId}:${input.requestId}`;
      const bindingEventKey = `task-semantic-binding-revise:${input.taskId}:${input.requestId}`;
      const existingEvent = statement(db, 'SELECT payload_json FROM events WHERE event_key = ?', (s) => s.get(eventKey)) as { payload_json?: string } | undefined;
      const existingBindingEvent = statement(db, 'SELECT payload_json FROM events WHERE event_key = ?', (s) => s.get(bindingEventKey)) as { payload_json?: string } | undefined;
      if (existingEvent) {
        const payload = parsedObject(existingEvent.payload_json);
        if (boundedText(payload.objective_sha256) !== targetSha
          || boundedText(payload.semantic_binding_id) !== semanticBindingId
          || boundedText(payload.semantic_binding_kind) !== semanticBindingKind
          || Boolean(existingBindingEvent) !== Boolean(semanticBinding)) {
          throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_REQUEST_CONFLICT');
        }
        if (existingBindingEvent) {
          const bindingPayload = parsedObject(existingBindingEvent.payload_json);
          if (boundedText(bindingPayload.completion_contract_sha256) !== boundedText(payload.completion_contract_sha256)
            || boundedText(bindingPayload.semantic_binding_id) !== semanticBindingId
            || boundedText(bindingPayload.semantic_binding_kind) !== semanticBindingKind) {
            throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REVISION_REQUEST_CONFLICT');
          }
        }
        const taskRow = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
        if (!taskRow) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
        const deduplicatedTask = taskFromRow(taskRow);
        const refreshedEffectId = boundedText(payload.refreshed_effect_id);
        const refreshedRow = refreshedEffectId
          ? statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(refreshedEffectId)) as Record<string, unknown> | undefined
          : undefined;
        return {
          task: deduplicatedTask,
          changed: payload.changed === true,
          deduplicated: true,
          objectiveSha256: targetSha,
          completionContractSha256: workflowSupervisorCompletionContractSha256(deduplicatedTask.completionContract),
          semanticBindingChanged: payload.semantic_binding_changed === true,
          ...(refreshedRow ? { refreshedEffect: effectFromRow(refreshedRow) } : {}),
        };
      }
      if (existingBindingEvent) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REVISION_REQUEST_CONFLICT');
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const terminal = statement(db, "SELECT kind FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') ORDER BY event_id DESC LIMIT 1", (s) => s.get(input.taskId)) as { kind?: string } | undefined;
      if (terminal?.kind) throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      const task = taskFromRow(row);
      const currentSha = objectiveSha256(task.objective);
      if (currentSha !== input.expectedObjectiveSha256.toLowerCase()) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_CONFLICT');

      const currentContractSha = workflowSupervisorCompletionContractSha256(task.completionContract);
      let nextCompletionContract = task.completionContract;
      let completionContractSha = currentContractSha;
      let semanticBindingChanged = false;
      if (semanticBinding) {
        if (task.completionContract.kind !== 'model_semantic_completion') {
          throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REVISION_KIND_UNSUPPORTED');
        }
        const currentWorkId = boundedText(task.completionContract.work_id);
        const currentRequirementId = boundedText(task.completionContract.requirement_id);
        if ((currentWorkId || currentRequirementId)
          && (currentWorkId !== workId || currentRequirementId !== requirementId)) {
          throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_CONFLICT');
        }
        if (currentContractSha !== semanticBinding.expectedCompletionContractSha256.toLowerCase()) {
          throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_CONFLICT');
        }
        nextCompletionContract = {
          ...task.completionContract,
          ...(workId ? { work_id: workId } : { requirement_id: requirementId }),
        };
        completionContractSha = workflowSupervisorCompletionContractSha256(nextCompletionContract);
        semanticBindingChanged = completionContractSha !== currentContractSha;
      }

      let refreshedEffect: WorkflowSupervisorEffect | undefined;
      if (input.refreshEffect) {
        const effectRow = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(input.refreshEffect!.effectId)) as Record<string, unknown> | undefined;
        if (!effectRow) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
        const effect = effectFromRow(effectRow);
        if (effect.taskId !== input.taskId) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_TASK_CONFLICT');
        if (effect.prompt !== input.refreshEffect.expectedPrompt) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_PROMPT_CONFLICT');
        const dispatched = effectDispatchLedger(db, effect.effectId).generations > 0;
        const applied = Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effect.effectId)));
        const superseded = effectSuperseded(db, effect.effectId);
        if (!dispatched && !applied && !superseded) {
          statement(db, 'UPDATE effects SET prompt_text = ? WHERE effect_id = ?', (s) => s.run(input.refreshEffect!.prompt, effect.effectId));
          const updatedEffect = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(effect.effectId)) as Record<string, unknown> | undefined;
          if (!updatedEffect) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
          refreshedEffect = effectFromRow(updatedEffect);
        }
      }

      const changed = task.objective !== objective;
      if (changed) statement(db, 'UPDATE tasks SET objective = ? WHERE task_id = ?', (s) => s.run(objective, input.taskId));
      if (semanticBindingChanged) {
        statement(db, 'UPDATE tasks SET completion_contract_json = ? WHERE task_id = ?', (s) => s.run(json(nextCompletionContract), input.taskId));
      }
      if (semanticBinding) {
        statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
          input.taskId,
          bindingEventKey,
          'task_semantic_binding_revised',
          json({
            request_id: input.requestId,
            authorized_by: input.authorizedBy,
            semantic_binding_kind: semanticBindingKind,
            semantic_binding_id: semanticBindingId,
            previous_completion_contract_sha256: currentContractSha,
            completion_contract_sha256: completionContractSha,
            changed: semanticBindingChanged,
          }),
          now(),
        ));
      }
      statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
        input.taskId,
        eventKey,
        'task_objective_revised',
        json({
          request_id: input.requestId,
          authorized_by: input.authorizedBy,
          previous_objective_sha256: currentSha,
          objective_sha256: targetSha,
          changed,
          completion_contract_sha256: completionContractSha,
          ...(semanticBinding ? {
            semantic_binding_kind: semanticBindingKind,
            semantic_binding_id: semanticBindingId,
            semantic_binding_changed: semanticBindingChanged,
          } : {}),
          ...(refreshedEffect ? { refreshed_effect_id: refreshedEffect.effectId } : {}),
        }),
        now(),
      ));
      const updatedTask = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!updatedTask) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      return {
        task: taskFromRow(updatedTask), changed, deduplicated: false, objectiveSha256: targetSha,
        completionContractSha256: completionContractSha, semanticBindingChanged,
        ...(refreshedEffect ? { refreshedEffect } : {}),
      };
    });
  }
  getTask(taskId: string): WorkflowSupervisorTask | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)); return row ? taskFromRow(row as Record<string, unknown>) : undefined; }); }
  bindScheduledWake(input: { taskId: string; repoId: string; workId: string; scheduleId: string }): { task: WorkflowSupervisorTask; changed: boolean; deduplicated: boolean } {
    const scheduleId = boundedText(input.scheduleId);
    if (!scheduleId || scheduleId.length > 512) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_ID_INVALID');
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      }
      if (task.completionContract.repo_id !== input.repoId || task.completionContract.work_id !== input.workId) {
        throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_WORK_IDENTITY_MISMATCH');
      }
      if (task.continuationPolicy.kind !== 'forge_goal_outer_turn') throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_OUTER_TURN_REQUIRED');
      const existingScheduleId = boundedText(task.continuationPolicy.scheduled_wake_schedule_id);
      if (existingScheduleId) {
        if (existingScheduleId !== scheduleId) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_BINDING_CONFLICT');
        return { task, changed: false, deduplicated: true };
      }
      const continuationPolicy = { ...task.continuationPolicy, scheduled_wake_schedule_id: scheduleId };
      statement(db, 'UPDATE tasks SET continuation_policy_json = ? WHERE task_id = ?', (s) => s.run(json(continuationPolicy), input.taskId));
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
        input.taskId, `scheduled-wake-bound:${input.taskId}:${scheduleId}`, 'scheduled_wake_bound',
        json({ repo_id: input.repoId, work_id: input.workId, schedule_id: scheduleId, attestation: 'exact_work_schedule_binding' }), now()));
      const updated = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!updated) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      return { task: taskFromRow(updated), changed: true, deduplicated: false };
    });
  }
  refreshUndispatchedEffectPrompt(input: { taskId: string; effectId: string; expectedPrompt: string; prompt: string }): boolean {
    if (!input.prompt.trim()) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_PROMPT_REQUIRED');
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(input.effectId)) as Record<string, unknown> | undefined;
      if (!row || String(row.task_id) !== input.taskId) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_TASK_MISMATCH');
      if (String(row.prompt_text) !== input.expectedPrompt) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_PROMPT_CHANGED');
      const dispatched = statement(db, "SELECT 1 FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' LIMIT 1", (s) => s.get(input.effectId));
      const applied = statement(db, "SELECT 1 FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(input.effectId));
      if (dispatched || applied) return false;
      statement(db, 'UPDATE effects SET prompt_text = ? WHERE effect_id = ? AND prompt_text = ?', (s) => s.run(input.prompt, input.effectId, input.expectedPrompt));
      return true;
    });
  }
  reserveScheduledWake(input: { taskId: string; scheduleId: string; occurrenceId: string; effectId: string; prompt: string }): { effect: WorkflowSupervisorEffect; deduplicated: boolean } {
    const scheduleId = boundedText(input.scheduleId);
    const occurrenceId = boundedText(input.occurrenceId);
    if (!scheduleId || scheduleId.length > 512) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_ID_INVALID');
    if (!occurrenceId || occurrenceId.length > 512) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_OCCURRENCE_ID_INVALID');
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (task.continuationPolicy.kind !== 'forge_goal_outer_turn'
        || task.continuationPolicy.scheduled_wake_schedule_id !== scheduleId) {
        throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_BINDING_MISMATCH');
      }
      const originKey = `scheduled-wake:${scheduleId}:${occurrenceId}`;
      const priorRow = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(originKey)) as Record<string, unknown> | undefined;
      if (priorRow) {
        const prior = effectFromRow(priorRow);
        if (prior.taskId !== input.taskId || prior.effectId !== input.effectId || prior.kind !== 'continuation' || !prior.sourceCompletionFingerprint) {
          throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_IDENTITY_CONFLICT');
        }
        return { effect: prior, deduplicated: true };
      }
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      }
      if (oldestUnappliedEffect(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_CAUSAL_OBLIGATION_PENDING');
      // Reuse the single causal-obligation definition. A completed provider
      // recovery settles its failed parent; an in-flight recovery still blocks.
      if (appliedEffectAwaitingCompletionWithin(db, input.taskId)) {
        throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_CAUSAL_OBLIGATION_PENDING');
      }
      const latestRow = statement(db, "SELECT c.* FROM completions c WHERE c.task_id = ? ORDER BY COALESCE((SELECT MAX(completion_event.event_id) FROM events completion_event WHERE completion_event.task_id = c.task_id AND completion_event.completion_fingerprint = c.completion_fingerprint AND completion_event.kind = 'assistant_completion'), c.rowid) DESC LIMIT 1", (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!latestRow) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_NOT_WAITING');
      const completion = completionFromRow(latestRow);
      if (completion.action !== 'WAIT') throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_NOT_WAITING');
      const consumed = statement(db, 'SELECT * FROM effects WHERE task_id = ? AND source_completion_fingerprint = ?', (s) => s.get(input.taskId, completion.completionFingerprint)) as Record<string, unknown> | undefined;
      if (consumed) throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_ALREADY_CONSUMED');
      const effect = this.reserveEffectWithin(db, {
        taskId: input.taskId,
        effectId: input.effectId,
        kind: 'continuation',
        originKey,
        sourceCompletionFingerprint: completion.completionFingerprint,
        prompt: input.prompt,
      });
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,completion_fingerprint,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?)', (s) => s.run(
        input.taskId, `scheduled-wake-committed:${scheduleId}:${occurrenceId}`, 'scheduled_wake_reserved', effect.effectId,
        completion.completionFingerprint, json({ schedule_id: scheduleId, occurrence_id: occurrenceId, source_completion_fingerprint: completion.completionFingerprint }), now()));
      return { effect, deduplicated: false };
    });
  }
  /** One explicit operator-selected ChatGPT Project for an unbound standalone
   * bootstrap. This is task-local provenance, not a new Work/repository owner.
   * Never change a Project after a provider Send might have occurred. */
  bindBootstrapProject(input: { taskId: string; projectUrl: string; requestId: string; authorizedBy: string }): { projectUrl: string; deduplicated: boolean } {
    if (!input.requestId.trim() || !input.authorizedBy.trim()) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_AUTHORITY_REQUIRED');
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (task.continuationPolicy.kind !== 'standalone_supervisor'
        || task.conversationId !== `bootstrap:${task.taskId}`) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_NOT_PENDING');
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      const prior = statement(db, "SELECT payload_json FROM events WHERE task_id=? AND kind='bootstrap_project_bound' ORDER BY event_id LIMIT 1", (s) => s.get(input.taskId)) as { payload_json?: string } | undefined;
      if (prior) {
        if (parsedObject(prior.payload_json).project_url !== input.projectUrl) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_CONFLICT');
        return { projectUrl: input.projectUrl, deduplicated: true };
      }
      const pending = oldestUnappliedEffect(db, input.taskId);
      if (!pending || effectDispatchLedger(db, pending.effectId).generations !== 0
        || appliedEffectAwaitingCompletionWithin(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_OUTCOME_UNRESOLVED');
      statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
        input.taskId, `bootstrap-project-bound:${input.taskId}`, 'bootstrap_project_bound',
        json({ project_url: input.projectUrl, request_id: input.requestId, authorized_by: input.authorizedBy }), now()));
      return { projectUrl: input.projectUrl, deduplicated: false };
    });
  }
  boundBootstrapProjectUrl(taskId: string): string | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT payload_json FROM events WHERE task_id=? AND kind='bootstrap_project_bound' ORDER BY event_id LIMIT 1", (s) => s.get(taskId)) as { payload_json?: string } | undefined;
      return boundedText(parsedObject(row?.payload_json).project_url);
    });
  }
  bindBootstrapConversation(taskId: string, conversationId: string, conversationUrl: string): WorkflowSupervisorTask {
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (!task.conversationId.startsWith('bootstrap:')) {
        if (task.conversationId === conversationId && task.conversationUrl === conversationUrl) return task;
        throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_ALREADY_BOUND');
      }
      // The migration event ledger is the sole authority for previously used
      // source conversations. Do not rebind any retired source, including one
      // from an earlier 15-turn rotation (not only the immediately prior chat).
      const retired = statement(db, `SELECT 1 AS ok FROM events
        WHERE task_id=? AND kind='conversation_migrated'
          AND json_extract(payload_json,'$.from_conversation_id')=? LIMIT 1`,
        (s) => s.get(taskId, conversationId));
      if (retired) throw new Error('WORKFLOW_SUPERVISOR_FRESH_CONVERSATION_REBOUND_SOURCE');
      const conflict = statement(db, 'SELECT task_id FROM tasks WHERE conversation_id = ? AND task_id <> ?', (s) => s.get(conversationId, taskId)) as { task_id?: string } | undefined;
      if (conflict) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_CONVERSATION_CONFLICT');
      statement(db, 'UPDATE tasks SET conversation_id = ?, conversation_url = ? WHERE task_id = ?', (s) => s.run(conversationId, conversationUrl, taskId));
      const bound = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      if (!bound) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      return taskFromRow(bound);
    });
  }
  getTaskByConversationId(conversationId: string): WorkflowSupervisorTask | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM tasks WHERE conversation_id = ?', (s) => s.get(conversationId)); return row ? taskFromRow(row as Record<string, unknown>) : undefined; }); }
  listTasks(): WorkflowSupervisorTask[] { return this.read((db) => statement(db, 'SELECT * FROM tasks ORDER BY created_at, task_id', (s) => s.all()).map((row) => taskFromRow(row as Record<string, unknown>))); }
  listTasksWithoutCausalObligation(limit = 16): WorkflowSupervisorTask[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 128));
    return this.read((db) => statement(db, `SELECT t.* FROM tasks t
      WHERE NOT EXISTS (
        SELECT 1 FROM events terminal
        WHERE terminal.task_id = t.task_id
          AND terminal.kind IN ('terminal_done','terminal_needs_user','terminal_stopped')
      )
      AND NOT EXISTS (
        SELECT 1 FROM effects e
        WHERE e.task_id = t.task_id
          AND NOT EXISTS (
            SELECT 1 FROM events applied
            WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM effects e
        WHERE e.task_id = t.task_id
          AND EXISTS (
            SELECT 1 FROM events applied
            WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied'
          )
          AND NOT EXISTS (
            SELECT 1 FROM completions c
            WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id
          )
      )
      ORDER BY t.created_at, t.task_id
      LIMIT ?`, (s) => s.all(boundedLimit))
      .map((row) => taskFromRow(row as Record<string, unknown>)));
  }
  getEffect(effectId: string): WorkflowSupervisorEffect | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(effectId)); return row ? effectFromRow(row as Record<string, unknown>) : undefined; }); }
  currentUnappliedEffect(taskId: string): WorkflowSupervisorEffect | undefined { return this.read((db) => oldestUnappliedEffect(db, taskId)); }
  getEffectByOriginKey(originKey: string): WorkflowSupervisorEffect | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(originKey)); return row ? effectFromRow(row as Record<string, unknown>) : undefined; }); }
  getCompletion(completionFingerprint: string): WorkflowSupervisorCompletion | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM completions WHERE completion_fingerprint = ?', (s) => s.get(completionFingerprint)); return row ? completionFromRow(row as Record<string, unknown>) : undefined; }); }
  getCompletionBySourceEffectId(taskId: string, sourceEffectId: string): WorkflowSupervisorCompletion | undefined {
    return this.read((db) => {
      const row = statement(db, 'SELECT * FROM completions WHERE task_id = ? AND source_effect_id = ? LIMIT 1', (s) => s.get(taskId, sourceEffectId)) as Record<string, unknown> | undefined;
      return row ? completionFromRow(row) : undefined;
    });
  }
  listContinueCompletionsAwaitingSuccessor(limit = 16): WorkflowSupervisorCompletion[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 128));
    return this.read((db) => statement(db, `SELECT c.* FROM completions c
      WHERE c.action = 'CONTINUE'
        AND NOT EXISTS (SELECT 1 FROM effects successor WHERE successor.origin_key = 'completion:' || c.completion_fingerprint)
        AND NOT EXISTS (SELECT 1 FROM events terminal WHERE terminal.task_id = c.task_id AND terminal.kind IN ('terminal_done','terminal_needs_user','terminal_stopped'))
      ORDER BY COALESCE((SELECT MAX(completion_event.event_id) FROM events completion_event WHERE completion_event.task_id = c.task_id AND completion_event.completion_fingerprint = c.completion_fingerprint AND completion_event.kind = 'assistant_completion'), c.rowid) DESC LIMIT ?`, (s) => s.all(boundedLimit))
      .map((row) => completionFromRow(row as Record<string, unknown>)));
  }
  getCompletionByResponseSha256(taskId: string, responseSha256: string): WorkflowSupervisorCompletion | undefined {
    return this.read((db) => {
      const rows = statement(db, 'SELECT * FROM completions WHERE task_id = ? AND response_sha256 = ? ORDER BY committed_at, rowid LIMIT 2', (s) => s.all(taskId, responseSha256)) as Record<string, unknown>[];
      if (rows.length > 1) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_COMPLETION_AMBIGUOUS');
      return rows[0] ? completionFromRow(rows[0]) : undefined;
    });
  }
  /** Read-only completion evidence for the current logical conversation. */
  hasCompletionInCurrentConversation(taskId: string): boolean {
    return this.read((db) => Boolean(statement(db, `SELECT 1 FROM events completed
      WHERE completed.task_id=? AND completed.kind='assistant_completion'
        AND completed.event_id > COALESCE((
          SELECT MAX(migrated.event_id) FROM events migrated
          WHERE migrated.task_id=? AND migrated.kind='conversation_migrated'
        ), 0) LIMIT 1`, (q) => q.get(taskId, taskId))));
  }

  /** The only replay candidate when no applied effect is awaiting a receipt. */
  getLatestCompletion(taskId: string): WorkflowSupervisorCompletion | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT c.* FROM completions c WHERE c.task_id = ? ORDER BY COALESCE((SELECT MAX(completion_event.event_id) FROM events completion_event WHERE completion_event.task_id = c.task_id AND completion_event.completion_fingerprint = c.completion_fingerprint AND completion_event.kind = 'assistant_completion'), c.rowid) DESC LIMIT 1", (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      return row ? completionFromRow(row) : undefined;
    });
  }
  continuationProof(input: { repoId?: string; activeReleaseId: string; notBefore: string }): WorkflowSupervisorContinuationProof | undefined {
    const notBeforeMs = Date.parse(input.notBefore);
    if (!Number.isFinite(notBeforeMs)) throw new Error('WORKFLOW_SUPERVISOR_PROOF_BOUNDARY_INVALID');
    const activeReleaseId = boundedText(input.activeReleaseId);
    if (!activeReleaseId) throw new Error('WORKFLOW_SUPERVISOR_PROOF_RELEASE_REQUIRED');
    return this.read((db) => {
      const taskRows = statement(db, 'SELECT * FROM tasks ORDER BY created_at DESC, task_id DESC', (s) => s.all()) as Record<string, unknown>[];
      for (const taskRow of taskRows) {
        const task = taskFromRow(taskRow);
        const taskRepoId = boundedText(task.completionContract.repo_id) ?? boundedText(task.continuationPolicy.repo_id);
        if (input.repoId?.trim() && taskRepoId !== input.repoId.trim()) continue;
        const completionRows = statement(db, "SELECT c.* FROM completions c WHERE c.task_id = ? AND c.committed_at >= ? ORDER BY COALESCE((SELECT MAX(completion_event.event_id) FROM events completion_event WHERE completion_event.task_id = c.task_id AND completion_event.completion_fingerprint = c.completion_fingerprint AND completion_event.kind = 'assistant_completion'), c.rowid) ASC", (s) => s.all(task.taskId, input.notBefore)) as Record<string, unknown>[];
        const completions = completionRows.map(completionFromRow);
        // The bounded release canary task must prove C -> C -> accepted D.
        // Long-running production tasks may remain open; any disposable task can supply this proof.
        for (let index = 0; index + 2 < completions.length; index += 1) {
          if (index + 3 !== completions.length) continue;
          const first = completions[index]!;
          const second = completions[index + 1]!;
          const third = completions[index + 2]!;
          if (first.action !== 'CONTINUE' || second.action !== 'CONTINUE' || third.action !== 'DONE') continue;
          const rows = [first, second, third].map((completion) => statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(completion.sourceEffectId)) as Record<string, unknown> | undefined);
          if (rows.some((row) => !row)) continue;
          const [firstEffect, secondEffect, thirdEffect] = rows.map((row) => effectFromRow(row!)) as [WorkflowSupervisorEffect, WorkflowSupervisorEffect, WorkflowSupervisorEffect];
          if (
            [firstEffect, secondEffect, thirdEffect].some((effect) => effect.taskId !== task.taskId)
            || secondEffect.sourceCompletionFingerprint !== first.completionFingerprint
            || thirdEffect.sourceCompletionFingerprint !== second.completionFingerprint
          ) continue;
          const runtimeInstanceIds: string[] = [];
          let valid = true;
          let thirdCompletionEventId = 0;
          for (const [completionIndex, completion, effect] of [
            [0, first, firstEffect],
            [1, second, secondEffect],
            [2, third, thirdEffect],
          ] as const) {
            const dispatchRows = statement(db, "SELECT event_id,payload_json,occurred_at FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id", (s) => s.all(effect.effectId)) as Array<{ event_id?: number; payload_json?: string; occurred_at?: string }>;
            if (
              dispatchRows.length !== 1
              || !Number.isFinite(Date.parse(String(dispatchRows[0]?.occurred_at ?? '')))
              || Date.parse(String(dispatchRows[0]?.occurred_at ?? '')) < notBeforeMs
            ) { valid = false; break; }
            const dispatch = dispatchRows[0]!;
            const evidence = parsedObject(dispatch.payload_json);
            if (boundedText(evidence.active_release_id) !== activeReleaseId) { valid = false; break; }
            const runtimeInstanceId = boundedText(evidence.runtime_instance_id);
            if (!runtimeInstanceId) { valid = false; break; }
            runtimeInstanceIds.push(runtimeInstanceId);
            const appliedRows = statement(db, "SELECT event_id,occurred_at FROM events WHERE effect_id = ? AND kind = 'effect_applied' ORDER BY event_id", (s) => s.all(effect.effectId)) as Array<{ event_id?: number; occurred_at?: string }>;
            const applied = appliedRows.find((row) => {
              const occurredAtMs = Date.parse(String(row.occurred_at ?? ''));
              return Number(row.event_id ?? 0) > Number(dispatch.event_id ?? 0)
                && Number.isFinite(occurredAtMs)
                && occurredAtMs >= notBeforeMs;
            });
            if (!applied) { valid = false; break; }
            const completionEvents = statement(db, "SELECT event_id,occurred_at FROM events WHERE task_id = ? AND completion_fingerprint = ? AND kind = 'assistant_completion' ORDER BY event_id", (s) => s.all(task.taskId, completion.completionFingerprint)) as Array<{ event_id?: number; occurred_at?: string }>;
            if (
              completionEvents.length !== 1
              || !Number.isFinite(Date.parse(String(completionEvents[0]?.occurred_at ?? '')))
              || Date.parse(String(completionEvents[0]?.occurred_at ?? '')) < notBeforeMs
              || Number(completionEvents[0]?.event_id ?? 0) <= Number(applied.event_id ?? 0)
            ) { valid = false; break; }
            if (completionIndex === 2) thirdCompletionEventId = Number(completionEvents[0]?.event_id ?? 0);
          }
          const minimumRuntimeInstances = 2;
          if (!valid || new Set(runtimeInstanceIds).size < minimumRuntimeInstances) continue;
          const terminalRows = statement(db, "SELECT event_id,occurred_at FROM events WHERE task_id = ? AND completion_fingerprint = ? AND kind = 'terminal_done' ORDER BY event_id", (s) => s.all(task.taskId, third.completionFingerprint)) as Array<{ event_id?: number; occurred_at?: string }>;
          const latestTerminal = statement(db, "SELECT kind,completion_fingerprint FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') ORDER BY event_id DESC LIMIT 1", (s) => s.get(task.taskId)) as { kind?: string; completion_fingerprint?: string } | undefined;
          if (
            terminalRows.length !== 1
            || !Number.isFinite(Date.parse(String(terminalRows[0]?.occurred_at ?? '')))
            || Date.parse(String(terminalRows[0]?.occurred_at ?? '')) < notBeforeMs
            || Number(terminalRows[0]?.event_id ?? 0) <= thirdCompletionEventId
            || latestTerminal?.kind !== 'terminal_done'
            || latestTerminal.completion_fingerprint !== third.completionFingerprint
          ) continue;
          return {
            taskId: task.taskId, conversationId: task.conversationId, activeReleaseId,
            actions: ['CONTINUE', 'CONTINUE', 'DONE'],
            completionFingerprints: [first.completionFingerprint, second.completionFingerprint, third.completionFingerprint],
            sourceEffectIds: [first.sourceEffectId, second.sourceEffectId, third.sourceEffectId],
            runtimeInstanceIds: [...new Set(runtimeInstanceIds)],
            firstCommittedAt: first.committedAt, lastCommittedAt: third.committedAt,
          };
        }
      }
      return undefined;
    });
  }
  /**
   * Exact persisted pre-Send editor evidence. ProseMirror may introduce a
   * mid-body line break; only the observed prior exact digest grants recovery.
   */
  preSendComposerObservation(effectId: string): WorkflowSupervisorPreflightComposerObservation | undefined {
    return this.read((db) => {
      const sql = "SELECT e.payload_json FROM events e JOIN effects fx ON fx.effect_id = e.effect_id "
        + "WHERE e.effect_id = ? AND e.kind = 'effect_preflight_rejected' "
        + "AND e.event_id < (SELECT MIN(t.event_id) FROM events t WHERE t.task_id = fx.task_id AND t.kind = 'terminal_stopped') "
        + "ORDER BY e.event_id DESC LIMIT 1";
      const row = statement(db, sql, (query) => query.get(effectId)) as { payload_json?: string } | undefined;
      const data = parsedObject(row?.payload_json);
      const editor = parsedObject(data.composer_observation);
      if (data.send_clicked !== false || data.attestation !== 'computer_prepare_returned_before_supervisor_send_intent'
        || editor.classification !== 'current_effect' || editor.selectorVersion !== 'visible-single-v2'
        || !Number.isInteger(editor.chars) || Number(editor.chars) < 1
        || typeof editor.fingerprint !== 'string' || !/^[a-f0-9]{24}$/.test(editor.fingerprint)) return undefined;
      return { chars: Number(editor.chars), fingerprint: editor.fingerprint,
        classification: 'current_effect', selectorVersion: 'visible-single-v2' };
    });
  }

  latestEffectDispatch(effectId: string): { eventId: number; generation: number; evidence: Record<string, unknown> } | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number; payload_json?: string } | undefined;
      if (!row?.event_id) return undefined;
      return { eventId: Number(row.event_id), generation: storedGeneration(row.payload_json), evidence: parsedObject(row.payload_json) };
    });
  }
  /**
   * Select the one browser command for a task's oldest un-applied effect.
   *
   * A dispatch generation is only minted from the canonical negative proof that
   * the previous send never reached the conversation, and only while the effect
   * stays inside its mechanical retry budget and retry window. Mutation retries
   * retain a hard ceiling. Outcome-unknown reconciliation is read-only and stays
   * eligible forever at a capped cadence so late provider evidence can recover
   * the same effect without user intervention or another send.
   */
  nextBrowserEffect(
    taskId: string,
    options: { nowMs?: number } = {},
  ): { effect: WorkflowSupervisorEffect; mode: 'send' | 'reconcile'; generation: number } | undefined {
    return this.read((db) => {
      const effect = oldestUnappliedEffect(db, taskId);
      if (!effect) return undefined;
      const ledger = effectDispatchLedger(db, effect.effectId);
      const nowMs = options.nowMs ?? this.clockMs();
      if (ledger.generations === 0) {
        // Committed CONTINUE already has one unique causal successor.
        // Retry spacing and provider backpressure still guard failed sends.
        if (this.preflightBlocked(db, effect.effectId)) return undefined;
        return { effect, mode: 'send', generation: 1 };
      }
      const retryAuthorized = latestNotAppliedProofEventId(db, effect.effectId) > ledger.lastEventId;
      if (!retryAuthorized) {
        if (!unknownObservationDue(db, effect.effectId, ledger.lastEventId, nowMs)) return undefined;
        return { effect, mode: 'reconcile', generation: ledger.lastGeneration };
      }
      if (ledger.generations >= WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + ledger.budgetRefunds) return undefined;
      if (this.preflightBlocked(db, effect.effectId)) return undefined;
      if (nowMs - ledger.lastOccurredAtMs < workflowSupervisorDispatchRetryDelayMs(ledger.lastGeneration)) {
        return undefined;
      }
      return { effect, mode: 'send', generation: ledger.lastGeneration + 1 };
    });
  }
  effectDispatchBudget(effectId: string): WorkflowSupervisorEffectDispatchBudget {
    return this.read((db) => {
      const ledger = effectDispatchLedger(db, effectId);
      const exhausted = ledger.generations >= WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + ledger.budgetRefunds
        && !statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      return {
        effectId,
        generations: ledger.generations,
        maxGenerations: WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS,
        ...(ledger.lastOccurredAtMs ? { lastDispatchedAtMs: ledger.lastOccurredAtMs } : {}),
        ...(ledger.generations ? { retryDelayMs: workflowSupervisorDispatchRetryDelayMs(ledger.lastGeneration) } : {}),
        exhausted,
      };
    });
  }
  /**
   * Read-only classification of why a non-terminal task is or is not advancing.
   * It derives only from the existing effect/observation ledger, so it adds no
   * second durable state and no new lifecycle authority.
   */
  taskStall(taskId: string): WorkflowSupervisorTaskStall {
    if (this.terminalAction(taskId)) return { state: 'terminal' };
    const next = this.nextBrowserEffect(taskId);
    if (next) {
      if (next.mode === 'send') return { state: 'deliverable', effectId: next.effect.effectId, mode: 'send', generation: next.generation };
      return { state: 'spaced', effectId: next.effect.effectId, reason: 'unknown_observation_spacing' };
    }
    const pending = this.currentUnappliedEffect(taskId);
    if (pending) {
      const ledger = this.read((db) => ({ ...effectDispatchLedger(db, pending.effectId), proof: latestNotAppliedProofEventId(db, pending.effectId), preflightBlocked: this.preflightBlocked(db, pending.effectId) }));
      if (ledger.preflightBlocked) {
        const failure = this.read((db) => statement(db,
          "SELECT payload_json FROM events WHERE effect_id = ? AND kind = 'effect_preflight_rejected' ORDER BY event_id DESC LIMIT 1",
          (s) => s.get(pending.effectId)) as { payload_json?: string } | undefined);
        const record = parsedObject(failure?.payload_json);
        const reasonCode = boundedText(record.reason)?.slice(0, 256);
        const diagnostic = record.composer_observation;
        const preflightComposerObservation = diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)
          ? diagnostic as WorkflowSupervisorPreflightComposerObservation : undefined;
        return { state: 'spaced', effectId: pending.effectId, reason: 'pre_send_infrastructure_blocked',
          ...(reasonCode ? { preflightReasonCode: reasonCode } : {}),
          ...(preflightComposerObservation ? { preflightComposerObservation } : {}) };
      }
      const ceiling = WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + ledger.budgetRefunds;
      const retryAuthorized = ledger.generations === 0 || ledger.proof > ledger.lastEventId;
      // An exhausted retry ceiling is the operator-facing state: no amount of
      // waiting can mint another generation. Everything else is ordinary
      // mechanical spacing and needs no operator action.
      if (retryAuthorized && ledger.generations >= ceiling) {
        return { state: 'retryable', effectId: pending.effectId, generations: ledger.generations, maxGenerations: ceiling };
      }
      return { state: 'spaced', effectId: pending.effectId, reason: retryAuthorized ? 'retry_spacing' : 'unknown_observation_spacing' };
    }
    const leaf = this.latestAppliedLeafEffectWithoutCompletion(taskId);
    if (leaf && this.providerResumeExhausted(leaf.effectId)) {
      const silentTurn = this.providerSilence(leaf.effectId);
      return { state: 'provider_resume_exhausted', effectId: leaf.effectId, ...(silentTurn ? { silentTurn } : {}) };
    }
    // An applied effect awaiting its receipt is a live obligation even when its
    // bounded resume is exhausted and its recovery child was retired, so it is
    // never reported as inert. Silence is reported as elapsed without claiming
    // that the provider is producing usable output.
    if (this.hasAppliedEffectAwaitingCompletion(taskId)) {
      const silentTurn = leaf ? this.providerSilence(leaf.effectId) : undefined;
      return { state: 'spaced', ...(leaf ? { effectId: leaf.effectId } : {}), reason: 'awaiting_completion_receipt', ...(silentTurn ? { silentTurn } : {}) };
    }
    const waiting = this.read((db) => {
      const taskRow = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      if (!taskRow) return undefined;
      const task = taskFromRow(taskRow);
      const scheduleId = boundedText(task.continuationPolicy.scheduled_wake_schedule_id);
      if (!scheduleId) return undefined;
      const latest = statement(db, "SELECT c.completion_fingerprint, c.action FROM completions c WHERE c.task_id = ? ORDER BY COALESCE((SELECT MAX(completion_event.event_id) FROM events completion_event WHERE completion_event.task_id = c.task_id AND completion_event.completion_fingerprint = c.completion_fingerprint AND completion_event.kind = 'assistant_completion'), c.rowid) DESC LIMIT 1", (s) => s.get(taskId)) as { completion_fingerprint?: string; action?: string } | undefined;
      return latest?.action === 'WAIT' && latest.completion_fingerprint
        ? { state: 'waiting' as const, scheduleId, completionFingerprint: latest.completion_fingerprint }
        : undefined;
    });
    if (waiting) return waiting;
    return { state: 'inert' };
  }
  /** Journal one attempted task-local Computer operation, never a guessed Send. */
  recordBrowserDeliveryAttemptFailure(input: { taskId: string; conversationId: string; code: string; effectId?: string; verifiedEmptyShell?: boolean }): void {
    this.transaction((db) => {
      const task = statement(db, 'SELECT conversation_id FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as { conversation_id?: string } | undefined;
      // An old tab or pre-migration provider result cannot charge the new chat.
      if (!task || task.conversation_id !== input.conversationId) return;
      const code = input.code.slice(0, 128);
      const effectId = input.effectId ?? null;
      const verifiedEmptyShell = code === 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' && input.verifiedEmptyShell === true;
      // Keep at most three unchanged diagnostic observations, then require a
      // different cause/effect or real progress before journaling more. Failure
      // counts never authorize a Send, recovery or conversation migration.
      const progress = statement(db, `SELECT COALESCE(MAX(event_id), 0) AS event_id
        FROM events WHERE task_id = ? AND kind IN (
          'effect_dispatch_started', 'effect_applied', 'assistant_completion', 'conversation_migrated'
        )`, (s) => s.get(input.taskId)) as { event_id: number };
      const recent = statement(db, `SELECT effect_id, payload_json FROM events
        WHERE task_id = ? AND kind = 'browser_delivery_attempt_failed' AND event_id > ?
        ORDER BY event_id DESC LIMIT 3`, (s) => s.all(input.taskId, progress.event_id)) as Array<{
          effect_id: string | null; payload_json: string;
        }>;
      if (recent.length === 3 && recent.every((entry) => {
        const payload = JSON.parse(entry.payload_json) as { conversation_id?: string; code?: string; verified_empty_shell?: boolean };
        return entry.effect_id === effectId
          && payload.conversation_id === input.conversationId && payload.code === code
          && payload.verified_empty_shell === verifiedEmptyShell;
      })) return;
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        input.taskId, `browser-delivery-failed:${input.taskId}:${randomUUID()}`,
        'browser_delivery_attempt_failed', effectId,
        json({ conversation_id: input.conversationId, code, phase: 'task_local_pre_mutation', verified_empty_shell: verifiedEmptyShell }), now(),
      ));
    });
  }

  /** One operator-approved re-observation per active release for a proven pre-send failure; never a provider retry refund. */
  authorizeOperatorPreflightRetry(input: { effectId: string; requestId: string; reason: string; authorizedBy: string }): { deduplicated: boolean } {
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(input.effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      if (statement(db, "SELECT 1 FROM events WHERE effect_id = ? AND kind IN ('effect_applied','effect_outcome_unknown_superseded') LIMIT 1", (s) => s.get(input.effectId))) {
        throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_EFFECT_TERMINAL');
      }
      if (effectDispatchLedger(db, input.effectId).generations !== 0) throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_RECOVERY_SEND_ALREADY_RECORDED');
      const key = `effect-preflight-operator-rearmed:${input.effectId}:${input.requestId}`;
      if (statement(db, 'SELECT 1 FROM events WHERE event_key = ?', (s) => s.get(key))) return { deduplicated: true };
      const failed = effectPreflightFailureReleaseIds(db, input.effectId);
      const releaseId = this.activeReleaseId()?.trim() || 'unidentified-runtime';
      // One explicit no-Send re-observation is allowed per immutable active
      // release. A later release may recover the same effect, but returning to
      // a release already rearmed remains exhausted; no failure or Send budget
      // is erased. The existing preflightBlocked predicate still must be true.
      const rearmedReleases = statement(db, "SELECT payload_json FROM events WHERE effect_id = ? AND kind = 'effect_preflight_operator_rearmed' ORDER BY event_id", (s) => s.all(input.effectId)) as Array<{ payload_json?: string }>;
      if (rearmedReleases.some((entry) => String(parsedObject(entry.payload_json).active_release_id ?? 'unidentified-runtime') === releaseId)) {
        throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_OPERATOR_REARM_EXHAUSTED');
      }
      if (!this.preflightBlocked(db, input.effectId)
        || (failed.length < WORKFLOW_SUPERVISOR_MAX_PREFLIGHT_RELEASE_ATTEMPTS
          && !failed.some((entry) => entry.releaseId === releaseId))) {
        throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_RECOVERY_NOT_BLOCKED');
      }
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        effect.task_id!, key, 'effect_preflight_operator_rearmed', input.effectId,
        json({ request_id: input.requestId, authorized_by: input.authorizedBy, reason: boundedText(input.reason)?.slice(0, 512), active_release_id: releaseId, attestation: 'operator_authorized_after_proven_no_send' }), now(),
      ));
      return { deduplicated: false };
    });
  }

  /**
   * Explicit operator authority to continue a mechanically proven un-applied
   * send after its retry ceiling, without replaying an outcome-unknown mutation.
   * This refund path is distinct from zero-generation UI preparation repair.
   */
  authorizeOperatorRetry(input: { effectId: string; requestId: string; reason: string; authorizedBy: string }): { refunds: number; generations: number; deduplicated: boolean } {
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(input.effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      if (statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(input.effectId))) {
        throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      }
      if (statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_outcome_unknown_superseded' LIMIT 1", (s) => s.get(input.effectId))) {
        throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_EFFECT_SUPERSEDED');
      }
      const ledger = effectDispatchLedger(db, input.effectId);
      if (ledger.generations === 0 || latestNotAppliedProofEventId(db, input.effectId) <= ledger.lastEventId) {
        throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
      }
      const key = `effect-dispatch-operator-refund:${input.effectId}:${input.requestId}`;
      const existing = statement(db, 'SELECT 1 AS ok FROM events WHERE event_key = ?', (s) => s.get(key));
      if (existing) return { refunds: operatorAuthorizedRefundCount(db, input.effectId), generations: ledger.generations, deduplicated: true };
      if (operatorAuthorizedRefundCount(db, input.effectId) >= WORKFLOW_SUPERVISOR_MAX_OPERATOR_REFUNDS) {
        throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_REFUND_BUDGET_EXHAUSTED');
      }
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        effect.task_id!, key, 'effect_dispatch_budget_refunded', input.effectId,
        json({
          reason: 'operator_authorized_retry', request_id: input.requestId, authorized_by: input.authorizedBy,
          reason_text: input.reason, prior_generations: ledger.generations, attestation: 'mechanical_pre_send_negative_proof',
        }), now()));
      return { refunds: operatorAuthorizedRefundCount(db, input.effectId), generations: ledger.generations, deduplicated: false };
    });
  }
  /**
   * Explicit operator authority to retire an effect whose submission outcome is
   * genuinely unknown. It is never resent; the durable fact records who decided
   * to stop waiting, and the replacement turn is reserved in the same
   * transaction so the task can never sit in a half-superseded state. Requires
   * the caller to have stated the intent.
   */
  supersedeUnknownEffect(input: {
    effectId: string;
    requestId: string;
    reason: string;
    authorizedBy: string;
    replacement: { effectId: string; prompt: string };
  }): { superseded: boolean; recoveryEffect: WorkflowSupervisorEffect } {
    const originKey = `operator-recovery:${input.effectId}:${input.requestId}`;
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(input.effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const taskId = effect.task_id;
      const reserve = (): WorkflowSupervisorEffect => this.reserveEffectWithin(db, {
        taskId, effectId: input.replacement.effectId, kind: 'recovery', originKey, prompt: input.replacement.prompt,
      });
      const existingReplacement = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(originKey)) as Record<string, unknown> | undefined;
      if (existingReplacement) return { superseded: true, recoveryEffect: effectFromRow(existingReplacement) };
      if (statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(input.effectId))) {
        throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      }
      const ledger = effectDispatchLedger(db, input.effectId);
      if (ledger.generations === 0) throw new Error('WORKFLOW_SUPERVISOR_SUPERSEDE_NOT_DISPATCHED');
      if (latestNotAppliedProofEventId(db, input.effectId) > ledger.lastEventId) {
        throw new Error('WORKFLOW_SUPERVISOR_SUPERSEDE_NOT_APPLIED_PROVEN');
      }
      const key = `effect-outcome-unknown-superseded:${input.effectId}:${input.requestId}`;
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        taskId, key, 'effect_outcome_unknown_superseded', input.effectId,
        json({
          request_id: input.requestId, authorized_by: input.authorizedBy, reason: input.reason,
          generation: ledger.lastGeneration, replacement_effect_id: input.replacement.effectId,
          attestation: 'explicit_operator_authorization',
        }), now()));
      return { superseded: true, recoveryEffect: reserve() };
    });
  }
  terminalAction(taskId: string): WorkflowSupervisorTerminalState | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT kind FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') ORDER BY event_id DESC LIMIT 1", (s) => s.get(taskId)) as { kind?: string } | undefined;
      return row?.kind === 'terminal_done' ? 'DONE' : row?.kind === 'terminal_needs_user' ? 'NEEDS_USER' : row?.kind === 'terminal_stopped' ? 'STOPPED' : undefined;
    });
  }
  stopTask(taskId: string, reason: string): { taskId: string; terminal: 'STOPPED'; deduplicated: boolean } {
    return this.transaction((db) => {
      const task = statement(db, 'SELECT task_id FROM tasks WHERE task_id = ?', (s) => s.get(taskId)) as { task_id?: string } | undefined;
      if (!task) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const existing = statement(db, "SELECT kind FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') ORDER BY event_id DESC LIMIT 1", (s) => s.get(taskId)) as { kind?: string } | undefined;
      if (existing?.kind === 'terminal_stopped') return { taskId, terminal: 'STOPPED', deduplicated: true };
      if (existing?.kind) {
        const terminal = existing.kind === 'terminal_done' ? 'DONE' : 'NEEDS_USER';
        throw new Error(`WORKFLOW_SUPERVISOR_TASK_TERMINAL:${terminal}`);
      }
      statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(taskId, `task-stop:${taskId}`, 'terminal_stopped', json({ reason }), now()));
      return { taskId, terminal: 'STOPPED', deduplicated: false };
    });
  }
  effectApplied(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId)))); }
  bootstrapAppliedReconcileDue(effectId: string): boolean {
    return this.read((db) => {
      const dispatch = effectDispatchLedger(db, effectId);
      return dispatch.generations > 0 && unknownObservationDue(db, effectId, dispatch.lastEventId, this.clockMs());
    });
  }
  providerResumeExhausted(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'assistant_recovery_exhausted' LIMIT 1", (s) => s.get(effectId)))); }
  /**
   * Read-only elapsed silence for one applied effect, derived from the exact
   * provider-state event the observation loop already journals. It adds no
   * durable state, no second threshold and no resend authorization: it only
   * stops the caller from reporting "still running" as if output were arriving.
   */
  providerSilence(effectId: string, nowMs = this.clockMs()): WorkflowSupervisorSilentTurn | undefined {
    return this.read((db) => {
      const latest = statement(db, `SELECT kind, occurred_at FROM events
        WHERE effect_id = ? AND kind IN ('assistant_provider_generating','assistant_provider_idle')
        ORDER BY event_id DESC LIMIT 1`, (s) => s.get(effectId)) as { kind?: string; occurred_at?: string } | undefined;
      if (!latest || (latest.kind !== 'assistant_provider_generating' && latest.kind !== 'assistant_provider_idle')) return undefined;
      const observedSinceMs = Date.parse(String(latest.occurred_at ?? ''));
      if (!Number.isFinite(observedSinceMs)) return undefined;
      return {
        effectId,
        providerState: latest.kind === 'assistant_provider_generating' ? 'generating' : 'idle',
        observedSince: new Date(observedSinceMs).toISOString(),
        elapsedMs: Math.max(0, nowMs - observedSinceMs),
        recoveryGraceMs: WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS,
        recoveryReviewAt: new Date(observedSinceMs + WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS).toISOString(),
        progress: 'no_visible_output',
        resendAuthorized: false,
      };
    });
  }
  latestAppliedEffectWithoutCompletion(taskId: string): WorkflowSupervisorEffect | undefined {
    return this.read((db) => {
      const row = statement(db, `SELECT e.* FROM effects e
        WHERE e.task_id = ?
          AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied')
          AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id)
          AND NOT EXISTS (SELECT 1 FROM effects child WHERE child.origin_key = 'provider-recovery:' || e.effect_id)
          AND NOT EXISTS (SELECT 1 FROM events exhausted WHERE exhausted.effect_id = e.effect_id AND exhausted.kind = 'assistant_recovery_exhausted')
        ORDER BY (SELECT MAX(event_id) FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied') DESC
        LIMIT 1`, (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      return row ? effectFromRow(row) : undefined;
    });
  }
  latestAppliedLeafEffectWithoutCompletion(taskId: string): WorkflowSupervisorEffect | undefined {
    return this.read((db) => {
      const row = statement(db, `SELECT e.* FROM effects e
        WHERE e.task_id = ?
          AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied')
          AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id)
          AND NOT EXISTS (SELECT 1 FROM effects child
            WHERE child.origin_key = 'provider-recovery:' || e.effect_id
              AND EXISTS (SELECT 1 FROM events started
                WHERE started.effect_id = child.effect_id AND started.kind = 'effect_dispatch_started'))
        ORDER BY (SELECT MAX(event_id) FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied') DESC
        LIMIT 1`, (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      return row ? effectFromRow(row) : undefined;
    });
  }

  /**
   * An applied browser effect remains a Supervisor-owned external observation
   * obligation even when its lower ControllerRound temporarily waits. This
   * intentionally includes effects that already have a bounded provider
   * recovery child; the native adapter must stay alive long enough to observe
   * and dispatch that recovery instead of abandoning the browser task.
   */
  hasAppliedEffectAwaitingCompletion(taskId: string): boolean {
    return this.read((db) => appliedEffectAwaitingCompletionWithin(db, taskId));
  }

  observeProviderTurn(input: {
    taskId: string;
    effectId: string;
    generating: boolean;
    assistantDigest: string;
    providerFailureCode?: string;
    receiptMissing?: boolean;
    observedAtMs: number;
    graceMs: number;
    recovery: { effectId: string; prompt: string };
  }): { state: 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    if (!Number.isFinite(input.observedAtMs)) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_OBSERVED_AT_INVALID');
    const graceMs = Math.max(1_000, Math.min(WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS, Math.floor(input.graceMs)));
    const digest = input.assistantDigest.trim().slice(0, 128);
    const observedAt = new Date(input.observedAtMs).toISOString();
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(input.effectId)) as Record<string, unknown> | undefined;
      if (!row) return { state: 'none' };
      const effect = effectFromRow(row);
      if (effect.taskId !== input.taskId) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_EFFECT_TASK_MISMATCH');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effect.effectId));
      const completed = statement(db, 'SELECT 1 AS ok FROM completions WHERE task_id = ? AND source_effect_id = ? LIMIT 1', (s) => s.get(input.taskId, effect.effectId));
      if (!applied || completed) return { state: 'none' };
      const providerRecoveryDepth = providerRecoveryDepthWithin(db, effect.effectId);
      const recoveryOrigin = `provider-recovery:${effect.effectId}`;
      const providerFailureCode = input.providerFailureCode?.trim().slice(0, 128);
      if (providerFailureCode) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
          input.taskId,
          `assistant-provider-failed:${effect.effectId}:${providerFailureCode}`,
          'assistant_provider_failed',
          effect.effectId,
          json({ code: providerFailureCode, assistant_digest: digest }),
          observedAt,
        ));
      }
      const existingRecovery = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(recoveryOrigin)) as Record<string, unknown> | undefined;
      if (existingRecovery) return { state: 'recovery_reserved', recoveryEffect: effectFromRow(existingRecovery) };
      if (providerFailureCode) {
        if (providerRecoveryDepth >= WORKFLOW_SUPERVISOR_MAX_PROVIDER_RECOVERY_TURNS) {
          statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-exhausted:${effect.effectId}`, 'assistant_recovery_exhausted', effect.effectId, json({ assistant_digest: digest, provider_failure_code: providerFailureCode, exactly_once_resume: true, recovery_depth: providerRecoveryDepth, max_recovery_turns: WORKFLOW_SUPERVISOR_MAX_PROVIDER_RECOVERY_TURNS }), observedAt));
          return { state: 'exhausted' };
        }
        const recoveryEffect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.recovery.effectId, kind: 'recovery', originKey: recoveryOrigin, prompt: input.recovery.prompt });
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-reserved:${effect.effectId}`, 'assistant_recovery_reserved', effect.effectId, json({ recovery_effect_id: recoveryEffect.effectId, provider_failure_code: providerFailureCode, exactly_once_resume: true }), observedAt));
        return { state: 'recovery_reserved', recoveryEffect };
      }

      const latest = statement(db, `SELECT event_id,kind,payload_json,occurred_at FROM events
        WHERE effect_id = ? AND kind IN ('assistant_provider_generating','assistant_provider_idle')
        ORDER BY event_id DESC LIMIT 1`, (s) => s.get(effect.effectId)) as { event_id?: number; kind?: string; payload_json?: string; occurred_at?: string } | undefined;
      const latestEvidence = parsedObject(latest?.payload_json);
      const desiredKind = input.generating ? 'assistant_provider_generating' : 'assistant_provider_idle';
      const sameState = latest?.kind === desiredKind && latestEvidence.assistant_digest === digest;
      if (!sameState) {
        const eventKey = `assistant-provider-state:${effect.effectId}:${desiredKind}:${Number(latest?.event_id ?? 0) + 1}:${digest || 'empty'}`;
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, eventKey, desiredKind, effect.effectId, json({ assistant_digest: digest }), observedAt));
        return { state: input.generating ? 'generating' : 'idle_pending' };
      }
      const unchangedSinceMs = Date.parse(String(latest?.occurred_at ?? ''));
      if (!Number.isFinite(unchangedSinceMs) || input.observedAtMs - unchangedSinceMs < graceMs) {
        return { state: input.generating ? 'generating' : 'idle_pending' };
      }

      // An unchanged response may be legitimate long-running reasoning or a
      // pending tool call. Text silence is not proof an active turn is stuck:
      // reserving a second Send races the original turn's late valid receipt.
      // Only an explicit provider failure (handled above) can recover while
      // the provider still advertises an active generation.
      if (input.generating) return { state: 'generating' };

      // For an idle turn require a stable, completed response that is proven
      // to be missing its causal receipt. Ordinary idle text is insufficient.
      if (!input.receiptMissing) return { state: 'idle_pending' };

      // Bound the recovery chain to the original two-resume safety limit; the
      // source effect's eventual legitimate completion remains authoritative.
      if (providerRecoveryDepth >= WORKFLOW_SUPERVISOR_MAX_PROVIDER_RECOVERY_TURNS) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-exhausted:${effect.effectId}`, 'assistant_recovery_exhausted', effect.effectId, json({ assistant_digest: digest, exactly_once_resume: true, stale_generation: input.generating, recovery_depth: providerRecoveryDepth, max_recovery_turns: WORKFLOW_SUPERVISOR_MAX_PROVIDER_RECOVERY_TURNS }), observedAt));
        return { state: 'exhausted' };
      }
      const recoveryEffect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.recovery.effectId, kind: 'recovery', originKey: recoveryOrigin, prompt: input.recovery.prompt });
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-reserved:${effect.effectId}`, 'assistant_recovery_reserved', effect.effectId, json({ recovery_effect_id: recoveryEffect.effectId, exactly_once_resume: true, stale_generation: input.generating }), observedAt));
      return { state: 'recovery_reserved', recoveryEffect };
    });
  }

  reserveEffect(input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    return this.transaction((db) => this.reserveEffectWithin(db, input));
  }
  reserveOperatorRecovery(input: { taskId: string; sourceEffectId: string; requestId: string; reason: string; effectId: string; prompt: string }): WorkflowSupervisorEffect {
    return this.transaction((db) => {
      if (oldestUnappliedEffect(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
      const source = statement(db, `SELECT e.* FROM effects e WHERE e.task_id = ?
        AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id=e.effect_id AND applied.kind='effect_applied')
        AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.source_effect_id=e.effect_id)
        AND NOT EXISTS (SELECT 1 FROM effects child WHERE child.origin_key='provider-recovery:' || e.effect_id)
        ORDER BY e.created_at DESC LIMIT 1`, (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (source?.effect_id !== input.sourceEffectId) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_SOURCE_CHANGED');
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      const effect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.effectId, kind: 'recovery', originKey: `provider-recovery:${input.sourceEffectId}`, prompt: input.prompt });
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        input.taskId, `assistant-recovery-reserved:${input.sourceEffectId}`, 'assistant_recovery_reserved', input.sourceEffectId,
        json({ recovery_effect_id: effect.effectId, requested_by: 'user', request_id: input.requestId, reason: input.reason, exactly_once_resume: true }), now()));
      return effect;
    });
  }
  /**
   * Explicit operator recovery for an applied effect whose one bounded provider
   * resume was already exhausted. The source effect stays applied and completed
   * history is untouched; this only reserves one new, separately identified
   * provider turn, so it can never replay the source mutation.
   */
  reserveOperatorProviderRecovery(input: { taskId: string; sourceEffectId: string; requestId: string; reason: string; authorizedBy: string; originKey: string; effectId: string; prompt: string }): WorkflowSupervisorEffect {
    return this.transaction((db) => {
      if (oldestUnappliedEffect(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      }
      const source = statement(db, `SELECT e.* FROM effects e WHERE e.task_id = ? AND e.effect_id = ?
        AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id=e.effect_id AND applied.kind='effect_applied')
        AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.source_effect_id=e.effect_id)
        LIMIT 1`, (s) => s.get(input.taskId, input.sourceEffectId)) as Record<string, unknown> | undefined;
      if (!source) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_SOURCE_CHANGED');
      // This class exists precisely because the bounded automatic resume ran
      // out. Without that durable fact there is no authorization here.
      if (!providerResumeExhaustedWithin(db, input.sourceEffectId)) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_NOT_EXHAUSTED');
      const originKey = input.originKey;
      const effect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.effectId, kind: 'recovery', originKey, prompt: input.prompt });
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        input.taskId, `assistant-recovery-reserved:${originKey}`, 'assistant_recovery_reserved', input.sourceEffectId,
        json({
          recovery_effect_id: effect.effectId, requested_by: 'user', authorized_by: input.authorizedBy,
          request_id: input.requestId, reason: input.reason, exactly_once_resume: true, operator_authorized: true,
        }), now()));
      return effect;
    });
  }
  freshConversationMigrationContext(taskId: string): { fromConversationId: string; requestId: string } | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT payload_json FROM events WHERE task_id = ? AND kind = 'conversation_migrated' ORDER BY event_id DESC LIMIT 1", (s) => s.get(taskId)) as { payload_json?: string } | undefined;
      const payload = parsedObject(row?.payload_json);
      if (payload.fresh_conversation !== true || payload.to_conversation_id !== `bootstrap:${taskId}`) return undefined;
      const fromConversationId = typeof payload.from_conversation_id === 'string' ? payload.from_conversation_id.trim() : '';
      const requestId = typeof payload.request_id === 'string' ? payload.request_id.trim() : '';
      if (!fromConversationId || !requestId) return undefined;
      return { fromConversationId, requestId };
    });
  }

  /**
   * Explicit operator switch of an exhausted task to a *fresh* conversation in
   * its configured Project. This is the one path that legitimately opens a new
   * chat: it exists for an exact conversation that is durably unusable, never as
   * a reaction to provider backpressure. The whole move and its replacement
   * enrollment turn commit in one transaction, so the task can never be left on
   * a fresh conversation holding a prompt that assumes prior context.
   */
  migrateToFreshConversation(input: {
    taskId: string;
    expectedConversationId: string;
    requestId: string;
    reason: string;
    authorizedBy: string;
    replacement: { effectId: string; prompt: string };
  }): { task: WorkflowSupervisorTask; migrated: boolean; retiredEffectId?: string } {
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (task.conversationId !== input.expectedConversationId) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_STALE');
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      }
      const targetConversationId = `bootstrap:${input.taskId}`;
      if (task.conversationId === targetConversationId) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_ALREADY_PENDING');
      // Bound repeated unsuccessful moves, not the lifetime of a healthy task.
      // A genuine completion reopens the budget for its next 15-turn rotation.
      const prior = statement(db, `SELECT COUNT(*) AS total FROM events
        WHERE task_id = ? AND kind = 'conversation_migrated'
          AND event_id > COALESCE(
            (SELECT MAX(event_id) FROM events WHERE task_id = ? AND kind = 'assistant_completion'), 0
          )`, (s) => s.get(input.taskId, input.taskId)) as { total?: number } | undefined;
      if (Number(prior?.total ?? 0) >= WORKFLOW_SUPERVISOR_MAX_CONVERSATION_MIGRATIONS) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_BUDGET_EXHAUSTED');
      // A known-applied turn without its completion is still an active effect;
      // a provider capacity banner cannot retire its observation obligation.
      if (appliedEffectAwaitingCompletionWithin(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_APPLIED_TURN_UNRESOLVED');
      // A submitted mutation whose outcome is unknown must be reconciled, never
      // abandoned by moving the task elsewhere.
      const pending = oldestUnappliedEffect(db, input.taskId);
      if (pending) {
        const ledger = effectDispatchLedger(db, pending.effectId);
        const negativeProof = latestNotAppliedProofEventId(db, pending.effectId) > ledger.lastEventId;
        if (ledger.generations > 0 && !negativeProof) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_OUTCOME_UNKNOWN');
      }
      const originKey = `fresh-conversation:${input.taskId}:${input.requestId}`;
      const replacement = this.reserveEffectWithin(db, {
        taskId: input.taskId, effectId: input.replacement.effectId, kind: 'enrollment', originKey, prompt: input.replacement.prompt,
      });
      if (pending && pending.effectId !== replacement.effectId) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
          input.taskId, `effect-retired-fresh-conversation:${pending.effectId}:${input.requestId}`, 'effect_outcome_unknown_superseded',
          pending.effectId,
          json({
            request_id: input.requestId, authorized_by: input.authorizedBy, reason: input.reason,
            generation: 0, replacement_effect_id: replacement.effectId, attestation: 'never_dispatched_fresh_conversation',
          }), now()));
      }
      statement(db, 'UPDATE tasks SET conversation_id = ?, conversation_url = ? WHERE task_id = ?', (s) => s.run(targetConversationId, 'https://chatgpt.com/', input.taskId));
      statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
        input.taskId, `conversation-migrated:${input.taskId}:${input.requestId}`, 'conversation_migrated',
        json({
          from_conversation_id: task.conversationId, to_conversation_id: targetConversationId, to_conversation_url: 'https://chatgpt.com/',
          fresh_conversation: true, replacement_effect_id: replacement.effectId,
          request_id: input.requestId, authorized_by: input.authorizedBy, reason: input.reason,
          ...(pending ? { retired_effect_id: pending.effectId } : {}),
        }), now()));
      const updated = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!updated) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      return {
        task: taskFromRow(updated), migrated: true,
        ...(pending && pending.effectId !== replacement.effectId ? { retiredEffectId: pending.effectId } : {}),
      };
    });
  }

  migrateConversation(input: { taskId: string; expectedConversationId: string; conversationId: string; conversationUrl: string; requestId: string; reason: string; authorizedBy: string }): { task: WorkflowSupervisorTask; migrated: boolean } {
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (task.conversationId !== input.expectedConversationId) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_STALE');
      if (statement(db, "SELECT 1 FROM events WHERE task_id=? AND kind IN ('terminal_done','terminal_needs_user','terminal_stopped') LIMIT 1", (s) => s.get(input.taskId))) {
        throw new Error('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
      }
      if (task.conversationId === input.conversationId) {
        if (task.conversationUrl !== input.conversationUrl) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_CONVERSATION_CONFLICT');
        return { task, migrated: false };
      }
      const conflict = statement(db, 'SELECT task_id FROM tasks WHERE conversation_id = ? AND task_id <> ?', (s) => s.get(input.conversationId, input.taskId)) as { task_id?: string } | undefined;
      if (conflict) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_CONVERSATION_CONFLICT');
      // Bound repeated unsuccessful moves, not the lifetime of a healthy task.
      // A genuine completion reopens the budget for its next 15-turn rotation.
      const prior = statement(db, `SELECT COUNT(*) AS total FROM events
        WHERE task_id = ? AND kind = 'conversation_migrated'
          AND event_id > COALESCE(
            (SELECT MAX(event_id) FROM events WHERE task_id = ? AND kind = 'assistant_completion'), 0
          )`, (s) => s.get(input.taskId, input.taskId)) as { total?: number } | undefined;
      if (Number(prior?.total ?? 0) >= WORKFLOW_SUPERVISOR_MAX_CONVERSATION_MIGRATIONS) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_BUDGET_EXHAUSTED');
      if (appliedEffectAwaitingCompletionWithin(db, input.taskId)) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_APPLIED_TURN_UNRESOLVED');
      const pending = oldestUnappliedEffect(db, input.taskId);
      if (pending) {
        const ledger = effectDispatchLedger(db, pending.effectId);
        const negativeProof = latestNotAppliedProofEventId(db, pending.effectId) > ledger.lastEventId;
        if (ledger.generations > 0 && !negativeProof) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_OUTCOME_UNKNOWN');
      }
      statement(db, 'UPDATE tasks SET conversation_id = ?, conversation_url = ? WHERE task_id = ?', (s) => s.run(input.conversationId, input.conversationUrl, input.taskId));
      statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
        input.taskId, `conversation-migrated:${input.taskId}:${input.requestId}`, 'conversation_migrated',
        json({
          from_conversation_id: task.conversationId, to_conversation_id: input.conversationId, to_conversation_url: input.conversationUrl,
          request_id: input.requestId, authorized_by: input.authorizedBy, reason: input.reason,
          ...(pending ? { pending_effect_id: pending.effectId } : {}),
        }), now()));
      const updated = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!updated) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      return { task: taskFromRow(updated), migrated: true };
    });
  }
  reconcileNativePreSendFailure(effectId: string, requestId: string): boolean {
    // Bounded compatibility repair for the pre-20261002 native dispatcher.
    // These exact returned reasons occur before Send is clicked. Other unknown
    // observations, including transport exceptions, are never negative proof.
    const row = this.read((db) => {
      const dispatch = effectDispatchLedger(db, effectId);
      const owner = statement(db, "SELECT payload_json FROM events WHERE event_id=? AND kind='effect_dispatch_started'", (s) => s.get(dispatch.lastEventId)) as { payload_json?: string } | undefined;
      if (parsedObject(owner?.payload_json).surface !== 'macos-native') return undefined;
      // Other observers can report a transport error while the native sender
      // is still preparing. Only that generation's dispatch owner can prove
      // it returned before clicking Send.
      const unknown = statement(db, "SELECT payload_json FROM events WHERE effect_id=? AND kind='effect_unknown' AND event_id>? AND json_extract(payload_json,'$.surface')='macos-native' ORDER BY event_id LIMIT 1", (s) => s.get(effectId, dispatch.lastEventId)) as { payload_json?: string } | undefined;
      return unknown ? { ...unknown, dispatch_generation: dispatch.lastGeneration } : undefined;
    });
    const evidence = parsedObject(row?.payload_json);
    const beforeSend = new Set(['composer_missing', 'composer_not_empty', 'composer_selection_unavailable', 'composer_text_insertion_rejected', 'composer_text_unconfirmed', 'composer_submit_mismatch', 'send_button_missing']);
    if (evidence.surface !== 'macos-native' || evidence.reconciliation === true || !beforeSend.has(String(evidence.reason))) return false;
    this.recordEffectNotAppliedProof(effectId, `operator-pre-send:${requestId}`, {
      ...evidence, send_clicked: false, dispatch_generation: row?.dispatch_generation, pre_send_rejection: true,
      requested_by: 'user', request_id: requestId, attestation: 'persisted_native_pre_send_return',
    });
    return true;
  }
  private reserveEffectWithin(db: Database, input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    statement(db, 'INSERT OR IGNORE INTO effects(effect_id,task_id,kind,origin_key,source_completion_fingerprint,prompt_text,created_at) VALUES (?,?,?,?,?,?,?)', (s) => s.run(input.effectId, input.taskId, input.kind, input.originKey, input.sourceCompletionFingerprint ?? null, input.prompt, now()));
    const row = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(input.originKey)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_RESERVE_FAILED');
    const effect = effectFromRow(row);
    if (effect.effectId !== input.effectId) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_ID_CONFLICT:${input.originKey}:${effect.effectId}:${input.effectId}`);
    if (effect.taskId !== input.taskId) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_TASK_CONFLICT:${input.originKey}`);
    if (effect.kind !== input.kind) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_KIND_CONFLICT:${input.originKey}`);
    if ((effect.sourceCompletionFingerprint ?? '') !== (input.sourceCompletionFingerprint ?? '')) {
      throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_SOURCE_CONFLICT:${input.originKey}`);
    }
    if (effect.prompt !== input.prompt) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_PROMPT_CONFLICT:${input.originKey}`);
    return effect;
  }

  /** Persist a bounded provider pre-send rejection; a started generation requires a durable exact no-click proof first. */
  recordEffectPreparationFailure(effectId: string, reasonCode: string, composerObservation?: WorkflowSupervisorPreflightComposerObservation): void {
    this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      const dispatch = effectDispatchLedger(db, effectId);
      if (applied || (dispatch.generations > 0 && latestNotAppliedProofEventId(db, effectId) <= dispatch.lastEventId)) {
        throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_FAILURE_OUTCOME_NOT_PROVEN');
      }
      const activeReleaseId = this.activeReleaseId()?.trim() || 'unidentified-runtime';
      // Each explicit rearm gives the next real preparation failure a distinct
      // event key; INSERT OR IGNORE must not hide a failure after a later repair.
      const rearm = statement(db, "SELECT COUNT(*) AS count FROM events WHERE effect_id = ? AND kind = 'effect_preflight_operator_rearmed'", (s) => s.get(effectId)) as { count?: number } | undefined;
      const rearmCount = Number(rearm?.count ?? 0);
      const key = `effect-preflight-rejected:${effectId}:${activeReleaseId}${rearmCount > 0 ? `:operator-rearmed-${rearmCount}` : ''}`;
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
        effect.task_id!, key, 'effect_preflight_rejected', effectId,
        json({ active_release_id: activeReleaseId, reason: (boundedText(reasonCode) ?? 'COMPUTER_PREPARE_REJECTED').slice(0, 256), send_clicked: false, attestation: 'computer_prepare_returned_before_supervisor_send_intent', ...(composerObservation ? { composer_observation: composerObservation } : {}) }), now(),
      ));
    });
  }

  recordEffectDispatchStarted(effectId: string, generation: number, dispatchId: string, evidence: Record<string, unknown> = {}): boolean {
    if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000) throw new Error('WORKFLOW_SUPERVISOR_DISPATCH_GENERATION_INVALID');
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      // Completion and recovery Send compete in this same Store transaction.
      // A command obtained before a late completion cannot revive its recovery.
      if (statement(db, `SELECT 1 FROM effects e JOIN completions c
        ON c.task_id = e.task_id AND e.origin_key = 'provider-recovery:' || c.source_effect_id
        WHERE e.effect_id = ? AND e.kind = 'recovery' LIMIT 1`, (s) => s.get(effectId))) return false;
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      if (applied) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      const refunds = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_budget_refunded'", (s) => s.all(effectId)) as Array<{ event_id?: number }>;
      if (generation > WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + refunds.length || this.preflightBlocked(db, effectId)) return false;
      const prior = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number; payload_json?: string } | undefined;
      const currentGeneration = prior?.event_id ? storedGeneration(prior.payload_json) : 0;
      const retryAuthorized = !prior?.event_id || latestNotAppliedProofEventId(db, effectId) > Number(prior.event_id);
      if (!retryAuthorized || generation !== currentGeneration + 1) return false;
      // `dispatched_at_ms` is the mechanical retry-spacing fact. It is recorded
      // inside the evidence payload so retry spacing stays deterministic under
      // an injected clock without changing durable event timestamps.
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, `effect-dispatch:${effectId}:${generation}`, 'effect_dispatch_started', effectId, json({ dispatchId, generation, dispatched_at_ms: this.clockMs(), ...evidence }), now()));
      return true;
    });
  }

  recordEffectObservation(effectId: string, observationId: string, outcome: WorkflowEffectOutcome, evidence: Record<string, unknown> = {}): void {
    if (outcome === 'not_applied') throw new Error('WORKFLOW_SUPERVISOR_NOT_APPLIED_PROOF_REQUIRED');
    this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const key = `effect-observation:${effectId}:${observationId}`;
      const kind = `effect_${outcome}`;
      const existing = statement(db, 'SELECT kind,payload_json FROM events WHERE event_key = ?', (s) => s.get(key)) as { kind?: string; payload_json?: string } | undefined;
      const payload = json(evidence);
      if (existing && (existing.kind !== kind || existing.payload_json !== payload)) throw new Error('WORKFLOW_SUPERVISOR_OBSERVATION_ID_CONFLICT');
      // Identical unknown observations remain append-only evidence at the capped
      // reconciliation cadence. Permanently suppressing them freezes the last
      // observation timestamp and makes a transient outcome-unknown state unable
      // to discover late provider evidence after Runtime/browser recovery.
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, key, kind, effectId, payload, now()));
    });
  }

  recordEffectNotAppliedProof(effectId: string, observationId: string, proof: Record<string, unknown>): void {
    this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      if (applied) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      const key = `effect-observation:${effectId}:${observationId}`;
      const payload = json(proof);
      const existing = statement(db, 'SELECT kind,payload_json FROM events WHERE event_key = ?', (s) => s.get(key)) as { kind?: string; payload_json?: string } | undefined;
      if (existing && (existing.kind !== 'effect_not_applied' || existing.payload_json !== payload)) throw new Error('WORKFLOW_SUPERVISOR_OBSERVATION_ID_CONFLICT');
      if (existing) return; // An identical old receipt is idempotent, not fresh retry authority.
      const ledger = effectDispatchLedger(db, effectId);
      const proofGeneration = Number(proof.dispatch_generation);
      if (!Number.isInteger(proofGeneration) || proofGeneration < 1 || proofGeneration !== ledger.lastGeneration) {
        throw new Error('WORKFLOW_SUPERVISOR_NOT_APPLIED_PROOF_GENERATION_STALE');
      }
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, key, 'effect_not_applied', effectId, payload, now()));
      const legacyRefund = statement(db, 'SELECT event_id FROM events WHERE event_key = ?', (s) => s.get(`effect-dispatch-budget-refund:${effectId}`)) as { event_id?: number } | undefined;
      const legacyRefundCoversGeneration = proofGeneration === WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS && Boolean(legacyRefund);
      if (proof.pre_send_rejection === true
        && Number.isInteger(proofGeneration) && proofGeneration > 0
        && proofGeneration === ledger.lastGeneration
        && !legacyRefundCoversGeneration) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(
          effect.task_id, `effect-dispatch-budget-refund:${effectId}:${proofGeneration}`, 'effect_dispatch_budget_refunded', effectId,
          json({ reason: 'pre_send_rejection_did_not_reach_provider', dispatch_generation: proofGeneration }), now(),
        ));
      }
    });
  }

  commitCompletion(input: WorkflowSupervisorCompletion, successor?: { effectId: string; kind: WorkflowEffectKind; prompt: string; freshEnrollmentPrompt?: string }): { completion: WorkflowSupervisorCompletion; successorEffect?: WorkflowSupervisorEffect; deduplicated: boolean } {
    return this.transaction((db) => {
      const task = statement(db, 'SELECT 1 AS ok FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId));
      if (!task) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const sourceEffect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(input.sourceEffectId)) as { task_id?: string } | undefined;
      if (sourceEffect?.task_id !== input.taskId) throw new Error('WORKFLOW_SUPERVISOR_SOURCE_EFFECT_MISMATCH');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(input.sourceEffectId));
      if (!applied) throw new Error('WORKFLOW_SUPERVISOR_SOURCE_EFFECT_NOT_APPLIED');
      const priorForEffect = statement(db, 'SELECT completion_fingerprint FROM completions WHERE task_id = ? AND source_effect_id = ?', (s) => s.get(input.taskId, input.sourceEffectId)) as { completion_fingerprint?: string } | undefined;
      if (priorForEffect?.completion_fingerprint && priorForEffect.completion_fingerprint !== input.completionFingerprint) {
        throw new Error('WORKFLOW_SUPERVISOR_SOURCE_EFFECT_COMPLETION_CONFLICT');
      }
      const existing = statement(db, 'SELECT completion_fingerprint FROM completions WHERE completion_fingerprint = ?', (s) => s.get(input.completionFingerprint));
      // Once the recovery has a Send intent, its outcome may be unknown. A
      // late source reply must not create a parallel successor or rotate away
      // from that obligation. Exact historical completion replay stays inert.
      if (!existing && statement(db, `SELECT 1 FROM effects child JOIN events started
        ON started.effect_id = child.effect_id AND started.kind = 'effect_dispatch_started'
        WHERE child.task_id = ? AND child.origin_key = ? LIMIT 1`,
        (s) => s.get(input.taskId, 'provider-recovery:' + input.sourceEffectId))) {
        throw new Error('WORKFLOW_SUPERVISOR_SOURCE_EFFECT_RECOVERY_DISPATCHED');
      }
      if (!existing) statement(db, 'INSERT INTO completions VALUES (?,?,?,?,?,?,?,?)', (s) => s.run(input.completionFingerprint, input.taskId, input.sourceEffectId, input.action, input.responseSha256, input.controlBlockSha256, json(input.proposal), input.committedAt));
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,completion_fingerprint,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?)', (s) => s.run(input.taskId, `completion:${input.completionFingerprint}`, 'assistant_completion', input.sourceEffectId, input.completionFingerprint, json(input.proposal), input.committedAt));
      let successorEffect: WorkflowSupervisorEffect | undefined;
      if (successor) {
        const originKey = `completion:${input.completionFingerprint}`;
        const priorSuccessorRow = existing
          ? statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(originKey)) as Record<string, unknown> | undefined
          : undefined;
        if (priorSuccessorRow) {
          const priorSuccessor = effectFromRow(priorSuccessorRow);
          if (priorSuccessor.taskId !== input.taskId) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_TASK_CONFLICT:${originKey}`);
          if (priorSuccessor.kind !== successor.kind && !(successor.freshEnrollmentPrompt && priorSuccessor.kind === 'enrollment')) {
            throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_KIND_CONFLICT:${originKey}`);
          }
          if ((priorSuccessor.sourceCompletionFingerprint ?? '') !== input.completionFingerprint) {
            throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_SOURCE_CONFLICT:${originKey}`);
          }
          successorEffect = priorSuccessor;
        } else {
          // User-authorized periodic rotation is a mechanical cadence over
          // completed CONTINUE receipts, never sends, elapsed time or Work state.
          // The completion, fresh enrollment, binding change and migration
          // evidence commit atomically in the existing Supervisor journal.
          const current = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown>;
          const currentTask = taskFromRow(current);
          const lastMigration = statement(db, "SELECT MAX(event_id) AS id FROM events WHERE task_id=? AND kind='conversation_migrated'", (s) => s.get(input.taskId)) as { id?: number };
          const completedSinceMigration = statement(db, `SELECT COUNT(*) AS total FROM events e
            JOIN completions c ON c.completion_fingerprint=e.completion_fingerprint
            WHERE e.task_id=? AND e.kind='assistant_completion' AND e.event_id>? AND c.action='CONTINUE'`,
            (s) => s.get(input.taskId, lastMigration?.id ?? 0)) as { total?: number };
          // One durable completion ledger owns proactive rotation. Count real
          // completed turns instead of estimating a conversation's token size;
          // verified exact-target load failures advance the rotation cadence.
          const unavailableReads = statement(db, `SELECT COUNT(*) AS total FROM events
            WHERE task_id=? AND kind='browser_delivery_attempt_failed' AND event_id>?
              AND json_extract(payload_json,'$.conversation_id')=?
              AND json_extract(payload_json,'$.code')='COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE'
              AND json_extract(payload_json,'$.verified_empty_shell')=1`,
            (s) => s.get(input.taskId, lastMigration?.id ?? 0, currentTask.conversationId)) as { total?: number };
          const receiptLimit = (unavailableReads.total ?? 0) >= 2 ? 6 : 10;
          const rotate = successor.freshEnrollmentPrompt !== undefined
            && currentTask.continuationPolicy.kind === 'standalone_supervisor'
            && !currentTask.conversationId.startsWith('bootstrap:')
            && (completedSinceMigration.total ?? 0) >= receiptLimit
            // The source completion cannot retire any other still-unapplied
            // command: a started send may have reached the provider, and even
            // an unstarted effect still owns an undispatched continuation.
            && !oldestUnappliedEffect(db, input.taskId)
            && !appliedEffectAwaitingCompletionWithin(db, input.taskId);
          successorEffect = this.reserveEffectWithin(db, {
            taskId: input.taskId, effectId: successor.effectId,
            kind: rotate ? 'enrollment' : successor.kind, originKey,
            sourceCompletionFingerprint: input.completionFingerprint,
            prompt: rotate ? successor.freshEnrollmentPrompt! : successor.prompt,
          });
          if (rotate) {
            const sourceConversationId = currentTask.conversationId;
            const bootstrapConversationId = `bootstrap:${input.taskId}`;
            statement(db, 'UPDATE tasks SET conversation_id=?, conversation_url=? WHERE task_id=?',
              (s) => s.run(bootstrapConversationId, 'https://chatgpt.com/', input.taskId));
            statement(db, 'INSERT INTO events(task_id,event_key,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)', (s) => s.run(
              input.taskId, `conversation-migrated:auto:${input.completionFingerprint}`, 'conversation_migrated',
              json({ from_conversation_id: sourceConversationId, to_conversation_id: bootstrapConversationId,
                to_conversation_url: 'https://chatgpt.com/', fresh_conversation: true,
                replacement_effect_id: successorEffect!.effectId, request_id: `automatic-receipt:${input.completionFingerprint}`,
                authorized_by: 'user-configured-standalone-rotation', reason: `confirmed_continue_receipts:${receiptLimit}` }), now()));
          }
        }
      }
      return { completion: input, ...(successorEffect ? { successorEffect } : {}), deduplicated: Boolean(existing) };
    });
  }

  resolveTerminal(input: { completionFingerprint: string; taskId: string; action: 'DONE' | 'NEEDS_USER'; accepted: boolean; reason: string; correction?: { effectId: string; prompt: string } }): { successorEffect?: WorkflowSupervisorEffect; deduplicated: boolean } {
    return this.transaction((db) => {
      const key = `terminal-resolution:${input.completionFingerprint}`;
      const existing = statement(db, 'SELECT kind,payload_json FROM events WHERE event_key = ?', (s) => s.get(key)) as { kind?: string; payload_json?: string } | undefined;
      if (existing) {
        const effect = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(`completion:${input.completionFingerprint}`));
        return { ...(effect ? { successorEffect: effectFromRow(effect as Record<string, unknown>) } : {}), deduplicated: true };
      }
      const kind = input.accepted ? (input.action === 'DONE' ? 'terminal_done' : 'terminal_needs_user') : 'terminal_rejected';
      statement(db, 'INSERT INTO events(task_id,event_key,kind,completion_fingerprint,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, key, kind, input.completionFingerprint, json({ reason: input.reason }), now()));
      const successorEffect = !input.accepted && input.correction ? this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.correction.effectId, kind: 'correction', originKey: `completion:${input.completionFingerprint}`, sourceCompletionFingerprint: input.completionFingerprint, prompt: input.correction.prompt }) : undefined;
      return { ...(successorEffect ? { successorEffect } : {}), deduplicated: false };
    });
  }
}
