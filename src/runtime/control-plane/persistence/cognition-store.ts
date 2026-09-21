import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScopeRef } from '../../../../packages/kernel/identity/api/index';
import {
  activateMemory,
  cognitiveTerms,
  memoryAddressKey,
  validateMemoryEdge,
  validateMemoryPayloadRef,
  validateMemoryUnit,
  type ActivationOptions,
  type ActivationPack,
  type CognitiveMemoryStorePort,
  type CognitiveReadPort,
  type MemoryAddress,
  type MemoryEdge,
  type MemoryPayloadRef,
  type MemoryUnit,
} from '../../../../packages/kernel/cognition/api/index';
import {
  controlPlaneDatabasePath,
  withControlPlaneReadDatabase,
  withControlPlaneTransaction,
  type SqliteDatabase,
} from './sqlite-store';

export const COGNITION_STORE_SCHEMA_VERSION = 1 as const;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const CANONICAL_TABLES = [
  'cognition_memory_units',
  'cognition_memory_evidence',
  'cognition_memory_edges',
] as const;
const CONCEPT_INDEX_TABLE = 'cognition_concept_index' as const;
const TERM_INDEX_TABLE = 'cognition_term_index' as const;

interface Statement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): unknown;
  finalize?(): void;
}

function statement<T>(database: SqliteDatabase, sql: string, operation: (prepared: Statement) => T): T {
  const prepared = database.prepare(sql) as Statement;
  try { return operation(prepared); } finally { prepared.finalize?.(); }
}

function scopeKey(scope: ScopeRef): [string, string] {
  return [scope.kind, scope.id];
}

function tablesAvailable(database: SqliteDatabase, tables: readonly string[]): boolean {
  const placeholders = tables.map(() => '?').join(',');
  const row = statement(database,
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    prepared => prepared.get(...tables) as { count?: number } | undefined);
  return Number(row?.count ?? 0) === tables.length;
}

function canonicalSchemaAvailable(database: SqliteDatabase): boolean {
  return tablesAvailable(database, CANONICAL_TABLES);
}

function conceptIndexAvailable(database: SqliteDatabase): boolean {
  return tablesAvailable(database, [CONCEPT_INDEX_TABLE]);
}

function termIndexAvailable(database: SqliteDatabase): boolean {
  return tablesAvailable(database, [TERM_INDEX_TABLE]);
}

function derivedIndexesHealthy(database: SqliteDatabase): boolean {
  if (!conceptIndexAvailable(database) || !termIndexAvailable(database)) return false;
  try {
    statement(database,
      'SELECT scope_kind, scope_id, concept_id, memory_id FROM cognition_concept_index LIMIT 1',
      prepared => prepared.get());
    statement(database,
      'SELECT scope_kind, scope_id, term, memory_id FROM cognition_term_index LIMIT 1',
      prepared => prepared.get());
    return true;
  } catch {
    return false;
  }
}

function ensureSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cognition_memory_units (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      canonical_text TEXT NOT NULL,
      facets_json TEXT NOT NULL,
      concepts_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      utility REAL NOT NULL,
      tier TEXT NOT NULL,
      payload_digest TEXT,
      payload_media_type TEXT,
      payload_bytes INTEGER,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      source_work_id TEXT,
      source_round_id TEXT,
      recorded_at TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      expires_at TEXT,
      supersedes_id TEXT,
      retracted_at TEXT,
      retraction_reason TEXT,
      PRIMARY KEY (scope_kind, scope_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS cognition_memory_units_rank
      ON cognition_memory_units (scope_kind, scope_id, tier, utility DESC, confidence DESC, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS cognition_memory_evidence (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_id, memory_id, evidence_ref, evidence_kind),
      FOREIGN KEY (scope_kind, scope_id, memory_id)
        REFERENCES cognition_memory_units(scope_kind, scope_id, memory_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cognition_memory_evidence_ref ON cognition_memory_evidence (evidence_ref);

    CREATE TABLE IF NOT EXISTS cognition_memory_edges (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      from_memory_id TEXT NOT NULL,
      to_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      source_work_id TEXT,
      source_round_id TEXT,
      recorded_at TEXT NOT NULL,
      expires_at TEXT,
      retracted_at TEXT,
      PRIMARY KEY (scope_kind, scope_id, edge_id)
    );
    CREATE INDEX IF NOT EXISTS cognition_memory_edges_from
      ON cognition_memory_edges (scope_kind, scope_id, from_memory_id);
    CREATE INDEX IF NOT EXISTS cognition_memory_edges_to
      ON cognition_memory_edges (scope_kind, scope_id, to_memory_id);

    CREATE TABLE IF NOT EXISTS cognition_concept_index (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_id, concept_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS cognition_concept_lookup
      ON cognition_concept_index (scope_kind, scope_id, concept_id);

    CREATE TABLE IF NOT EXISTS cognition_term_index (
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      term TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_id, term, memory_id)
    );
    CREATE INDEX IF NOT EXISTS cognition_term_lookup
      ON cognition_term_index (scope_kind, scope_id, term);
  `);
}

function rowToMemory(row: Record<string, unknown>, evidenceRefs: string[], counterEvidenceRefs: string[]): MemoryUnit {
  const payloadDigest = row.payload_digest as string | null;
  const payloadRef: MemoryPayloadRef | undefined = payloadDigest ? validateMemoryPayloadRef({
    algorithm: 'sha256',
    digest: payloadDigest,
    mediaType: row.payload_media_type as string,
    bytes: Number(row.payload_bytes),
  }) : undefined;
  return validateMemoryUnit({
    schemaVersion: 1,
    id: row.memory_id as string,
    revision: Number(row.revision),
    scope: { schemaVersion: 1, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string },
    facets: JSON.parse(row.facets_json as string) as string[],
    canonicalText: row.canonical_text as string,
    concepts: JSON.parse(row.concepts_json as string) as string[],
    ...(payloadRef ? { payloadRef } : {}),
    provenance: {
      sourceKind: row.source_kind as MemoryUnit['provenance']['sourceKind'],
      ...(row.source_id ? { sourceId: row.source_id as string } : {}),
      ...(row.source_work_id ? { sourceWorkId: row.source_work_id as string } : {}),
      ...(row.source_round_id ? { sourceRoundId: row.source_round_id as string } : {}),
      recordedAt: row.recorded_at as string,
      evidenceRefs,
    },
    confidence: Number(row.confidence),
    utility: Number(row.utility),
    tier: row.tier as MemoryUnit['tier'],
    validFrom: row.valid_from as string,
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id as string } : {}),
    counterEvidenceRefs,
    ...(row.retracted_at ? { retractedAt: row.retracted_at as string, retractionReason: row.retraction_reason as string } : {}),
  });
}

function evidenceFor(database: SqliteDatabase, scope: ScopeRef, memoryId: string): { evidence: string[]; counter: string[] } {
  const [kind, id] = scopeKey(scope);
  const rows = statement(database,
    `SELECT evidence_ref, evidence_kind FROM cognition_memory_evidence
     WHERE scope_kind = ? AND scope_id = ? AND memory_id = ?
     ORDER BY evidence_kind, evidence_ref`,
    prepared => prepared.all(kind, id, memoryId) as Array<{ evidence_ref: string; evidence_kind: string }>);
  return {
    evidence: rows.filter(row => row.evidence_kind === 'support').map(row => row.evidence_ref),
    counter: rows.filter(row => row.evidence_kind === 'counter').map(row => row.evidence_ref),
  };
}

function readMemory(database: SqliteDatabase, scope: ScopeRef, memoryId: string): MemoryUnit | undefined {
  if (!canonicalSchemaAvailable(database)) return undefined;
  const [kind, id] = scopeKey(scope);
  const row = statement(database,
    `SELECT * FROM cognition_memory_units WHERE scope_kind = ? AND scope_id = ? AND memory_id = ?`,
    prepared => prepared.get(kind, id, memoryId) as Record<string, unknown> | undefined);
  if (!row) return undefined;
  const refs = evidenceFor(database, scope, memoryId);
  return rowToMemory(row, refs.evidence, refs.counter);
}

function readAddresses(database: SqliteDatabase, addresses: readonly MemoryAddress[]): MemoryUnit[] {
  if (!addresses.length || !canonicalSchemaAvailable(database)) return [];
  const unique = [...new Map(addresses.map(address => [memoryAddressKey(address), address])).values()].slice(0, 512);
  const predicate = unique.map(() => '(scope_kind = ? AND scope_id = ? AND memory_id = ?)').join(' OR ');
  const params = unique.flatMap(address => [address.scope.kind, address.scope.id, address.id]);
  const rows = statement(database,
    `SELECT * FROM cognition_memory_units WHERE ${predicate}`,
    prepared => prepared.all(...params) as Array<Record<string, unknown>>);
  return rows.map(row => {
    const scope = { schemaVersion: 1 as const, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string };
    const refs = evidenceFor(database, scope, row.memory_id as string);
    return rowToMemory(row, refs.evidence, refs.counter);
  });
}

function readByIds(database: SqliteDatabase, scopes: readonly ScopeRef[], ids: readonly string[]): MemoryUnit[] {
  const addresses = scopes.flatMap(scope => [...new Set(ids)].slice(0, 512).map(id => ({ scope, id })));
  return readAddresses(database, addresses);
}

function replaceDerivedIndexes(database: SqliteDatabase, memory: MemoryUnit): void {
  const [kind, id] = scopeKey(memory.scope);
  statement(database,
    `DELETE FROM cognition_concept_index WHERE scope_kind = ? AND scope_id = ? AND memory_id = ?`,
    prepared => prepared.run(kind, id, memory.id));
  statement(database,
    `DELETE FROM cognition_term_index WHERE scope_kind = ? AND scope_id = ? AND memory_id = ?`,
    prepared => prepared.run(kind, id, memory.id));

  const concepts = database.prepare(
    `INSERT OR IGNORE INTO cognition_concept_index (scope_kind, scope_id, concept_id, memory_id) VALUES (?, ?, ?, ?)`) as Statement;
  const terms = database.prepare(
    `INSERT OR IGNORE INTO cognition_term_index (scope_kind, scope_id, term, memory_id) VALUES (?, ?, ?, ?)`) as Statement;
  try {
    for (const concept of memory.concepts) concepts.run(kind, id, concept, memory.id);
    for (const term of cognitiveTerms(`${memory.canonicalText}\n${memory.concepts.join(' ')}\n${memory.facets.join(' ')}`)) {
      terms.run(kind, id, term, memory.id);
    }
  } finally {
    concepts.finalize?.();
    terms.finalize?.();
  }
}

function writeCognitiveMemoryUnitWithinTransaction(
  database: SqliteDatabase,
  memory: MemoryUnit,
  expectedRevision?: number | null,
): MemoryUnit {
  ensureSchema(database);
  validateMemoryUnit(memory);
  const existing = readMemory(database, memory.scope, memory.id);
  if (expectedRevision !== undefined) {
    const matches = expectedRevision === null ? existing === undefined : existing?.revision === expectedRevision;
    if (!matches) throw new Error('COGNITION_MEMORY_REVISION_CONFLICT');
  }
  const requiredRevision = (existing?.revision ?? 0) + 1;
  if (memory.revision !== requiredRevision) throw new Error('COGNITION_MEMORY_REVISION_INVALID');

  const [kind, id] = scopeKey(memory.scope);
  statement(database, `
    INSERT INTO cognition_memory_units (
      scope_kind, scope_id, memory_id, schema_version, revision, canonical_text, facets_json, concepts_json,
      confidence, utility, tier, payload_digest, payload_media_type, payload_bytes, source_kind, source_id,
      source_work_id, source_round_id, recorded_at, valid_from, expires_at, supersedes_id, retracted_at, retraction_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_kind, scope_id, memory_id) DO UPDATE SET
      schema_version=excluded.schema_version, revision=excluded.revision, canonical_text=excluded.canonical_text,
      facets_json=excluded.facets_json, concepts_json=excluded.concepts_json, confidence=excluded.confidence,
      utility=excluded.utility, tier=excluded.tier, payload_digest=excluded.payload_digest,
      payload_media_type=excluded.payload_media_type, payload_bytes=excluded.payload_bytes,
      source_kind=excluded.source_kind, source_id=excluded.source_id, source_work_id=excluded.source_work_id,
      source_round_id=excluded.source_round_id, recorded_at=excluded.recorded_at, valid_from=excluded.valid_from,
      expires_at=excluded.expires_at, supersedes_id=excluded.supersedes_id, retracted_at=excluded.retracted_at,
      retraction_reason=excluded.retraction_reason`, prepared => prepared.run(
    kind, id, memory.id, memory.schemaVersion, memory.revision, memory.canonicalText,
    JSON.stringify(memory.facets), JSON.stringify(memory.concepts), memory.confidence, memory.utility, memory.tier,
    memory.payloadRef?.digest ?? null, memory.payloadRef?.mediaType ?? null, memory.payloadRef?.bytes ?? null,
    memory.provenance.sourceKind, memory.provenance.sourceId ?? null, memory.provenance.sourceWorkId ?? null,
    memory.provenance.sourceRoundId ?? null, memory.provenance.recordedAt, memory.validFrom, memory.expiresAt ?? null,
    memory.supersedesId ?? null, memory.retractedAt ?? null, memory.retractionReason ?? null));

  statement(database,
    `DELETE FROM cognition_memory_evidence WHERE scope_kind = ? AND scope_id = ? AND memory_id = ?`,
    prepared => prepared.run(kind, id, memory.id));
  const evidence = database.prepare(
    `INSERT OR IGNORE INTO cognition_memory_evidence (scope_kind, scope_id, memory_id, evidence_ref, evidence_kind)
     VALUES (?, ?, ?, ?, ?)`) as Statement;
  try {
    for (const ref of memory.provenance.evidenceRefs) evidence.run(kind, id, memory.id, ref, 'support');
    for (const ref of memory.counterEvidenceRefs) evidence.run(kind, id, memory.id, ref, 'counter');
  } finally {
    evidence.finalize?.();
  }
  replaceDerivedIndexes(database, memory);
  return memory;
}

function writeCognitiveMemoryEdgeWithinTransaction(database: SqliteDatabase, edge: MemoryEdge): MemoryEdge {
  ensureSchema(database);
  validateMemoryEdge(edge);
  if (!readMemory(database, edge.scope, edge.fromId) || !readMemory(database, edge.scope, edge.toId)) {
    throw new Error('COGNITION_EDGE_ENDPOINT_MISSING');
  }
  const [kind, id] = scopeKey(edge.scope);
  statement(database, `
    INSERT INTO cognition_memory_edges (
      scope_kind, scope_id, edge_id, from_memory_id, to_memory_id, relation, weight, evidence_json,
      source_work_id, source_round_id, recorded_at, expires_at, retracted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_kind, scope_id, edge_id) DO UPDATE SET
      from_memory_id=excluded.from_memory_id, to_memory_id=excluded.to_memory_id,
      relation=excluded.relation, weight=excluded.weight, evidence_json=excluded.evidence_json,
      source_work_id=excluded.source_work_id, source_round_id=excluded.source_round_id,
      recorded_at=excluded.recorded_at, expires_at=excluded.expires_at, retracted_at=excluded.retracted_at`,
    prepared => prepared.run(kind, id, edge.id, edge.fromId, edge.toId, edge.relation, edge.weight,
      JSON.stringify(edge.evidenceRefs), edge.sourceWorkId ?? null, edge.sourceRoundId ?? null,
      edge.recordedAt, edge.expiresAt ?? null, edge.retractedAt ?? null));
  return edge;
}

/** Trusted persistence port. Callers still require a CognitiveWriteAuthorityPort. */
export function cognitionMemoryStore(controllerHome: string): CognitiveMemoryStorePort {
  let transaction: SqliteDatabase | undefined;
  return {
    transaction(operation) {
      if (transaction) return operation();
      return withControlPlaneTransaction(controllerHome, database => {
        transaction = database;
        try { return operation(); } finally { transaction = undefined; }
      });
    },
    read(scope, id) {
      if (transaction) return readMemory(transaction, scope, id);
      return withControlPlaneReadDatabase(controllerHome, database => readMemory(database, scope, id));
    },
    write(memory, expectedRevision) {
      if (!transaction) throw new Error('COGNITION_TRANSACTION_REQUIRED');
      return writeCognitiveMemoryUnitWithinTransaction(transaction, memory, expectedRevision);
    },
    writeEdge(edge) {
      if (!transaction) throw new Error('COGNITION_TRANSACTION_REQUIRED');
      return writeCognitiveMemoryEdgeWithinTransaction(transaction, edge);
    },
  };
}

function casRoot(controllerHome: string): string {
  return join(dirname(controlPlaneDatabasePath(controllerHome)), 'cognition-cas', 'sha256');
}

export function putCognitivePayload(
  controllerHome: string,
  payload: Uint8Array | string,
  mediaType = 'text/plain; charset=utf-8',
): MemoryPayloadRef {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error('COGNITION_PAYLOAD_TOO_LARGE');
  const ref = validateMemoryPayloadRef({
    algorithm: 'sha256',
    digest: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
    bytes: bytes.byteLength,
  });
  const root = casRoot(controllerHome);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, ref.digest);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  if (!existsSync(target)) {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    try {
      renameSync(temp, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  return ref;
}

export function readCognitivePayload(controllerHome: string, input: MemoryPayloadRef): Buffer {
  const ref = validateMemoryPayloadRef(input);
  const bytes = readFileSync(join(casRoot(controllerHome), ref.digest));
  if (bytes.byteLength !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.digest) {
    throw new Error('COGNITION_PAYLOAD_CORRUPT');
  }
  return bytes;
}

function scopePredicate(scopes: readonly ScopeRef[]): { sql: string; params: unknown[] } {
  if (!scopes.length) return { sql: '0', params: [] };
  return {
    sql: scopes.map(() => '(scope_kind = ? AND scope_id = ?)').join(' OR '),
    params: scopes.flatMap(scope => [scope.kind, scope.id]),
  };
}

function readPortForDatabase(database: SqliteDatabase): CognitiveReadPort {
  return {
    readByIds(scopes, ids) {
      return readByIds(database, scopes, [...new Set(ids)].slice(0, 512));
    },
    readByAddresses(addresses) {
      return readAddresses(database, addresses);
    },
    exactByConcept(scopes, concepts, limit, activeAt = new Date().toISOString()) {
      if (!conceptIndexAvailable(database) || !scopes.length || !concepts.length) return [];
      const scope = scopePredicate(scopes);
      const uniqueConcepts = [...new Set(concepts)].slice(0, 128);
      const placeholders = uniqueConcepts.map(() => '?').join(',');
      const rows = statement(database, `
        SELECT scope_kind, scope_id, memory_id, COUNT(*) AS hits
        FROM cognition_concept_index c
        WHERE (${scope.sql}) AND concept_id IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM cognition_memory_units m
            WHERE m.scope_kind = c.scope_kind AND m.scope_id = c.scope_id AND m.memory_id = c.memory_id
              AND m.retracted_at IS NULL AND m.valid_from <= ? AND (m.expires_at IS NULL OR m.expires_at > ?)
          )
        GROUP BY scope_kind, scope_id, memory_id
        ORDER BY hits DESC, scope_kind ASC, scope_id ASC, memory_id ASC
        LIMIT ?`, prepared => prepared.all(...scope.params, ...uniqueConcepts, activeAt, activeAt, limit) as Array<{ scope_kind: ScopeRef['kind']; scope_id: string; memory_id: string }>);
      return readAddresses(database, rows.map(row => ({ scope: { schemaVersion: 1, kind: row.scope_kind, id: row.scope_id }, id: row.memory_id })));
    },
    lexical(scopes, terms, limit, activeAt = new Date().toISOString()) {
      if (!termIndexAvailable(database) || !scopes.length || !terms.length) return [];
      const scope = scopePredicate(scopes);
      const uniqueTerms = [...new Set(terms)].slice(0, 128);
      const placeholders = uniqueTerms.map(() => '?').join(',');
      const rows = statement(database, `
        SELECT scope_kind, scope_id, memory_id, COUNT(*) AS hits
        FROM cognition_term_index t
        WHERE (${scope.sql}) AND term IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM cognition_memory_units m
            WHERE m.scope_kind = t.scope_kind AND m.scope_id = t.scope_id AND m.memory_id = t.memory_id
              AND m.retracted_at IS NULL AND m.valid_from <= ? AND (m.expires_at IS NULL OR m.expires_at > ?)
          )
        GROUP BY scope_kind, scope_id, memory_id
        ORDER BY hits DESC, scope_kind ASC, scope_id ASC, memory_id ASC
        LIMIT ?`, prepared => prepared.all(...scope.params, ...uniqueTerms, activeAt, activeAt, limit) as Array<{ scope_kind: ScopeRef['kind']; scope_id: string; memory_id: string }>);
      return readAddresses(database, rows.map(row => ({ scope: { schemaVersion: 1, kind: row.scope_kind, id: row.scope_id }, id: row.memory_id })));
    },
    neighbors(seeds, limit, activeAt = new Date().toISOString()) {
      if (!canonicalSchemaAvailable(database) || !seeds.length) return [];
      const uniqueSeeds = [...new Map(seeds.map(seed => [memoryAddressKey(seed), seed])).values()].slice(0, 128);
      const seedValues = uniqueSeeds.map(() => '(?, ?, ?)').join(',');
      const seedParams = uniqueSeeds.flatMap(seed => [seed.scope.kind, seed.scope.id, seed.id]);
      const rows = statement(database, `
        WITH seeds(scope_kind, scope_id, memory_id) AS (VALUES ${seedValues})
        SELECT e.*, s.memory_id AS seed_memory_id,
          CASE WHEN e.from_memory_id = s.memory_id THEN e.to_memory_id ELSE e.from_memory_id END AS target_memory_id
        FROM seeds s
        JOIN cognition_memory_edges e
          ON e.scope_kind = s.scope_kind AND e.scope_id = s.scope_id
          AND (e.from_memory_id = s.memory_id OR e.to_memory_id = s.memory_id)
        JOIN cognition_memory_units m
          ON m.scope_kind = e.scope_kind AND m.scope_id = e.scope_id
          AND m.memory_id = CASE WHEN e.from_memory_id = s.memory_id THEN e.to_memory_id ELSE e.from_memory_id END
        WHERE e.retracted_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > ?)
          AND m.retracted_at IS NULL AND m.valid_from <= ? AND (m.expires_at IS NULL OR m.expires_at > ?)
        ORDER BY e.weight DESC, e.recorded_at DESC, e.scope_kind ASC, e.scope_id ASC, e.edge_id ASC, s.memory_id ASC
        LIMIT ?`, prepared => prepared.all(...seedParams, activeAt, activeAt, activeAt, limit) as Array<Record<string, unknown>>);
      const seedKeys = new Map(uniqueSeeds.map(seed => [memoryAddressKey(seed), seed]));
      const expansions: Array<{ edge: MemoryEdge; from: MemoryAddress; target: MemoryAddress }> = [];
      for (const row of rows) {
        const scope = { schemaVersion: 1 as const, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string };
        const seed = seedKeys.get(memoryAddressKey({ scope, id: row.seed_memory_id as string }));
        if (!seed) continue;
        const target = { scope, id: row.target_memory_id as string };
        const edge = validateMemoryEdge({
          schemaVersion: 1,
          id: row.edge_id as string,
          scope,
          fromId: row.from_memory_id as string,
          toId: row.to_memory_id as string,
          relation: row.relation as string,
          weight: Number(row.weight),
          evidenceRefs: JSON.parse(row.evidence_json as string) as string[],
          ...(row.source_work_id ? { sourceWorkId: row.source_work_id as string } : {}),
          ...(row.source_round_id ? { sourceRoundId: row.source_round_id as string } : {}),
          recordedAt: row.recorded_at as string,
          ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
          ...(row.retracted_at ? { retractedAt: row.retracted_at as string } : {}),
        });
        expansions.push({ edge, from: seed, target });
      }
      const memoryByAddress = new Map(readAddresses(database, expansions.map(item => item.target))
        .map(memory => [memoryAddressKey({ scope: memory.scope, id: memory.id }), memory]));
      return expansions.flatMap(item => {
        const memory = memoryByAddress.get(memoryAddressKey(item.target));
        return memory ? [{ edge: item.edge, from: item.from, memory }] : [];
      });
    },
  };
}


export interface CognitiveAuditQuery {
  scopes: readonly ScopeRef[];
  query?: string;
  memoryId?: string;
  concept?: string;
  facet?: string;
  sourceKind?: MemoryUnit['provenance']['sourceKind'];
  sourceWorkId?: string;
  limit?: number;
}

export interface CognitiveAuditEntry {
  memory: MemoryUnit;
  relations: MemoryEdge[];
}

export interface CognitiveAuditResult {
  items: CognitiveAuditEntry[];
  inspected: number;
  truncated: boolean;
}

function auditEdgeFromRow(row: Record<string, unknown>): MemoryEdge {
  return validateMemoryEdge({
    schemaVersion: 1,
    id: row.edge_id as string,
    scope: { schemaVersion: 1, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string },
    fromId: row.from_memory_id as string,
    toId: row.to_memory_id as string,
    relation: row.relation as string,
    weight: Number(row.weight),
    evidenceRefs: JSON.parse(row.evidence_json as string) as string[],
    ...(row.source_work_id ? { sourceWorkId: row.source_work_id as string } : {}),
    ...(row.source_round_id ? { sourceRoundId: row.source_round_id as string } : {}),
    recordedAt: row.recorded_at as string,
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
    ...(row.retracted_at ? { retractedAt: row.retracted_at as string } : {}),
  });
}

export function auditCognitiveMemory(controllerHome: string, input: CognitiveAuditQuery): CognitiveAuditResult {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 24), 100));
  const uniqueScopes = [...new Map(input.scopes.map(scope => [`${scope.kind}:${scope.id}`, scope])).values()].slice(0, 32);
  if (!uniqueScopes.length) return { items: [], inspected: 0, truncated: false };
  return withControlPlaneReadDatabase(controllerHome, database => {
    if (!canonicalSchemaAvailable(database)) return { items: [], inspected: 0, truncated: false };
    const scopePredicate = uniqueScopes.map(() => '(scope_kind = ? AND scope_id = ?)').join(' OR ');
    const params: unknown[] = uniqueScopes.flatMap(scope => [scope.kind, scope.id]);
    const clauses = [`(${scopePredicate})`];
    if (input.memoryId?.trim()) {
      clauses.push('memory_id = ?');
      params.push(input.memoryId.trim());
    }
    if (input.sourceKind) {
      clauses.push('source_kind = ?');
      params.push(input.sourceKind);
    }
    if (input.sourceWorkId?.trim()) {
      clauses.push('source_work_id = ?');
      params.push(input.sourceWorkId.trim());
    }
    const scanLimit = Math.min(512, Math.max(limit * 8, 64));
    const rows = statement(database, `
      SELECT * FROM cognition_memory_units
      WHERE ${clauses.join(' AND ')}
      ORDER BY utility DESC, confidence DESC, recorded_at DESC, scope_kind ASC, scope_id ASC, memory_id ASC
      LIMIT ?`, prepared => prepared.all(...params, scanLimit) as Array<Record<string, unknown>>);
    const exactMemoryId = input.memoryId?.trim();
    const queryTerms = cognitiveTerms(input.query?.slice(0, 8_192) ?? '');
    const concept = input.concept?.trim();
    const facet = input.facet?.trim();
    const memories = rows.map(row => {
      const scope = { schemaVersion: 1 as const, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string };
      const refs = evidenceFor(database, scope, row.memory_id as string);
      return rowToMemory(row, refs.evidence, refs.counter);
    }).filter(memory => !concept || memory.concepts.includes(concept))
      .filter(memory => !facet || memory.facets.includes(facet))
      .filter(memory => {
        if (!queryTerms.size || exactMemoryId === memory.id) return true;
        const terms = cognitiveTerms([
          memory.id,
          memory.canonicalText,
          ...memory.concepts,
          ...memory.facets,
          memory.provenance.sourceId ?? '',
          memory.provenance.sourceWorkId ?? '',
          memory.provenance.sourceRoundId ?? '',
        ].join('\n'));
        for (const term of queryTerms) if (terms.has(term)) return true;
        return false;
      });
    const selected = memories.slice(0, limit);
    const relationRows = selected.length ? statement(database, `
      SELECT * FROM cognition_memory_edges
      WHERE ${selected.map(() => '(scope_kind = ? AND scope_id = ? AND (from_memory_id = ? OR to_memory_id = ?))').join(' OR ')}
      ORDER BY recorded_at DESC, weight DESC, edge_id ASC
      LIMIT 512`, prepared => prepared.all(...selected.flatMap(memory => [
        memory.scope.kind, memory.scope.id, memory.id, memory.id,
      ])) as Array<Record<string, unknown>>) : [];
    const relations = relationRows.map(auditEdgeFromRow);
    return {
      items: selected.map(memory => ({
        memory,
        relations: relations.filter(edge => edge.scope.kind === memory.scope.kind
          && edge.scope.id === memory.scope.id
          && (edge.fromId === memory.id || edge.toId === memory.id)).slice(0, 32),
      })),
      inspected: rows.length,
      truncated: memories.length > limit || rows.length >= scanLimit,
    };
  });
}

export function cognitionReadPort(controllerHome: string): CognitiveReadPort {
  return {
    readByIds: (scopes, ids) => withControlPlaneReadDatabase(controllerHome, database => readPortForDatabase(database).readByIds(scopes, ids)),
    readByAddresses: addresses => withControlPlaneReadDatabase(controllerHome, database => readPortForDatabase(database).readByAddresses(addresses)),
    exactByConcept: (scopes, concepts, limit, activeAt) => withControlPlaneReadDatabase(controllerHome, database => readPortForDatabase(database).exactByConcept(scopes, concepts, limit, activeAt)),
    lexical: (scopes, terms, limit, activeAt) => withControlPlaneReadDatabase(controllerHome, database => readPortForDatabase(database).lexical(scopes, terms, limit, activeAt)),
    neighbors: (seeds, limit, activeAt) => withControlPlaneReadDatabase(controllerHome, database => readPortForDatabase(database).neighbors(seeds, limit, activeAt)),
  };
}

export function activateCognitiveMemory(
  controllerHome: string,
  scopes: readonly ScopeRef[],
  query: string,
  options: ActivationOptions = {},
): ActivationPack {
  const derivedState = withControlPlaneReadDatabase(controllerHome, database => {
    if (!canonicalSchemaAvailable(database)) return 'empty' as const;
    return derivedIndexesHealthy(database) ? 'ready' as const : 'degraded' as const;
  });
  let rebuilt = false;
  if (derivedState === 'degraded') {
    try {
      rebuildCognitionDerivedIndexes(controllerHome);
      rebuilt = true;
    } catch (error) {
      throw new Error(`COGNITION_DERIVED_INDEX_RECOVERY_FAILED:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const pack = withControlPlaneReadDatabase(controllerHome, database =>
    activateMemory(readPortForDatabase(database), scopes, query, options));
  return rebuilt ? { ...pack, gaps: [...new Set([...pack.gaps, 'derived_index_rebuilt'])] } : pack;
}

export function rebuildCognitionDerivedIndexes(controllerHome: string): number {
  return withControlPlaneTransaction(controllerHome, database => {
    database.exec(`
      DROP INDEX IF EXISTS cognition_concept_lookup;
      DROP INDEX IF EXISTS cognition_term_lookup;
      DROP TABLE IF EXISTS cognition_concept_index;
      DROP TABLE IF EXISTS cognition_term_index;
    `);
    ensureSchema(database);
    const rows = statement(database,
      'SELECT * FROM cognition_memory_units ORDER BY scope_kind, scope_id, memory_id',
      prepared => prepared.all() as Array<Record<string, unknown>>);
    for (const row of rows) {
      const scope = { schemaVersion: 1 as const, kind: row.scope_kind as ScopeRef['kind'], id: row.scope_id as string };
      const refs = evidenceFor(database, scope, row.memory_id as string);
      replaceDerivedIndexes(database, rowToMemory(row, refs.evidence, refs.counter));
    }
    return rows.length;
  });
}
