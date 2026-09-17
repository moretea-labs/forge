import type { ScopeRef } from '../../identity/api/index';

export const COGNITIVE_MEMORY_SCHEMA_VERSION = 1 as const;
export const COGNITIVE_IR_VERSION = 'forge-cognitive-ir/v1' as const;

export type MemoryTier = 'hot' | 'warm' | 'cold';
export type MemorySourceKind = 'experience' | 'outcome' | 'knowledge' | 'controller' | 'system' | 'external';

/** Open vocabulary on purpose: memory facets are descriptive, not lifecycle authority. */
export type MemoryFacet = string;
export type MemoryRelation = string;

export interface MemoryPayloadRef {
  algorithm: 'sha256';
  digest: string;
  mediaType: string;
  bytes: number;
}

export interface MemoryAddress {
  scope: ScopeRef;
  id: string;
}

export interface MemoryProvenance {
  sourceKind: MemorySourceKind;
  sourceId?: string;
  sourceWorkId?: string;
  sourceRoundId?: string;
  recordedAt: string;
  evidenceRefs: string[];
}

export interface MemoryUnit {
  schemaVersion: typeof COGNITIVE_MEMORY_SCHEMA_VERSION;
  id: string;
  revision: number;
  scope: ScopeRef;
  facets: MemoryFacet[];
  canonicalText: string;
  concepts: string[];
  payloadRef?: MemoryPayloadRef;
  provenance: MemoryProvenance;
  confidence: number;
  utility: number;
  tier: MemoryTier;
  validFrom: string;
  expiresAt?: string;
  supersedesId?: string;
  counterEvidenceRefs: string[];
  retractedAt?: string;
  retractionReason?: string;
}

export interface MemoryEdge {
  schemaVersion: typeof COGNITIVE_MEMORY_SCHEMA_VERSION;
  id: string;
  scope: ScopeRef;
  fromId: string;
  toId: string;
  relation: MemoryRelation;
  weight: number;
  evidenceRefs: string[];
  sourceWorkId?: string;
  sourceRoundId?: string;
  recordedAt: string;
  expiresAt?: string;
  retractedAt?: string;
}

export type MemoryEdgeDraft = Omit<MemoryEdge, 'schemaVersion'>;

export interface CognitiveIRFact {
  subject: string;
  predicate: string;
  object?: string;
  value?: string | number | boolean;
  confidence?: number;
}

export interface CognitiveIR {
  version: typeof COGNITIVE_IR_VERSION;
  memoryId: string;
  concepts: string[];
  facts: CognitiveIRFact[];
  relations: Array<{ relation: string; targetId: string; weight: number }>;
  conditions: string[];
  evidenceRefs: string[];
}

export interface ActivationReason {
  signal: 'exact' | 'graph' | 'lexical' | 'semantic' | 'recency' | 'utility';
  score: number;
  detail: string;
}

export interface ActivationItem {
  memory: MemoryUnit;
  score: number;
  reasons: ActivationReason[];
  activationPath: string[];
}

export interface ActivationPack {
  schemaVersion: 1;
  query: string;
  generatedAt: string;
  items: ActivationItem[];
  gaps: string[];
  truncated: boolean;
  inspectedCandidates: number;
  estimatedBytes: number;
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;
const FACET = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const RELATION = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const VALID_SCOPE_KINDS: readonly ScopeRef['kind'][] = ['workspace', 'project', 'requirement', 'plan', 'plan_step', 'work'];

function requireText(value: string, label: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`COGNITION_${label}_INVALID`);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`COGNITION_${label}_INVALID`);
}

function requireScore(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`COGNITION_${label}_INVALID`);
}

function uniqueStrings(values: readonly string[], label: string, maxItems: number, pattern?: RegExp): void {
  if (!Array.isArray(values) || values.length > maxItems || new Set(values).size !== values.length) throw new Error(`COGNITION_${label}_INVALID`);
  for (const value of values) {
    requireText(value, label, 512);
    if (pattern && !pattern.test(value)) throw new Error(`COGNITION_${label}_INVALID`);
  }
}

export function validateCognitiveScope(scope: ScopeRef): ScopeRef {
  if (scope.schemaVersion !== 1 || !VALID_SCOPE_KINDS.includes(scope.kind)) throw new Error('COGNITION_SCOPE_INVALID');
  requireText(scope.id, 'SCOPE_ID', 512);
  return scope;
}

export function validateMemoryPayloadRef(ref: MemoryPayloadRef): MemoryPayloadRef {
  if (ref.algorithm !== 'sha256' || !DIGEST.test(ref.digest)) throw new Error('COGNITION_PAYLOAD_DIGEST_INVALID');
  requireText(ref.mediaType, 'PAYLOAD_MEDIA_TYPE', 128);
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('COGNITION_PAYLOAD_BYTES_INVALID');
  return ref;
}

export function memoryAddressKey(address: MemoryAddress): string {
  validateCognitiveScope(address.scope);
  requireText(address.id, 'MEMORY_ID', 512);
  return JSON.stringify([address.scope.kind, address.scope.id, address.id]);
}

export function memoryAddressOf(memory: MemoryUnit): MemoryAddress {
  return { scope: memory.scope, id: memory.id };
}

export function memoryAddressLabel(address: MemoryAddress): string {
  return `mem://${address.scope.kind}/${encodeURIComponent(address.scope.id)}/${encodeURIComponent(address.id)}`;
}

export function validateMemoryUnit(unit: MemoryUnit): MemoryUnit {
  if (unit.schemaVersion !== 1 || !Number.isSafeInteger(unit.revision) || unit.revision < 1) throw new Error('COGNITION_MEMORY_VERSION_INVALID');
  validateCognitiveScope(unit.scope);
  requireText(unit.id, 'MEMORY_ID', 512);
  requireText(unit.canonicalText, 'CANONICAL_TEXT', 8_192);
  uniqueStrings(unit.facets, 'FACET', 16, FACET);
  uniqueStrings(unit.concepts, 'CONCEPT', 64, IDENTIFIER);
  if (!unit.facets.length || !unit.concepts.length) throw new Error('COGNITION_MEMORY_CLASSIFICATION_REQUIRED');
  requireScore(unit.confidence, 'CONFIDENCE');
  requireScore(unit.utility, 'UTILITY');
  if (!['hot', 'warm', 'cold'].includes(unit.tier)) throw new Error('COGNITION_TIER_INVALID');
  requireTimestamp(unit.validFrom, 'VALID_FROM');
  requireTimestamp(unit.provenance.recordedAt, 'PROVENANCE_TIME');
  uniqueStrings(unit.provenance.evidenceRefs, 'EVIDENCE', 64);
  uniqueStrings(unit.counterEvidenceRefs, 'COUNTER_EVIDENCE', 64);
  if (unit.expiresAt) {
    requireTimestamp(unit.expiresAt, 'EXPIRY');
    if (Date.parse(unit.expiresAt) <= Date.parse(unit.validFrom)) throw new Error('COGNITION_EXPIRY_INVALID');
  }
  if (unit.payloadRef) validateMemoryPayloadRef(unit.payloadRef);
  if (unit.supersedesId) requireText(unit.supersedesId, 'SUPERSEDES_ID', 512);
  if (unit.retractedAt) {
    requireTimestamp(unit.retractedAt, 'RETRACTION_TIME');
    requireText(unit.retractionReason ?? '', 'RETRACTION_REASON', 1_000);
  }
  return unit;
}

export function validateMemoryEdge(edge: MemoryEdge): MemoryEdge {
  if (edge.schemaVersion !== 1) throw new Error('COGNITION_EDGE_VERSION_INVALID');
  validateCognitiveScope(edge.scope);
  requireText(edge.id, 'EDGE_ID', 512);
  requireText(edge.fromId, 'EDGE_FROM', 512);
  requireText(edge.toId, 'EDGE_TO', 512);
  if (edge.fromId === edge.toId) throw new Error('COGNITION_EDGE_SELF_INVALID');
  requireText(edge.relation, 'RELATION', 96);
  if (!RELATION.test(edge.relation)) throw new Error('COGNITION_RELATION_INVALID');
  requireScore(edge.weight, 'EDGE_WEIGHT');
  uniqueStrings(edge.evidenceRefs, 'EDGE_EVIDENCE', 64);
  requireTimestamp(edge.recordedAt, 'EDGE_TIME');
  if (edge.expiresAt) requireTimestamp(edge.expiresAt, 'EDGE_EXPIRY');
  if (edge.retractedAt) requireTimestamp(edge.retractedAt, 'EDGE_RETRACTION');
  return edge;
}

export function cognitiveTerms(text: string): Set<string> {
  const terms = new Set(text.toLocaleLowerCase('en-US').match(/[a-z0-9_.:/-]+/g) ?? []);
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) terms.add(run);
    for (let index = 0; index + 1 < chars.length; index++) terms.add(chars[index]! + chars[index + 1]!);
  }
  return terms;
}
