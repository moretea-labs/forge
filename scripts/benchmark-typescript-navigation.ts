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

const results = [];
for (const case_ of cases) {
  clearTypeScriptNavigationCache();
  const coldStartedAt = performance.now();
  const coldReferences = navigate(case_, 'references');
  const coldMs = performance.now() - coldStartedAt;

  const warmDurations: number[] = [];
  let warmReferences = coldReferences;
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
      coldReferences: Math.round(coldMs * 100) / 100,
      warmReferences: warmDurations.map((value) => Math.round(value * 100) / 100),
    },
  });
}
clearTypeScriptNavigationCache();

console.log(JSON.stringify({ repoRoot, cases: results }, null, 2));
