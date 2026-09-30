import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorDatabasePathValue, workflowSupervisorRootPath } from './paths';
import type { WorkflowEffectKind, WorkflowEffectOutcome, WorkflowSupervisorCompletion, WorkflowSupervisorContinuationProof, WorkflowSupervisorDiscoverySnapshot, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTerminalState } from './types';

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
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => json(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b));
    return `{${entries.map(([key,item]) => `${JSON.stringify(key)}:${json(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
function storedGeneration(value: unknown): number {
  const generation = Number(parsedObject(value).generation);
  return Number.isInteger(generation) && generation > 0 ? generation : 1;
}
function latestNotAppliedProofEventId(db: Database, effectId: string): number {
  const notApplied = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_not_applied' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number } | undefined;
  return Number(notApplied?.event_id ?? 0);
}

function oldestUnappliedEffect(db: Database, taskId: string): WorkflowSupervisorEffect | undefined {
  const row = statement(db, `SELECT e.* FROM effects e
    WHERE e.task_id = ? AND NOT EXISTS (
      SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied'
    ) ORDER BY e.created_at, e.effect_id LIMIT 1`, (s) => s.get(taskId)) as Record<string, unknown> | undefined;
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
export const WORKFLOW_SUPERVISOR_DISPATCH_RETRY_BASE_MS = 30_000;
export const WORKFLOW_SUPERVISOR_DISPATCH_RETRY_MAX_MS = 10 * 60_000;
export const WORKFLOW_SUPERVISOR_MAX_SAME_UNKNOWN_OBSERVATIONS = 3;
export const WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_BASE_MS = 5_000;
export const WORKFLOW_SUPERVISOR_UNKNOWN_OBSERVATION_MAX_MS = 60_000;

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
export class WorkflowSupervisorStore {
  private readonly db: Database;
  private closed = false;
  /** Mechanical clock for provider retry spacing. Durable event timestamps keep wall-clock ISO. */
  private readonly clockMs: () => number;

  constructor(readonly forgeHome?: string, options: { now?: () => number } = {}) {
    this.db = openDatabase(forgeHome);
    this.clockMs = options.now ?? Date.now;
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
        statement(db, `INSERT INTO discovered_conversations(source,conversation_id,canonical_url,title,project_title,project_url,observed_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(source,conversation_id) DO UPDATE SET canonical_url=excluded.canonical_url,title=excluded.title,
            project_title=COALESCE(excluded.project_title,discovered_conversations.project_title),
            project_url=COALESCE(excluded.project_url,discovered_conversations.project_url),observed_at=excluded.observed_at`,
        (s) => s.run(normalizedSource, conversation.conversationId, conversation.canonicalUrl, conversation.title ?? null, conversation.projectTitle ?? null, conversation.projectUrl ?? null, observedAt));
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
        const rowObservedAt = String(row.observed_at ?? '');
        if (rowObservedAt > observedAt) observedAt = rowObservedAt;
        const current = byConversation.get(conversationId);
        const candidate: WorkflowSupervisorDiscoveredConversation = {
          conversationId,
          canonicalUrl,
          ...(row.title ? { title: String(row.title) } : {}),
          ...(row.project_title ? { projectTitle: String(row.project_title) } : {}),
          ...(row.project_url ? { projectUrl: String(row.project_url) } : {}),
        };
        if (!current) byConversation.set(conversationId, candidate);
        else if (!current.projectTitle && candidate.projectTitle) byConversation.set(conversationId, { ...current, projectTitle: candidate.projectTitle, ...(candidate.projectUrl ? { projectUrl: candidate.projectUrl } : {}) });
      }
      return { observedAt, conversations: [...byConversation.values()] };
    });
  }

  registerTask(input: WorkflowSupervisorTaskInput): WorkflowSupervisorTask {
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
      const bootstrapUpgrade = task.continuationPolicy.bootstrap === true
        && input.continuationPolicy.bootstrap !== true
        && taskRepo === inputRepo
        && task.conversationId === input.conversationId
        && task.conversationUrl === input.conversationUrl;
      if (bootstrapUpgrade) {
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
  getTask(taskId: string): WorkflowSupervisorTask | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)); return row ? taskFromRow(row as Record<string, unknown>) : undefined; }); }
  bindBootstrapConversation(taskId: string, conversationId: string, conversationUrl: string): WorkflowSupervisorTask {
    return this.transaction((db) => {
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN');
      const task = taskFromRow(row);
      if (!task.conversationId.startsWith('bootstrap:')) {
        if (task.conversationId === conversationId && task.conversationUrl === conversationUrl) return task;
        throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_ALREADY_BOUND');
      }
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
      ORDER BY c.committed_at DESC, c.completion_fingerprint DESC LIMIT ?`, (s) => s.all(boundedLimit))
      .map((row) => completionFromRow(row as Record<string, unknown>)));
  }
  getCompletionByResponseSha256(taskId: string, responseSha256: string): WorkflowSupervisorCompletion | undefined {
    return this.read((db) => {
      const rows = statement(db, 'SELECT * FROM completions WHERE task_id = ? AND response_sha256 = ? ORDER BY committed_at, completion_fingerprint LIMIT 2', (s) => s.all(taskId, responseSha256)) as Record<string, unknown>[];
      if (rows.length > 1) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_COMPLETION_AMBIGUOUS');
      return rows[0] ? completionFromRow(rows[0]) : undefined;
    });
  }
  /** The only replay candidate when no applied effect is awaiting a receipt. */
  getLatestCompletion(taskId: string): WorkflowSupervisorCompletion | undefined {
    return this.read((db) => {
      const row = statement(db, 'SELECT * FROM completions WHERE task_id = ? ORDER BY committed_at DESC, completion_fingerprint DESC LIMIT 1', (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      return row ? completionFromRow(row) : undefined;
    });
  }
  continuationProof(input: { repoId?: string; activeReleaseId: string; notBefore: string }): WorkflowSupervisorContinuationProof | undefined {
    if (!Number.isFinite(Date.parse(input.notBefore))) throw new Error('WORKFLOW_SUPERVISOR_PROOF_BOUNDARY_INVALID');
    const activeReleaseId = boundedText(input.activeReleaseId);
    if (!activeReleaseId) throw new Error('WORKFLOW_SUPERVISOR_PROOF_RELEASE_REQUIRED');
    return this.read((db) => {
      const taskRows = statement(db, 'SELECT * FROM tasks ORDER BY created_at DESC, task_id DESC', (s) => s.all()) as Record<string, unknown>[];
      for (const taskRow of taskRows) {
        const task = taskFromRow(taskRow);
        const taskRepoId = boundedText(task.completionContract.repo_id) ?? boundedText(task.continuationPolicy.repo_id);
        if (input.repoId?.trim() && taskRepoId !== input.repoId.trim()) continue;
        const completionRows = statement(db, 'SELECT * FROM completions WHERE task_id = ? AND committed_at >= ? ORDER BY committed_at, completion_fingerprint', (s) => s.all(task.taskId, input.notBefore)) as Record<string, unknown>[];
        const completions = completionRows.map(completionFromRow);
        for (let index = 0; index + 2 < completions.length; index += 1) {
          const first = completions[index]!;
          const second = completions[index + 1]!;
          const third = completions[index + 2]!;
          if (first.action !== 'CONTINUE' || second.action !== 'CONTINUE' || third.action !== 'DONE') continue;
          const rows = [first, second, third].map((completion) => statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(completion.sourceEffectId)) as Record<string, unknown> | undefined);
          if (rows.some((row) => !row)) continue;
          const [firstEffect, secondEffect, thirdEffect] = rows.map((row) => effectFromRow(row!)) as [WorkflowSupervisorEffect, WorkflowSupervisorEffect, WorkflowSupervisorEffect];
          if (secondEffect.sourceCompletionFingerprint !== first.completionFingerprint || thirdEffect.sourceCompletionFingerprint !== second.completionFingerprint) continue;
          const runtimeInstanceIds: string[] = [];
          let valid = true;
          for (const effect of [firstEffect, secondEffect, thirdEffect]) {
            const dispatchRows = statement(db, "SELECT payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' AND occurred_at >= ? ORDER BY event_id", (s) => s.all(effect.effectId, input.notBefore)) as Array<{ payload_json?: string }>;
            if (dispatchRows.length !== 1) { valid = false; break; }
            const evidence = parsedObject(dispatchRows[0]?.payload_json);
            if (boundedText(evidence.active_release_id) !== activeReleaseId) { valid = false; break; }
            const runtimeInstanceId = boundedText(evidence.runtime_instance_id);
            if (!runtimeInstanceId) { valid = false; break; }
            runtimeInstanceIds.push(runtimeInstanceId);
            const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' AND occurred_at >= ? LIMIT 1", (s) => s.get(effect.effectId, input.notBefore));
            if (!applied) { valid = false; break; }
          }
          const minimumRuntimeInstances = task.continuationPolicy.kind === 'standalone_supervisor' ? 1 : 2;
          if (!valid || new Set(runtimeInstanceIds).size < minimumRuntimeInstances) continue;
          const terminalDone = statement(db, "SELECT 1 AS ok FROM events WHERE task_id = ? AND completion_fingerprint = ? AND kind = 'terminal_done' AND occurred_at >= ? LIMIT 1", (s) => s.get(task.taskId, third.completionFingerprint, input.notBefore));
          if (!terminalDone) continue;
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
   * stays inside its mechanical retry budget and retry window. When the budget
   * is exhausted this returns `undefined`: the effect stops demanding browser
   * attention so the adapter stops re-opening the conversation, and the
   * ControllerRound recovery path reports the bounded failure instead of the
   * Supervisor silently resending forever.
   */
  nextBrowserEffect(
    taskId: string,
    options: { nowMs?: number } = {},
  ): { effect: WorkflowSupervisorEffect; mode: 'send' | 'reconcile'; generation: number } | undefined {
    return this.read((db) => {
      const effect = oldestUnappliedEffect(db, taskId);
      if (!effect) return undefined;
      const ledger = effectDispatchLedger(db, effect.effectId);
      if (ledger.generations === 0) return { effect, mode: 'send', generation: 1 };
      const retryAuthorized = latestNotAppliedProofEventId(db, effect.effectId) > ledger.lastEventId;
      const nowMs = options.nowMs ?? this.clockMs();
      if (!retryAuthorized) {
        const unknownLedger = effectUnknownObservationLedger(db, effect.effectId, ledger.lastEventId);
        if (unknownLedger.sameFingerprintCount >= WORKFLOW_SUPERVISOR_MAX_SAME_UNKNOWN_OBSERVATIONS) return undefined;
        if (unknownLedger.sameFingerprintCount > 0
          && nowMs - unknownLedger.lastOccurredAtMs < unknownObservationDelayMs(unknownLedger.sameFingerprintCount)) {
          return undefined;
        }
        return { effect, mode: 'reconcile', generation: ledger.lastGeneration };
      }
      if (ledger.generations >= WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + ledger.budgetRefunds) return undefined;
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
  providerResumeExhausted(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'assistant_recovery_exhausted' LIMIT 1", (s) => s.get(effectId)))); }
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
          AND NOT EXISTS (SELECT 1 FROM effects child WHERE child.origin_key = 'provider-recovery:' || e.effect_id)
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
    return this.read((db) => Boolean(statement(db, `SELECT 1 AS ok FROM effects e
      WHERE e.task_id = ?
        AND EXISTS (SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied')
        AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id)
      LIMIT 1`, (s) => s.get(taskId))));
  }

  observeProviderTurn(input: {
    taskId: string;
    effectId: string;
    generating: boolean;
    assistantDigest: string;
    providerFailureCode?: string;
    observedAtMs: number;
    graceMs: number;
    recovery: { effectId: string; prompt: string };
  }): { state: 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    if (!Number.isFinite(input.observedAtMs)) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_OBSERVED_AT_INVALID');
    const graceMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.graceMs)));
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
      const effectOrigin = String(row.origin_key ?? '');
      const isProviderResume = effect.kind === 'recovery' && effectOrigin.startsWith('provider-recovery:');
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
        if (isProviderResume) {
          statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-exhausted:${effect.effectId}`, 'assistant_recovery_exhausted', effect.effectId, json({ assistant_digest: digest, provider_failure_code: providerFailureCode, exactly_once_resume: true }), observedAt));
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
      // A live provider may legitimately spend much longer reasoning than an idle
      // page needs to settle. Only classify `generating` as stale after five idle
      // grace windows, capped by the existing ten-minute mechanical bound.
      const unchangedGraceMs = input.generating ? Math.min(10 * 60_000, graceMs * 5) : graceMs;
      if (!Number.isFinite(unchangedSinceMs) || input.observedAtMs - unchangedSinceMs < unchangedGraceMs) {
        return { state: input.generating ? 'generating' : 'idle_pending' };
      }

      // A provider turn that still advertises `generating` but has produced no
      // observable assistant/activity change for the full grace window is stale,
      // not healthy progress. Reuse the same exactly-once recovery path as an idle
      // turn: the already-applied source effect is never replayed, and a recovery
      // effect itself is never recursively recovered.
      if (isProviderResume) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-exhausted:${effect.effectId}`, 'assistant_recovery_exhausted', effect.effectId, json({ assistant_digest: digest, exactly_once_resume: true, stale_generation: input.generating }), observedAt));
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

  recordEffectDispatchStarted(effectId: string, generation: number, dispatchId: string, evidence: Record<string, unknown> = {}): boolean {
    if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000) throw new Error('WORKFLOW_SUPERVISOR_DISPATCH_GENERATION_INVALID');
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      if (applied) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      const refunds = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_budget_refunded'", (s) => s.all(effectId)) as Array<{ event_id?: number }>;
      if (generation > WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS + refunds.length) return false;
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
      if (outcome === 'unknown') {
        const dispatch = effectDispatchLedger(db, effectId);
        const unknownLedger = effectUnknownObservationLedger(db, effectId, dispatch.lastEventId);
        const fingerprint = unknownObservationFingerprintFromObject(evidence);
        if (fingerprint
          && unknownLedger.fingerprint === fingerprint
          && unknownLedger.sameFingerprintCount >= WORKFLOW_SUPERVISOR_MAX_SAME_UNKNOWN_OBSERVATIONS) {
          return;
        }
      }
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
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, key, 'effect_not_applied', effectId, payload, now()));
      const ledger = effectDispatchLedger(db, effectId);
      if (proof.pre_send_rejection === true
        && ledger.generations >= WORKFLOW_SUPERVISOR_MAX_DISPATCH_GENERATIONS
        && ledger.budgetRefunds === 0) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, `effect-dispatch-budget-refund:${effectId}`, 'effect_dispatch_budget_refunded', effectId, json({ reason: 'pre_send_rejection_did_not_reach_provider' }), now()));
      }
    });
  }

  commitCompletion(input: WorkflowSupervisorCompletion, successor?: { effectId: string; kind: WorkflowEffectKind; prompt: string }): { completion: WorkflowSupervisorCompletion; successorEffect?: WorkflowSupervisorEffect; deduplicated: boolean } {
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
          if (priorSuccessor.kind !== successor.kind) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_KIND_CONFLICT:${originKey}`);
          if ((priorSuccessor.sourceCompletionFingerprint ?? '') !== input.completionFingerprint) {
            throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_SOURCE_CONFLICT:${originKey}`);
          }
          successorEffect = priorSuccessor;
        } else {
          successorEffect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: successor.effectId, kind: successor.kind, originKey, sourceCompletionFingerprint: input.completionFingerprint, prompt: successor.prompt });
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
