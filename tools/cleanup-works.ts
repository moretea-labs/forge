#!/usr/bin/env bun

/**
 * Manual cleanup for Work that is already canonically terminal.
 * Completion remains owned by the semantic Work writer, never by Git
 * delivery observation, age, or this maintenance script.
 *
 * Usage: bun tools/cleanup-works.ts [--dry-run] [--max-work N] [--min-age-minutes N]
 */
import { reconcileTerminalWorkCleanups } from '../src/runtime/control-plane/execution/work-terminal-cleanup';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
function positiveNumber(flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${flag}: positive number required`);
  return value;
}
const maxWork = Math.min(500, Math.trunc(positiveNumber('--max-work', 50)));
const minAgeMinutes = positiveNumber('--min-age-minutes', 1);
const controllerHome = process.env.FORGE_CONTROLLER_HOME || `${process.env.HOME}/.forge/controller`;

async function main(): Promise<void> {
  console.log('Forge terminal Work cleanup');
  console.log('Controller Home:', controllerHome);
  if (dryRun) {
    console.log('DRY RUN: no Work changed; this utility only cleans up already-terminal Work.');
    return;
  }
  const report = await reconcileTerminalWorkCleanups(controllerHome, {
    minAgeMs: minAgeMinutes * 60_000,
    maxWork,
  });
  console.log('Scanned:', report.scanned, 'Eligible:', report.eligible,
    'Attempted:', report.attempted, 'Cleaned:', report.cleaned.length,
    'Blocked:', report.blocked.length, 'Errors:', report.errors.length);
  for (const blocked of report.blocked.slice(0, 5)) console.log('Blocked:', blocked.workId, blocked.reason);
  for (const error of report.errors.slice(0, 5)) console.error('Error:', error);
}

void main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
