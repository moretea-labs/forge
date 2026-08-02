#!/usr/bin/env bun
import { resolve } from 'path';
import {
  collectChangedPaths,
  loadTestManifest,
  runTestSelection,
  selectTests,
  validateTestManifest,
  type TestGate,
} from '../src/testing/test-governance';

const ROOT = resolve(import.meta.dir, '..');
const gates = new Set<TestGate>(['affected', 'core', 'integration', 'infrastructure', 'fault', 'full']);

interface CliOptions {
  gate: TestGate;
  changedPaths: string[];
  explicitTests: string[];
  baseRef?: string;
  listOnly: boolean;
  validateOnly: boolean;
  useCache: boolean;
}

export function parseTestGovernanceArgs(args: string[]): CliOptions {
  let gate: TestGate = 'affected';
  const changedPaths: string[] = [];
  const explicitTests: string[] = [];
  let baseRef: string | undefined;
  let listOnly = false;
  let validateOnly = false;
  let useCache = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (gates.has(arg as TestGate)) gate = arg as TestGate;
    else if (arg === 'validate') validateOnly = true;
    else if (arg === '--list') listOnly = true;
    else if (arg === '--no-cache') useCache = false;
    else if (arg === '--changed-path') changedPaths.push(args[++index] ?? '');
    else if (arg === '--base') baseRef = args[++index];
    else if (/\.test\.(?:ts|mjs)$/.test(arg)) explicitTests.push(arg.replace(/^\.\//, ''));
    else throw new Error(`unknown test governance argument: ${arg}`);
  }
  return { gate, changedPaths: changedPaths.filter(Boolean), explicitTests, baseRef, listOnly, validateOnly, useCache };
}

export async function main(args: string[]): Promise<number> {
  const options = parseTestGovernanceArgs(args);
  const manifest = loadTestManifest(ROOT);
  const errors = validateTestManifest(ROOT, manifest);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[tests] manifest: ${error}`);
    return 1;
  }
  if (options.validateOnly) {
    console.error(`[tests] manifest v1 valid: ${Object.keys(manifest.tests).length} test files`);
    return 0;
  }
  const changedPaths = collectChangedPaths(ROOT, {
    explicit: options.changedPaths.length > 0 ? options.changedPaths : undefined,
    baseRef: options.baseRef
      ?? process.env.TEST_BASE_REF
      ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined),
  });
  const selection = selectTests(manifest, options.gate, changedPaths, options.explicitTests);
  console.error(`[tests] gate=${selection.gate}; reason=${selection.reason}`);
  console.error(`[tests] modules=${selection.modules.join(', ')}; selected=${selection.files.length}/${Object.keys(manifest.tests).length}`);
  if (options.listOnly) {
    for (const file of selection.files) console.log(file);
    return 0;
  }
  return runTestSelection(ROOT, manifest, selection, { useCache: options.useCache });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
