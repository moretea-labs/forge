#!/usr/bin/env bun
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCognitiveMemory, recordCognitiveMemoryEdge, type CognitiveWriteAuthorityPort } from '../packages/kernel/cognition/api/index';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { activateCognitiveMemory, cognitionMemoryStore } from '../src/runtime/control-plane/persistence/cognition-store';

const count = Math.max(1_000, Math.min(100_000, Number(process.argv[2] ?? 20_000)));
const iterations = Math.max(5, Math.min(100, Number(process.argv[3] ?? 20)));
const root = mkdtempSync(join(tmpdir(), 'forge-cognition-benchmark-'));
const controllerHome = join(root, 'controller');
const scope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'benchmark-cognition' };
const authority: CognitiveWriteAuthorityPort = { assertMemoryWrite() {}, assertEdgeWrite() {}, evidenceAvailable() { return true; } };
const store = cognitionMemoryStore(controllerHome);
const now = '2026-09-17T00:00:00.000Z';

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

try {
  ensureControllerHome(controllerHome);
  const seedStarted = performance.now();
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const topic = index % 500;
      recordCognitiveMemory(store, authority, {
        id: `mem:${index}`,
        scope,
        facets: index % 7 === 0 ? ['knowledge', 'successful-pattern'] : ['observation'],
        canonicalText: `Memory ${index} records reusable knowledge for topic ${topic} with relation group ${Math.floor(index / 100)}.`,
        concepts: [`topic.${topic}`, `group.${Math.floor(index / 100)}`],
        provenance: { sourceKind: 'system', sourceId: `bench:${index}`, recordedAt: now, evidenceRefs: [] },
        confidence: 0.5 + (index % 50) / 100,
        utility: 0.4 + (index % 60) / 100,
        tier: index % 7 === 0 ? 'warm' : 'cold',
        validFrom: now,
        counterEvidenceRefs: [],
      });
    }
    for (let index = 0; index + 1 < count; index += 100) {
      recordCognitiveMemoryEdge(store, authority, { id: `edge:${index}`, scope, fromId: `mem:${index}`, toId: `mem:${index + 1}`, relation: 'related_to', weight: 0.8, evidenceRefs: [], recordedAt: now });
    }
  });
  const seedMs = performance.now() - seedStarted;
  const samples: number[] = [];
  let lastBytes = 0, lastItems = 0, lastCandidates = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    const pack = activateCognitiveMemory(controllerHome, [scope], 'topic.123 reusable knowledge', { seedMemoryIds: ['mem:12300'], seedConcepts: ['topic.123'], maxItems: 16, maxCandidates: 128, maxGraphDepth: 2, maxBytes: 24 * 1024, now });
    samples.push(performance.now() - started);
    lastBytes = pack.estimatedBytes; lastItems = pack.items.length; lastCandidates = pack.inspectedCandidates;
  }
  console.log(JSON.stringify({ schemaVersion: 1, memoryCount: count, iterations, seedMs: Number(seedMs.toFixed(2)), activationMs: { min: Number(Math.min(...samples).toFixed(2)), p50: Number(percentile(samples, 0.5).toFixed(2)), p95: Number(percentile(samples, 0.95).toFixed(2)), max: Number(Math.max(...samples).toFixed(2)) }, activationPack: { items: lastItems, bytes: lastBytes, inspectedCandidates: lastCandidates }, transport: 'local-association -> semantic ActivationPack; no repeated MCP memory lookup' }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
