#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializeCommittedTypeScriptCandidate } from './testing/source-quality-candidate';

const root = resolve(import.meta.dir, '..');
const committed = process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed';
const revision = process.env.FORGE_CHECK_CANDIDATE_SHA;
if (committed && !revision) throw new Error('Committed architecture check requires candidate SHA');

const candidateRoot = committed ? materializeCommittedTypeScriptCandidate(root, revision!) : root;
try {
  if (committed) console.error(`[architecture] checking pinned committed candidate ${revision?.slice(0, 12)}`);
  const result = spawnSync('node', ['scripts/check-runtime-architecture.mjs'], {
    cwd: candidateRoot,
    stdio: 'inherit',
    timeout: 5 * 60_000,
  });
  if (result.error) console.error(`[architecture] could not run checker: ${result.error.message}`);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  if (committed) rmSync(candidateRoot, { recursive: true, force: true });
}
