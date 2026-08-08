#!/usr/bin/env bun
import { createHash } from 'crypto';
import { resolve } from 'path';
import {
  runControllerCheck,
  snapshotControllerCheck,
} from '../../../cli/controller/check-runner';

interface ParsedArgs {
  repo: string;
  checkId: string;
  timeoutMs?: number;
  expectedCheckFingerprint: string;
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
    checkId: requiredValue(argv, '--check-id'),
    timeoutMs,
    expectedCheckFingerprint: requiredValue(argv, '--expected-check-fingerprint'),
  };
}

export function runPersistedCheckSidecar(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const root = resolve(args.repo);
  const snapshot = snapshotControllerCheck(root, args.checkId);
  const actualFingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (actualFingerprint !== args.expectedCheckFingerprint) {
    throw new Error('CHECK_SNAPSHOT_CHANGED: registered check changed before Process Runtime execution');
  }
  const result = runControllerCheck(root, args.checkId, args.timeoutMs, snapshot);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.ok ? 0 : Math.max(1, result.status || 1);
}

const direct = typeof process.argv[1] === 'string'
  && (process.argv[1].includes('check-runner-sidecar') || process.argv[1].endsWith('/forge-check-runner'));
if (direct) {
  try {
    process.exitCode = runPersistedCheckSidecar();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
