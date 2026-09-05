#!/usr/bin/env bun
import { createHash } from 'crypto';
import { rmSync } from 'fs';
import { resolve } from 'path';
import {
  controllerCheckExecutionIdentity,
  runControllerCheckAsync,
  snapshotControllerCheck,
} from '../../../cli/controller/check-runner';
import { writePersistedCheckResultReceipt } from './check-result';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from './canary';

interface ParsedArgs {
  repo: string;
  controllerHome: string;
  repoId: string;
  checkId: string;
  timeoutMs?: number;
  expectedCheckFingerprint: string;
  resultReceiptPath?: string;
  cleanupRoot?: string;
  isolatedControllerHome?: string;
}

function requiredValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`PERSISTED_CHECK_USAGE: missing ${flag}`);
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const timeoutRaw = argv.includes('--timeout-ms') ? requiredValue(argv, '--timeout-ms') : undefined;
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('PERSISTED_CHECK_USAGE: invalid --timeout-ms');
  }
  return {
    repo: requiredValue(argv, '--repo'),
    controllerHome: requiredValue(argv, '--controller-home'),
    repoId: requiredValue(argv, '--repo-id'),
    checkId: requiredValue(argv, '--check-id'),
    timeoutMs,
    expectedCheckFingerprint: requiredValue(argv, '--expected-check-fingerprint'),
    resultReceiptPath: argv.includes('--result-receipt') ? requiredValue(argv, '--result-receipt') : undefined,
    cleanupRoot: argv.includes('--cleanup-root') ? requiredValue(argv, '--cleanup-root') : undefined,
    isolatedControllerHome: argv.includes('--isolated-controller-home') ? requiredValue(argv, '--isolated-controller-home') : undefined,
  };
}

export async function runPersistedCheckSidecar(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
    process.stdout.write('forge check-runner release canary\n');
    return 0;
  }
  const args = parseArgs(argv);
  const root = resolve(args.repo);
  try {
    const snapshot = snapshotControllerCheck(root, args.checkId);
    const actualFingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    if (actualFingerprint !== args.expectedCheckFingerprint) {
      throw new Error('CHECK_SNAPSHOT_CHANGED: registered check changed before Process Runtime execution');
    }
    const identity = controllerCheckExecutionIdentity(root, args.checkId, args.timeoutMs, snapshot);
    const result = await runControllerCheckAsync(root, args.checkId, {
      requestedTimeoutMs: args.timeoutMs,
      snapshot,
      storageAuthority: { controllerHome: args.controllerHome, repoId: args.repoId },
      isolatedControllerHome: args.isolatedControllerHome,
    });
    if (args.resultReceiptPath) {
      writePersistedCheckResultReceipt(args.resultReceiptPath, {
        checkId: args.checkId,
        cacheKey: identity.cacheKey,
        ok: result.ok,
        status: result.status,
        timedOut: result.timedOut,
        failureClass: result.failureClass,
        validatedRevision: result.validatedRevision,
        executedAt: result.executedAt,
        originalExecutedAt: result.originalExecutedAt,
        cacheHit: result.cacheHit,
      });
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    return result.ok ? 0 : Math.max(1, result.status || 1);
  } finally {
    if (args.cleanupRoot) rmSync(resolve(args.cleanupRoot), { recursive: true, force: true });
  }
}

const direct = typeof process.argv[1] === 'string'
  && (process.argv[1].includes('check-runner-sidecar') || process.argv[1].endsWith('/forge-check-runner'));
if (direct) {
  void runPersistedCheckSidecar()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
