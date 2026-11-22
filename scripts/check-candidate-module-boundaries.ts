#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializeCommittedTypeScriptCandidate } from './testing/source-quality-candidate';

/** Check the exact published Git tree; do not treat another Writer's dirty source as this candidate. */
export function runCandidateModuleBoundaries(root: string, committed: boolean, revision?: string): number {
  if (committed && !revision) throw new Error('Committed module boundary check requires candidate SHA');

  const checkRoot = committed ? materializeCommittedTypeScriptCandidate(root, revision!) : root;
  try {
    if (committed) console.error(`[module-boundaries] checking pinned committed candidate ${revision?.slice(0, 12)}`);
    const result = spawnSync('node', ['scripts/check-module-boundaries.mjs'], {
      cwd: checkRoot,
      stdio: 'inherit',
      timeout: 2 * 60_000,
    });
    if (result.error) console.error(`[module-boundaries] could not run checker: ${result.error.message}`);
    return result.status === 0 ? 0 : 1;
  } finally {
    if (committed) rmSync(checkRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const committed = process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed';
  process.exitCode = runCandidateModuleBoundaries(root, committed, process.env.FORGE_CHECK_CANDIDATE_SHA);
}
