#!/usr/bin/env node

/**
 * Force cleanup specific clean worktrees that are blocking.
 *
 * This handles the case where Work has been delivered but cleanup was blocked.
 * Run this after the main cleanup tool to handle edge cases.
 */

import { readWorkHandle, listWorkHandles } from '../src/runtime/control-plane/execution/work-handle-store';
import { reconcileSingleTerminalWorkCleanup } from '../src/runtime/control-plane/execution/work-terminal-cleanup';
import { getWorkContract, semanticWorkState, reviseWorkSemanticContext } from '../packages/kernel/work/api/index';
import { listRepositories } from '../src/cli/repositories/registry';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

const controllerHome = process.env.FORGE_CONTROLLER_HOME || `${process.env.HOME}/.forge/controller`;

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
  };
}

async function forceCleanupCleanWorktrees() {
  console.log('Force Cleanup Clean Worktrees');
  console.log('='.repeat(80));

  const repositories = listRepositories(controllerHome).filter(r => r.enabled && !r.removedAt);

  for (const repo of repositories) {
    console.log(`\nRepository: ${repo.repoId}`);

    const handles = listWorkHandles(controllerHome, repo.repoId, 5_000)
      .filter(h => h.managedWorktree && h.state !== 'cleaned');

    console.log(`Found ${handles.length} non-cleaned Work handles`);

    for (const handle of handles) {
      const workId = handle.workContractId ?? handle.workId;
      const store = { controllerHome, repoId: repo.repoId };

      // Check if worktree is clean
      if (!handle.worktreePath || !existsSync(handle.worktreePath)) {
        console.log(`  - ${workId}: worktree already removed`);
        continue;
      }

      const status = git(handle.worktreePath, ['status', '--porcelain', '--untracked-files=all']);
      const isDirty = status.ok && Boolean(status.stdout);

      if (isDirty) {
        console.log(`  - ${workId}: DIRTY (skipping)`);
        continue;
      }

      // It's clean - check semantic state
      const contract = getWorkContract(store, workId);
      if (!contract) {
        console.log(`  - ${workId}: no contract (skipping)`);
        continue;
      }

      const semanticState = semanticWorkState(contract);
      console.log(`  - ${workId}: clean worktree, semantic=${semanticState}, handle=${handle.state}`);

      // If delivered and open, close it
      if (semanticState === 'open' && handle.state === 'merged') {
        console.log(`    → Auto-completing delivered Work`);
        try {
          reviseWorkSemanticContext(store, workId, {
            expectedRevision: contract.semanticRevision ?? 1,
            state: 'completed',
          });
          console.log(`    ✓ Completed`);
        } catch (error) {
          console.log(`    ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      // If terminal, clean it up
      if (semanticState === 'completed' || semanticState === 'cancelled') {
        console.log(`    → Cleaning up terminal Work`);
        try {
          const result = await reconcileSingleTerminalWorkCleanup(
            controllerHome,
            repo.repoId,
            workId,
            { deleteBranch: true }
          );
          console.log(`    ✓ Cleanup: ${result.status}`);
          if (result.status === 'blocked' && result.reason) {
            console.log(`      Reason: ${result.reason}`);
          }
        } catch (error) {
          console.log(`    ✗ Failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('Done!');
}

forceCleanupCleanWorktrees().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
