#!/usr/bin/env bun
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { findRegisteredRepositoryByCheckoutRoot, registerRepository } from '../src/cli/repositories/registry';
import {
  collectChangedPaths,
  loadTestManifest,
  runTestSelection,
  selectTests,
  validateTestManifest,
  type TestGate,
} from '../src/testing/test-governance';
import { TEST_FAILURE_CODES } from './run-bun-test-file';
import {
  STRUCTURED_CHECK_RESULT_PATH_ENV,
  type StructuredCheckFailureEvidence,
} from '../src/runtime/execution/process-runtime/check-result';

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

export function consumeStructuredCheckResultPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[STRUCTURED_CHECK_RESULT_PATH_ENV]?.trim();
  delete env[STRUCTURED_CHECK_RESULT_PATH_ENV];
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error('TEST_STRUCTURED_RESULT_PATH_MUST_BE_ABSOLUTE');
  return value;
}

function writeStructuredCheckEvidence(path: string | undefined, evidence: StructuredCheckFailureEvidence): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function main(args: string[]): Promise<number> {
  const options = parseTestGovernanceArgs(args);
  const structuredResultPath = consumeStructuredCheckResultPath();
  const manifest = loadTestManifest(ROOT);
  const errors = validateTestManifest(ROOT, manifest);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[tests] manifest: ${error}`);
    writeStructuredCheckEvidence(structuredResultPath, {
      schemaVersion: 1,
      producer: 'test-governance',
      gate: options.gate,
      status: 'failed',
      failures: 1,
      failureClasses: ['source'],
      failureDetails: [{
        file: 'tests/test-manifest.v1.json',
        failureClass: 'source',
        failureCode: TEST_FAILURE_CODES.SOURCE_MANIFEST_INVALID,
        attempts: 1,
        durationMs: 0,
      }],
      failureDetailsTruncated: false,
      contaminated: false,
    });
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
  const controllerHome = ensureControllerHome();
  const repository = findRegisteredRepositoryByCheckoutRoot(ROOT, controllerHome)
    ?? registerRepository({ path: ROOT, controllerHome });
  return runTestSelection(ROOT, manifest, selection, {
    useCache: options.useCache,
    storageAuthority: { controllerHome, repoId: repository.repoId },
    onReceipt: (receipt) => writeStructuredCheckEvidence(structuredResultPath, receipt.failureEvidence),
  });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
