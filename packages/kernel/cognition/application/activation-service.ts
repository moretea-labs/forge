import type { ScopeRef } from '../../identity/api/index';
import {
  cognitiveTerms,
  memoryAddressKey,
  memoryAddressLabel,
  memoryAddressOf,
  type ActivationItem,
  type ActivationPack,
  type ActivationReason,
  type MemoryAddress,
  type MemoryEdge,
  type MemoryUnit,
} from '../domain/memory';

export interface CognitiveReadPort {
  readByIds(scopes: readonly ScopeRef[], ids: readonly string[]): MemoryUnit[];
  readByAddresses(addresses: readonly MemoryAddress[]): MemoryUnit[];
  exactByConcept(scopes: readonly ScopeRef[], concepts: readonly string[], limit: number, activeAt?: string): MemoryUnit[];
  lexical(scopes: readonly ScopeRef[], terms: readonly string[], limit: number, activeAt?: string): MemoryUnit[];
  neighbors(seeds: readonly MemoryAddress[], limit: number, activeAt?: string): Array<{ edge: MemoryEdge; from: MemoryAddress; memory: MemoryUnit }>;
}

export interface SemanticCandidate {
  address: MemoryAddress;
  score: number;
}

export interface CognitiveSemanticIndex {
  search(query: string, scopes: readonly ScopeRef[], limit: number): SemanticCandidate[];
}

export interface CognitiveUsageFeedback {
  address: MemoryAddress;
  usedCount: number;
  rejectedCount: number;
  conflictCount: number;
  staleCount: number;
}

export interface ActivationOptions {
  maxItems?: number;
  maxCandidates?: number;
  maxGraphDepth?: number;
  maxBytes?: number;
  /** Optional associative-cue floor for opportunistic recall. Explicit audits may leave it unset. */
  minCueScore?: number;
  now?: string;
  semantic?: CognitiveSemanticIndex;
  seedMemoryIds?: string[];
  seedConcepts?: string[];
  transientMemories?: readonly MemoryUnit[];
  /** Rebuildable retrieval feedback derived from canonical ControllerRound observations. */
  usageFeedback?: readonly CognitiveUsageFeedback[];
}

const DEFAULT_ITEMS = 16;
const DEFAULT_CANDIDATES = 96;
const DEFAULT_GRAPH_DEPTH = 2;
const DEFAULT_BYTES = 24 * 1024;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value < 1)) throw new Error('COGNITION_ACTIVATION_BUDGET_INVALID');
  return Math.min(Math.floor(value ?? fallback), maximum);
}

function boundedUnitScore(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`COGNITION_${label}_INVALID`);
  return value;
}

function associativeLexicalCueScore(memory: MemoryUnit, terms: ReadonlySet<string>): number {
  if (!terms.size) return 0;
  const haystack = cognitiveTerms(`${memory.canonicalText}\n${memory.concepts.join(' ')}\n${memory.facets.join(' ')}`);
  if (!haystack.size) return 0;
  let matches = 0;
  for (const term of terms) if (haystack.has(term)) matches += 1;
  // Automatic recall still rejects a single generic overlap, but a long
  // distilled memory must not become harder to recall merely because it has
  // more explanatory text. This especially matters for CJK bigram terms,
  // where one useful paragraph naturally has a much larger haystack. Require
  // at least two direct cue units before query coverage can qualify a memory;
  // otherwise retain the symmetric specificity score used for short/exact cues.
  const symmetricSpecificity = matches / Math.sqrt(terms.size * haystack.size);
  const multiCueQueryCoverage = matches >= 2 ? matches / terms.size : 0;
  return Math.max(symmetricSpecificity, multiCueQueryCoverage);
}

function retrievalCueScore(item: ActivationItem, queryTerms: ReadonlySet<string>): number {
  let score = associativeLexicalCueScore(item.memory, queryTerms);
  for (const reason of item.reasons) {
    if (reason.signal === 'exact' || reason.signal === 'semantic') {
      score = Math.max(score, reason.score);
    }
  }
  // Graph propagation may rank or explain an already-cued memory, but it
  // cannot by itself make a memory enter opportunistic awareness. Deliberate
  // memory audit leaves minCueScore at zero and still sees graph expansion.
  return score;
}

function active(memory: MemoryUnit, now: number): boolean {
  return !memory.retractedAt
    && (!memory.expiresAt || Date.parse(memory.expiresAt) > now)
    && Date.parse(memory.validFrom) <= now;
}

function lexicalScore(memory: MemoryUnit, terms: ReadonlySet<string>): number {
  const haystack = cognitiveTerms(`${memory.canonicalText}\n${memory.concepts.join(' ')}\n${memory.facets.join(' ')}`);
  let matches = 0;
  for (const term of terms) if (haystack.has(term)) matches += 1;
  return terms.size ? matches / terms.size : 0;
}

function recencyScore(memory: MemoryUnit, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(memory.provenance.recordedAt)) / 86_400_000);
  return 1 / (1 + ageDays / 90);
}

function addReason(item: ActivationItem, reason: ActivationReason): void {
  const existing = item.reasons.find(candidate => candidate.signal === reason.signal && candidate.detail === reason.detail);
  if (existing) existing.score = Math.max(existing.score, reason.score);
  else item.reasons.push(reason);
}

function graphRelationFactor(edge: MemoryEdge, from: MemoryAddress): number {
  if (edge.relation === 'supports') return 1;
  if (edge.relation === 'derived_from') return 0.85;
  if (edge.relation === 'analogous_to') return 0.55;
  if (edge.relation === 'contradicts') return 0.4;
  if (edge.relation === 'supersedes') return from.id === edge.toId ? 1 : 0.2;
  return 0.65;
}

function ensureCandidate(map: Map<string, ActivationItem>, memory: MemoryUnit): ActivationItem {
  const key = memoryAddressKey(memoryAddressOf(memory));
  let item = map.get(key);
  if (!item) {
    item = { memory, score: 0, reasons: [], activationPath: [memoryAddressLabel(memoryAddressOf(memory))] };
    map.set(key, item);
  }
  return item;
}

export function activateMemory(
  port: CognitiveReadPort,
  scopes: readonly ScopeRef[],
  query: string,
  options: ActivationOptions = {},
): ActivationPack {
  const maxItems = bounded(options.maxItems, DEFAULT_ITEMS, 32);
  const maxCandidates = bounded(options.maxCandidates, DEFAULT_CANDIDATES, 512);
  const maxGraphDepth = bounded(options.maxGraphDepth, DEFAULT_GRAPH_DEPTH, 4);
  const maxBytes = bounded(options.maxBytes, DEFAULT_BYTES, 64 * 1024);
  const minCueScore = boundedUnitScore(options.minCueScore, 'ACTIVATION_MIN_CUE_SCORE');
  const nowText = options.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  if (!Number.isFinite(now)) throw new Error('COGNITION_ACTIVATION_TIME_INVALID');
  const activeAt = new Date(now).toISOString();

  const queryTerms = cognitiveTerms(query.slice(0, 8_192));
  const inferredConcepts = [...queryTerms].filter(term => /[._:/-]/.test(term));
  const seedConcepts = [...new Set([...(options.seedConcepts ?? []), ...inferredConcepts])].slice(0, 64);
  const candidates = new Map<string, ActivationItem>();
  const gaps: string[] = [];
  const usageByAddress = new Map((options.usageFeedback ?? []).slice(0, 256).map(feedback => [
    memoryAddressKey(feedback.address),
    feedback,
  ]));

  for (const memory of options.transientMemories ?? []) {
    if (!active(memory, now)) continue;
    const lexical = lexicalScore(memory, queryTerms);
    const exactHits = memory.concepts.filter(concept => seedConcepts.includes(concept)).length;
    if (!lexical && !exactHits) continue;
    const item = ensureCandidate(candidates, memory);
    if (lexical) {
      item.score += lexical;
      addReason(item, { signal: 'lexical', score: lexical, detail: 'transient-term-overlap' });
    }
    if (exactHits) {
      const exact = Math.min(1, exactHits / Math.max(1, seedConcepts.length));
      item.score += 1.2 * exact;
      addReason(item, { signal: 'exact', score: exact, detail: 'transient-concept' });
    }
  }

  if (options.seedMemoryIds?.length) {
    for (const memory of port.readByIds(scopes, options.seedMemoryIds.slice(0, 64))) {
      if (!active(memory, now)) continue;
      const item = ensureCandidate(candidates, memory);
      item.score += 1;
      addReason(item, { signal: 'exact', score: 1, detail: 'stable-memory-id' });
    }
  }

  if (seedConcepts.length) {
    for (const memory of port.exactByConcept(scopes, seedConcepts, Math.min(maxCandidates, 64), activeAt)) {
      if (!active(memory, now)) continue;
      const hits = memory.concepts.filter(concept => seedConcepts.includes(concept)).length;
      const score = Math.min(1, hits / Math.max(1, seedConcepts.length));
      const item = ensureCandidate(candidates, memory);
      item.score += 1.2 * score;
      addReason(item, { signal: 'exact', score, detail: `concept:${memory.concepts.filter(concept => seedConcepts.includes(concept)).slice(0, 4).join(',')}` });
    }
  }

  for (const memory of port.lexical(scopes, [...queryTerms].slice(0, 96), Math.min(maxCandidates, 128), activeAt)) {
    if (!active(memory, now)) continue;
    const score = lexicalScore(memory, queryTerms);
    if (!score) continue;
    const item = ensureCandidate(candidates, memory);
    item.score += score;
    addReason(item, { signal: 'lexical', score, detail: 'term-overlap' });
  }

  if (options.semantic) {
    try {
      const semantic = options.semantic.search(query, scopes, Math.min(maxCandidates, 64));
      const memories = port.readByAddresses(semantic.map(candidate => candidate.address));
      const scoreByAddress = new Map(semantic.map(candidate => [memoryAddressKey(candidate.address), Math.max(0, Math.min(1, candidate.score))]));
      for (const memory of memories) {
        if (!active(memory, now)) continue;
        const score = scoreByAddress.get(memoryAddressKey(memoryAddressOf(memory))) ?? 0;
        if (!score) continue;
        const item = ensureCandidate(candidates, memory);
        item.score += score;
        addReason(item, { signal: 'semantic', score, detail: 'derived-semantic-index' });
      }
    } catch {
      gaps.push('semantic_index_unavailable');
    }
  }

  let frontier = [...candidates.values()].slice(0, 64).map(item => memoryAddressOf(item.memory));
  const seen = new Set(frontier.map(memoryAddressKey));
  for (let depth = 1; depth <= maxGraphDepth && frontier.length && candidates.size < maxCandidates; depth++) {
    const next: MemoryAddress[] = [];
    for (const { edge, from, memory } of port.neighbors(frontier, Math.min(maxCandidates * 2, 512), activeAt)) {
      if (!active(memory, now) || edge.retractedAt || edge.expiresAt && Date.parse(edge.expiresAt) <= now) continue;
      const source = candidates.get(memoryAddressKey(from));
      const relationFactor = graphRelationFactor(edge, from);
      const propagated = Math.max(0.01, (source?.score ?? 0.5) * edge.weight * relationFactor * (1 / (depth + 0.5)));
      const item = ensureCandidate(candidates, memory);
      item.score += propagated;
      addReason(item, { signal: 'graph', score: propagated, detail: `${edge.relation}@${depth}` });
      if (source) item.activationPath = [...source.activationPath, edge.id, memoryAddressLabel(memoryAddressOf(memory))].slice(-9);
      const key = memoryAddressKey(memoryAddressOf(memory));
      if (!seen.has(key)) {
        seen.add(key);
        next.push(memoryAddressOf(memory));
      }
      if (candidates.size >= maxCandidates) break;
    }
    frontier = next;
  }

  for (const item of candidates.values()) {
    const recency = recencyScore(item.memory, now);
    const confidenceContribution = item.memory.confidence * 0.25;
    const storedConflictPenalty = Math.min(0.2, item.memory.counterEvidenceRefs.length * 0.04);
    const feedback = usageByAddress.get(memoryAddressKey(memoryAddressOf(item.memory)));
    const usedBoost = Math.min(0.3, (feedback?.usedCount ?? 0) * 0.06);
    const rejectedPenalty = Math.min(0.25, (feedback?.rejectedCount ?? 0) * 0.05);
    const feedbackConflictPenalty = Math.min(0.2, ((feedback?.conflictCount ?? 0) + (feedback?.staleCount ?? 0)) * 0.08);
    const usageAdjustment = usedBoost - rejectedPenalty - feedbackConflictPenalty;
    item.score += recency * 0.15 + item.memory.utility * 0.25 + confidenceContribution - storedConflictPenalty + usageAdjustment;
    addReason(item, { signal: 'recency', score: recency, detail: 'temporal-decay' });
    addReason(item, { signal: 'utility', score: item.memory.utility, detail: 'stored-utility' });
    addReason(item, { signal: 'confidence', score: item.memory.confidence, detail: 'stored-confidence' });
    if (feedback && (feedback.usedCount || feedback.rejectedCount)) addReason(item, {
      signal: 'usage',
      score: Math.abs(usageAdjustment),
      detail: `used:${feedback.usedCount};rejected:${feedback.rejectedCount}`,
    });
    const conflictPenalty = storedConflictPenalty + feedbackConflictPenalty;
    if (conflictPenalty) addReason(item, {
      signal: 'conflict',
      score: conflictPenalty,
      detail: feedbackConflictPenalty
        ? `counter-evidence:${item.memory.counterEvidenceRefs.length};feedback-conflict:${feedback?.conflictCount ?? 0};stale:${feedback?.staleCount ?? 0}`
        : `counter-evidence:${item.memory.counterEvidenceRefs.length}`,
    });
  }

  const ranked = [...candidates.values()].sort((a, b) =>
    b.score - a.score
    || b.memory.provenance.recordedAt.localeCompare(a.memory.provenance.recordedAt)
    || memoryAddressKey(memoryAddressOf(a.memory)).localeCompare(memoryAddressKey(memoryAddressOf(b.memory))));
  const items: ActivationItem[] = [];
  let estimatedBytes = 0;
  for (const item of ranked) {
    // Opportunistic recall should behave like an associative cue, not like a
    // list of globally high-confidence memories. Confidence/utility rank a
    // relevant memory after it is cued; they must not make a weakly related
    // memory "come to mind" by themselves.
    if (retrievalCueScore(item, queryTerms) < minCueScore) continue;
    const size = Buffer.byteLength(JSON.stringify({
      address: memoryAddressLabel(memoryAddressOf(item.memory)),
      facets: item.memory.facets,
      text: item.memory.canonicalText,
      concepts: item.memory.concepts,
      score: item.score,
      reasons: item.reasons,
      evidence: item.memory.provenance.evidenceRefs,
    }), 'utf8');
    if (items.length >= maxItems || estimatedBytes + size > maxBytes) {
      gaps.push('activation_budget');
      continue;
    }
    items.push(item);
    estimatedBytes += size;
  }

  return {
    schemaVersion: 1,
    query: query.slice(0, 8_192),
    generatedAt: nowText,
    items,
    gaps: [...new Set(gaps)],
    truncated: gaps.includes('activation_budget') || candidates.size >= maxCandidates,
    inspectedCandidates: candidates.size,
    estimatedBytes,
  };
}
