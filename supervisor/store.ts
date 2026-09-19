import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorDatabasePathValue, workflowSupervisorRootPath } from './paths';
import type { WorkflowEffectKind, WorkflowEffectOutcome, WorkflowSupervisorCompletion, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput } from './types';

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
function latestRetryEvidenceEventId(db: Database, effectId: string): number {
  const notApplied = statement(db, "SELECT event_id FROM events WHERE effect_id = ? AND kind = 'effect_not_applied' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number } | undefined;
  const preSubmitUnknown = statement(db, `SELECT event_id FROM events
    WHERE effect_id = ?
      AND kind = 'effect_unknown'
      AND json_extract(payload_json, '$.surface') = 'macos-native'
      AND json_extract(payload_json, '$.reason') IN ('composer_missing', 'send_button_missing')
    ORDER BY event_id DESC LIMIT 1`, (s) => s.get(effectId)) as { event_id?: number } | undefined;
  return Math.max(Number(notApplied?.event_id ?? 0), Number(preSubmitUnknown?.event_id ?? 0));
}
function providerRecoveryDepth(db: Database, effectId: string): number {
  let current = effectId;
  let depth = 0;
  const seen = new Set<string>();
  while (depth < 32 && !seen.has(current)) {
    seen.add(current);
    const row = statement(db, 'SELECT origin_key FROM effects WHERE effect_id = ?', (s) => s.get(current)) as { origin_key?: string } | undefined;
    const origin = String(row?.origin_key ?? '');
    if (!origin.startsWith('provider-recovery:')) break;
    const parent = origin.slice('provider-recovery:'.length).trim();
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export class WorkflowSupervisorStore {
  private readonly db: Database;
  private closed = false;

  constructor(readonly forgeHome?: string) {
    this.db = openDatabase(forgeHome);
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

  registerTask(input: WorkflowSupervisorTaskInput): WorkflowSupervisorTask {
    return this.transaction((db) => {
      const createdAt = now();
      statement(db, 'INSERT OR IGNORE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (s) => s.run(input.taskId, input.conversationId, input.conversationUrl, input.objective, json(input.completionContract), json(input.continuationPolicy), json(input.userBlockerPolicy), createdAt));
      const row = statement(db, 'SELECT * FROM tasks WHERE task_id = ?', (s) => s.get(input.taskId)) as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORKFLOW_SUPERVISOR_TASK_PERSIST_FAILED');
      const task = taskFromRow(row);
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
  getTaskByConversationId(conversationId: string): WorkflowSupervisorTask | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM tasks WHERE conversation_id = ?', (s) => s.get(conversationId)); return row ? taskFromRow(row as Record<string, unknown>) : undefined; }); }
  listTasks(): WorkflowSupervisorTask[] { return this.read((db) => statement(db, 'SELECT * FROM tasks ORDER BY created_at, task_id', (s) => s.all()).map((row) => taskFromRow(row as Record<string, unknown>))); }
  getEffect(effectId: string): WorkflowSupervisorEffect | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(effectId)); return row ? effectFromRow(row as Record<string, unknown>) : undefined; }); }
  getCompletion(completionFingerprint: string): WorkflowSupervisorCompletion | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM completions WHERE completion_fingerprint = ?', (s) => s.get(completionFingerprint)); return row ? completionFromRow(row as Record<string, unknown>) : undefined; }); }
  latestEffectDispatch(effectId: string): { eventId: number; generation: number; evidence: Record<string, unknown> } | undefined {
    return this.read((db) => {
      const row = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number; payload_json?: string } | undefined;
      if (!row?.event_id) return undefined;
      return { eventId: Number(row.event_id), generation: storedGeneration(row.payload_json), evidence: parsedObject(row.payload_json) };
    });
  }
  nextBrowserEffect(taskId: string): { effect: WorkflowSupervisorEffect; mode: 'send' | 'reconcile'; generation: number } | undefined {
    return this.read((db) => {
      const row = statement(db, `SELECT e.* FROM effects e
        WHERE e.task_id = ? AND NOT EXISTS (
          SELECT 1 FROM events applied WHERE applied.effect_id = e.effect_id AND applied.kind = 'effect_applied'
        ) ORDER BY e.created_at, e.effect_id LIMIT 1`, (s) => s.get(taskId)) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const effect = effectFromRow(row);
      const dispatch = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effect.effectId)) as { event_id?: number; payload_json?: string } | undefined;
      if (!dispatch?.event_id) return { effect, mode: 'send', generation: 1 };
      const currentGeneration = storedGeneration(dispatch.payload_json);
      const retryAuthorized = latestRetryEvidenceEventId(db, effect.effectId) > Number(dispatch.event_id);
      return { effect, mode: retryAuthorized ? 'send' : 'reconcile', generation: retryAuthorized ? currentGeneration + 1 : currentGeneration };
    });
  }
  terminalAction(taskId: string): 'DONE' | 'NEEDS_USER' | undefined { return this.read((db) => { const row = statement(db, "SELECT kind FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user') ORDER BY event_id DESC LIMIT 1", (s) => s.get(taskId)) as { kind?: string } | undefined; return row?.kind === 'terminal_done' ? 'DONE' : row?.kind === 'terminal_needs_user' ? 'NEEDS_USER' : undefined; }); }
  effectApplied(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId)))); }
  providerRecoveryExhausted(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'assistant_recovery_exhausted' LIMIT 1", (s) => s.get(effectId)))); }
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
        AND NOT EXISTS (SELECT 1 FROM events exhausted WHERE exhausted.effect_id = e.effect_id AND exhausted.kind = 'assistant_recovery_exhausted')
        AND NOT EXISTS (
          SELECT 1 FROM effects child
          JOIN events child_exhausted ON child_exhausted.effect_id = child.effect_id AND child_exhausted.kind = 'assistant_recovery_exhausted'
          WHERE child.origin_key = 'provider-recovery:' || e.effect_id
        )
      LIMIT 1`, (s) => s.get(taskId))));
  }

  observeProviderTurn(input: {
    taskId: string;
    effectId: string;
    generating: boolean;
    assistantDigest: string;
    observedAtMs: number;
    graceMs: number;
    maxRecoveryDepth: number;
    recovery: { effectId: string; prompt: string };
  }): { state: 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    if (!Number.isFinite(input.observedAtMs)) throw new Error('WORKFLOW_SUPERVISOR_PROVIDER_OBSERVED_AT_INVALID');
    const graceMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.graceMs)));
    const maxRecoveryDepth = Math.max(0, Math.min(8, Math.floor(input.maxRecoveryDepth)));
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
      const recoveryOrigin = `provider-recovery:${effect.effectId}`;
      const existingRecovery = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(recoveryOrigin)) as Record<string, unknown> | undefined;
      if (existingRecovery) return { state: 'recovery_reserved', recoveryEffect: effectFromRow(existingRecovery) };

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
      if (input.generating) return { state: 'generating' };
      const idleSinceMs = Date.parse(String(latest?.occurred_at ?? ''));
      if (!Number.isFinite(idleSinceMs) || input.observedAtMs - idleSinceMs < graceMs) return { state: 'idle_pending' };

      const depth = providerRecoveryDepth(db, effect.effectId);
      if (depth >= maxRecoveryDepth) {
        statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-exhausted:${effect.effectId}`, 'assistant_recovery_exhausted', effect.effectId, json({ depth, max_recovery_depth: maxRecoveryDepth, assistant_digest: digest }), observedAt));
        return { state: 'exhausted' };
      }
      const recoveryEffect = this.reserveEffectWithin(db, { taskId: input.taskId, effectId: input.recovery.effectId, kind: 'recovery', originKey: recoveryOrigin, prompt: input.recovery.prompt });
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `assistant-recovery-reserved:${effect.effectId}`, 'assistant_recovery_reserved', effect.effectId, json({ recovery_effect_id: recoveryEffect.effectId, recovery_depth: depth + 1 }), observedAt));
      return { state: 'recovery_reserved', recoveryEffect };
    });
  }

  reserveEffect(input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    return this.transaction((db) => this.reserveEffectWithin(db, input));
  }
  reserveSchedulerRecovery(input: { taskId: string; effectId: string; recoveryKey?: string; prompt: string }): WorkflowSupervisorEffect | undefined {
    return this.transaction((db) => {
      const recoveryKey = input.recoveryKey?.trim();
      if (recoveryKey && /[\r\n]/.test(recoveryKey)) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_KEY_INVALID');
      const originKey = `scheduler-recovery:${input.taskId}${recoveryKey ? `:${recoveryKey.slice(0, 240)}` : ''}`;
      const existing = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(originKey)) as Record<string, unknown> | undefined;
      if (existing) return effectFromRow(existing);
      const exhausted = statement(db, `SELECT e.effect_id FROM effects e
        JOIN events exhausted ON exhausted.effect_id = e.effect_id AND exhausted.kind = 'assistant_recovery_exhausted'
        WHERE e.task_id = ?
          AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.task_id = e.task_id AND c.source_effect_id = e.effect_id)
        ORDER BY exhausted.event_id DESC LIMIT 1`, (s) => s.get(input.taskId)) as { effect_id?: string } | undefined;
      if (!exhausted?.effect_id) return undefined;
      const recovery = this.reserveEffectWithin(db, {
        taskId: input.taskId,
        effectId: input.effectId,
        kind: 'recovery',
        originKey,
        prompt: input.prompt,
      });
      statement(db, 'INSERT OR IGNORE INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(input.taskId, `scheduler-recovery-reserved:${input.taskId}`, 'scheduler_recovery_reserved', exhausted.effect_id, json({ recovery_effect_id: recovery.effectId }), now()));
      return recovery;
    });
  }
  private reserveEffectWithin(db: Database, input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    statement(db, 'INSERT OR IGNORE INTO effects(effect_id,task_id,kind,origin_key,source_completion_fingerprint,prompt_text,created_at) VALUES (?,?,?,?,?,?,?)', (s) => s.run(input.effectId, input.taskId, input.kind, input.originKey, input.sourceCompletionFingerprint ?? null, input.prompt, now()));
    const row = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(input.originKey)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_RESERVE_FAILED');
    return effectFromRow(row);
  }

  recordEffectDispatchStarted(effectId: string, generation: number, dispatchId: string, evidence: Record<string, unknown> = {}): boolean {
    if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000) throw new Error('WORKFLOW_SUPERVISOR_DISPATCH_GENERATION_INVALID');
    return this.transaction((db) => {
      const effect = statement(db, 'SELECT task_id FROM effects WHERE effect_id = ?', (s) => s.get(effectId)) as { task_id?: string } | undefined;
      if (!effect?.task_id) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_UNKNOWN');
      const applied = statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId));
      if (applied) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');
      const prior = statement(db, "SELECT event_id,payload_json FROM events WHERE effect_id = ? AND kind = 'effect_dispatch_started' ORDER BY event_id DESC LIMIT 1", (s) => s.get(effectId)) as { event_id?: number; payload_json?: string } | undefined;
      const currentGeneration = prior?.event_id ? storedGeneration(prior.payload_json) : 0;
      const retryAuthorized = !prior?.event_id || latestRetryEvidenceEventId(db, effectId) > Number(prior.event_id);
      if (!retryAuthorized || generation !== currentGeneration + 1) return false;
      statement(db, 'INSERT INTO events(task_id,event_key,kind,effect_id,payload_json,occurred_at) VALUES (?,?,?,?,?,?)', (s) => s.run(effect.task_id, `effect-dispatch:${effectId}:${generation}`, 'effect_dispatch_started', effectId, json({ dispatchId, generation, ...evidence }), now()));
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
      const successorEffect = successor ? this.reserveEffectWithin(db, { taskId: input.taskId, effectId: successor.effectId, kind: successor.kind, originKey: `completion:${input.completionFingerprint}`, sourceCompletionFingerprint: input.completionFingerprint, prompt: successor.prompt }) : undefined;
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
