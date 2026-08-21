#!/usr/bin/env bun

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { performance } from 'perf_hooks';
import {
  clearTypeScriptNavigationCache,
  navigateTypeScriptSymbol,
  type TypeScriptNavigationKind,
} from '../src/runtime/context/typescript-navigation';

interface BenchmarkCase {
  label: string;
  path: string;
  symbol: string;
  marker: string;
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const cases: BenchmarkCase[] = [
  {
    label: 'repository command execution',
    path: 'src/cli/repositories/command-executor.ts',
    symbol: 'executeRepositoryCommand',
    marker: 'export function executeRepositoryCommand(',
  },
  {
    label: 'MCP repository dispatch',
    path: 'src/cli/mcp/repository-tools.ts',
    symbol: 'callRepositoryTool',
    marker: 'export async function callRepositoryTool(',
  },
  {
    label: 'canonical Runtime proxy',
    path: 'src/cli/mcp/server.ts',
    symbol: 'createCanonicalRuntimeProxy',
    marker: 'export function createCanonicalRuntimeProxy(',
  },
  {
    label: 'Runtime MCP dispatch',
    path: 'src/runtime/gateway/mcp/runtime-tools.ts',
    symbol: 'callRuntimeTool',
    marker: 'export async function callRuntimeTool(',
  },
  {
    label: 'Lightweight command execution',
    path: 'src/runtime/execution/process-runtime/lightweight-managed.ts',
    symbol: 'startLightweightRepositoryCommand',
    marker: 'export async function startLightweightRepositoryCommand(',
  },
];
const requestedSymbols = new Set(
  String(process.env.FORGE_TSNAV_BENCHMARK_SYMBOLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const benchmarkCases = requestedSymbols.size === 0
  ? cases
  : cases.filter((case_) => requestedSymbols.has(case_.symbol));
if (benchmarkCases.length === 0) {
  throw new Error(`No benchmark cases match FORGE_TSNAV_BENCHMARK_SYMBOLS=${[...requestedSymbols].join(',')}`);
}

function target(case_: BenchmarkCase): { line: number; column: number } {
  const text = readFileSync(resolve(repoRoot, case_.path), 'utf8');
  const markerOffset = text.indexOf(case_.marker);
  if (markerOffset < 0) throw new Error(`marker not found for ${case_.label}: ${case_.marker}`);
  const symbolOffset = markerOffset + case_.marker.indexOf(case_.symbol);
  const before = text.slice(0, symbolOffset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function navigate(case_: BenchmarkCase, navigation: TypeScriptNavigationKind) {
  const point = target(case_);
  return navigateTypeScriptSymbol(repoRoot, { navigation, path: case_.path, ...point });
}

function lexicalMatches(symbol: string): string[] {
  try {
    const output = execFileSync('git', ['grep', '-n', '-w', symbol, '--', 'src', 'scripts', 'tests'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

const results = [];
for (const case_ of benchmarkCases) {
  clearTypeScriptNavigationCache();
  // This first reference call represents the user-visible cold path.
  const coldReferenceStartedAt = performance.now();
  const coldReferences = navigate(case_, 'references');
  const coldReferenceMs = performance.now() - coldReferenceStartedAt;

  // Then separately initialize a fresh project through the cheap definition
  // query and measure references on that already-built Language Service. This
  // makes project construction and high-fanout reference cost visible instead
  // of attributing both to one opaque cold number.
  clearTypeScriptNavigationCache();
  const projectSetupStartedAt = performance.now();
  const coldDefinition = navigate(case_, 'definition');
  const projectSetupMs = performance.now() - projectSetupStartedAt;
  const firstReferenceStartedAt = performance.now();
  const firstReferencesOnPreparedProject = navigate(case_, 'references');
  const firstReferenceOnPreparedProjectMs = performance.now() - firstReferenceStartedAt;

  const warmDurations: number[] = [];
  let warmReferences = firstReferencesOnPreparedProject;
  for (let index = 0; index < 3; index += 1) {
    const startedAt = performance.now();
    warmReferences = navigate(case_, 'references');
    warmDurations.push(performance.now() - startedAt);
  }
  const definitions = navigate(case_, 'definition');
  const implementations = navigate(case_, 'implementations');
  const lexical = lexicalMatches(case_.symbol);

  results.push({
    label: case_.label,
    symbol: case_.symbol,
    target: { path: case_.path, ...target(case_) },
    semantic: {
      coldReferenceLocations: coldReferences.locations.length,
      coldDefinitionLocations: coldDefinition.locations.length,
      references: warmReferences.locations.length,
      definitions: definitions.locations.length,
      implementations: implementations.locations.length,
      sampleReferences: warmReferences.locations.slice(0, 8),
    },
    lexical: {
      exactMatches: lexical.length,
      sampleMatches: lexical.slice(0, 8),
    },
    latencyMs: {
      coldReferences: Math.round(coldReferenceMs * 100) / 100,
      projectSetupViaDefinition: Math.round(projectSetupMs * 100) / 100,
      firstReferencesOnPreparedProject: Math.round(firstReferenceOnPreparedProjectMs * 100) / 100,
      warmReferences: warmDurations.map((value) => Math.round(value * 100) / 100),
    },
  });
}
clearTypeScriptNavigationCache();

const preparedReferenceDurations = results.map((entry) => entry.latencyMs.firstReferencesOnPreparedProject);
const warmReferenceDurations = results.flatMap((entry) => entry.latencyMs.warmReferences);
const thresholds = {
  firstReferencesOnPreparedProjectP95MaxMs: 250,
  warmReferencesP95MaxMs: 150,
};
const assertions = {
  allDefinitionsResolved: results.every((entry) => entry.semantic.definitions >= 1),
  allReferencesResolved: results.every((entry) => entry.semantic.references >= 1),
  allImplementationsResolved: results.every((entry) => entry.semantic.implementations >= 1),
  semanticFindsNonLexicalReferences: results.some((entry) => entry.semantic.references > entry.lexical.exactMatches),
  preparedReferenceLatencyBounded: percentile(preparedReferenceDurations, 0.95) <= thresholds.firstReferencesOnPreparedProjectP95MaxMs,
  warmReferenceLatencyBounded: percentile(warmReferenceDurations, 0.95) <= thresholds.warmReferencesP95MaxMs,
};
const output = {
  repoRoot,
  requestedSymbols: [...requestedSymbols],
  cases: results,
  summary: {
    firstReferencesOnPreparedProjectP95Ms: percentile(preparedReferenceDurations, 0.95),
    warmReferencesP95Ms: percentile(warmReferenceDurations, 0.95),
  },
  thresholds,
  assertions,
  passed: Object.values(assertions).every(Boolean),
};
console.log(JSON.stringify(output, null, 2));
if (!output.passed) process.exitCode = 1;
