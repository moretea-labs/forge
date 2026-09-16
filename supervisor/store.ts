import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

export function resolveWorkflowSupervisorForgeHome(forgeHome?: string): string {
  return resolve(forgeHome ?? process.env.FORGE_HOME ?? join(homedir(), '.forge'));
}
export function workflowSupervisorRoot(forgeHome?: string): string {
  const root = join(resolveWorkflowSupervisorForgeHome(forgeHome), 'supervisor');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
export function workflowSupervisorDatabasePath(forgeHome?: string): string { return join(workflowSupervisorRoot(forgeHome), 'supervisor.sqlite'); }

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

export class WorkflowSupervisorStore {
  constructor(readonly forgeHome?: string) {}
  private transaction<T>(fn: (db: Database) => T): T {
    const db = openDatabase(this.forgeHome); db.exec('BEGIN IMMEDIATE');
    try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  }
  private read<T>(fn: (db: Database) => T): T { const db = openDatabase(this.forgeHome); try { return fn(db); } finally { db.close(); } }

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
  getEffect(effectId: string): WorkflowSupervisorEffect | undefined { return this.read((db) => { const row = statement(db, 'SELECT * FROM effects WHERE effect_id = ?', (s) => s.get(effectId)); return row ? effectFromRow(row as Record<string, unknown>) : undefined; }); }
  terminalAction(taskId: string): 'DONE' | 'NEEDS_USER' | undefined { return this.read((db) => { const row = statement(db, "SELECT kind FROM events WHERE task_id = ? AND kind IN ('terminal_done','terminal_needs_user') ORDER BY event_id DESC LIMIT 1", (s) => s.get(taskId)) as { kind?: string } | undefined; return row?.kind === 'terminal_done' ? 'DONE' : row?.kind === 'terminal_needs_user' ? 'NEEDS_USER' : undefined; }); }
  effectApplied(effectId: string): boolean { return this.read((db) => Boolean(statement(db, "SELECT 1 AS ok FROM events WHERE effect_id = ? AND kind = 'effect_applied' LIMIT 1", (s) => s.get(effectId)))); }

  reserveEffect(input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    return this.transaction((db) => this.reserveEffectWithin(db, input));
  }
  private reserveEffectWithin(db: Database, input: { taskId: string; effectId: string; kind: WorkflowEffectKind; originKey: string; sourceCompletionFingerprint?: string; prompt: string }): WorkflowSupervisorEffect {
    statement(db, 'INSERT OR IGNORE INTO effects(effect_id,task_id,kind,origin_key,source_completion_fingerprint,prompt_text,created_at) VALUES (?,?,?,?,?,?,?)', (s) => s.run(input.effectId, input.taskId, input.kind, input.originKey, input.sourceCompletionFingerprint ?? null, input.prompt, now()));
    const row = statement(db, 'SELECT * FROM effects WHERE origin_key = ?', (s) => s.get(input.originKey)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_RESERVE_FAILED');
    return effectFromRow(row);
  }

  recordEffectObservation(effectId: string, observationId: string, outcome: WorkflowEffectOutcome, evidence: Record<string, unknown> = {}): void {
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
