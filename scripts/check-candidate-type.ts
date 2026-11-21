#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { materializeCommittedTypeScriptCandidate } from '../src/testing/source-quality-candidate';

const ROOT = resolve(import.meta.dir, '..');
const committedMode = process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed';
const revision = process.env.FORGE_CHECK_CANDIDATE_SHA;
if (committedMode && !revision) {
  throw new Error('Committed typecheck requires FORGE_CHECK_CANDIDATE_SHA');
}

const candidateRoot = committedMode ? materializeCommittedTypeScriptCandidate(ROOT, revision!) : ROOT;
try {
  if (committedMode) console.error(`[typecheck] checking pinned committed candidate ${revision?.slice(0, 12)}`);
  const result = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['--noEmit'], {
    cwd: candidateRoot,
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
  if (result.error) console.error(`[typecheck] failed to execute: ${result.error.message}`);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  if (committedMode) rmSync(candidateRoot, { recursive: true, force: true });
}
