#!/usr/bin/env node

/**
 * Manual Work finalization and cleanup tool.
 *
 * Usage:
 *   bun run tools/cleanup-works.ts [--dry-run] [--max-work N] [--min-age-minutes N]
 */

import { executeAutoFinalization } from '../src/runtime/maintenance/work-auto-finalization';
import { reconcileTerminalWorkCleanups } from '../src/runtime/control-plane/execution/work-terminal-cleanup';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const maxWorkIndex = args.indexOf('--max-work');
const maxWork = maxWorkIndex >= 0 ? Number(args[maxWorkIndex + 1]) || 50 : 50;
const minAgeIndex = args.indexOf('--min-age-minutes');
const minAgeMinutes = minAgeIndex >= 0 ? Number(args[minAgeIndex + 1]) || 1 : 1;

const controllerHome = process.env.FORGE_CONTROLLER_HOME || `${process.env.HOME}/.forge/controller`;

async function main() {
  console.log('='.repeat(80));
  console.log('Forge Work Finalization and Cleanup Tool');
  console.log('='.repeat(80));
  console.log('Controller Home:', controllerHome);
  console.log('Mode:', dryRun ? 'DRY RUN (no changes)' : 'APPLY (will make changes)');
  console.log('Max Work per cycle:', maxWork);
  console.log('Min age (minutes):', minAgeMinutes);
  console.log('');

  // Step 1: Auto-finalization (closes delivered-but-open Work)
  console.log('Step 1: Auto-finalization (detect and close delivered Work)');
  console.log('-'.repeat(80));

  const finalizationReport = await executeAutoFinalization(controllerHome, {
    minAgeMinutes,
    maxWork,
    dryRun,
  });

  console.log('Scanned:', finalizationReport.scanned, 'Work items');
  console.log('Candidates found:', finalizationReport.candidates.length);
  console.log('');

  if (finalizationReport.candidates.length > 0) {
    console.log('Candidates by reason:');
    const byReason = finalizationReport.candidates.reduce((acc, c) => {
      acc[c.reason] = (acc[c.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    Object.entries(byReason).forEach(([reason, count]) => {
      console.log(`  - ${reason}: ${count}`);
    });
    console.log('');

    console.log('Sample candidates:');
    finalizationReport.candidates.slice(0, 10).forEach(c => {
      console.log(`  ${c.workId} (${c.reason}, ${c.isDirty ? 'DIRTY' : 'clean'}, age: ${Math.round((c.ageMs || 0) / 60000)}m)`);
    });
    console.log('');
  }

  if (finalizationReport.autoCompleted.length > 0) {
    console.log('✓ Auto-completed Work:', finalizationReport.autoCompleted.length);
    finalizationReport.autoCompleted.forEach(w => {
      console.log(`  - ${w.workId}`);
    });
    console.log('');
  }

  if (finalizationReport.cleanedUp.length > 0) {
    console.log('✓ Cleaned up Work:', finalizationReport.cleanedUp.length);
    finalizationReport.cleanedUp.forEach(w => {
      console.log(`  - ${w.workId} (${w.status})`);
    });
    console.log('');
  }

  if (finalizationReport.retained.length > 0) {
    console.log('⚠ Retained (needs manual review):', finalizationReport.retained.length);
    finalizationReport.retained.slice(0, 5).forEach(w => {
      console.log(`  - ${w.workId}: ${w.reason}`);
    });
    console.log('');
  }

  if (finalizationReport.errors.length > 0) {
    console.log('✗ Errors:', finalizationReport.errors.length);
    finalizationReport.errors.slice(0, 5).forEach(e => {
      console.log(`  - ${e.workId}: ${e.error}`);
    });
    console.log('');
  }

  // Step 2: Terminal Work cleanup (for already-closed Work)
  console.log('Step 2: Terminal Work cleanup (clean up closed Work)');
  console.log('-'.repeat(80));

  if (!dryRun) {
    const cleanupReport = await reconcileTerminalWorkCleanups(controllerHome, {
      minAgeMs: minAgeMinutes * 60 * 1000,
      maxWork,
    });

    console.log('Scanned:', cleanupReport.scanned, 'Work handles');
    console.log('Eligible:', cleanupReport.eligible);
    console.log('Attempted:', cleanupReport.attempted);
    console.log('Cleaned:', cleanupReport.cleaned.length);
    console.log('Blocked:', cleanupReport.blocked.length);
    console.log('Skipped (recent):', cleanupReport.skippedRecent.length);
    console.log('Skipped (retained):', cleanupReport.skippedRetained.length);
    console.log('Errors:', cleanupReport.errors.length);
    console.log('');

    if (cleanupReport.cleaned.length > 0) {
      console.log('✓ Successfully cleaned Work:');
      cleanupReport.cleaned.slice(0, 10).forEach(id => console.log(`  - ${id}`));
      console.log('');
    }

    if (cleanupReport.blocked.length > 0) {
      console.log('⚠ Blocked Work (needs attention):');
      cleanupReport.blocked.slice(0, 5).forEach(b => {
        console.log(`  - ${b.workId}: ${b.reason}`);
      });
      console.log('');
    }

    if (cleanupReport.orphanWorktrees.removed.length > 0) {
      console.log('✓ Removed orphan worktrees:', cleanupReport.orphanWorktrees.removed.length);
      console.log('');
    }
  } else {
    console.log('(Skipped in dry-run mode)');
    console.log('');
  }

  // Summary
  console.log('='.repeat(80));
  console.log('Summary');
  console.log('='.repeat(80));

  const totalActions = finalizationReport.autoCompleted.length + finalizationReport.cleanedUp.length;
  const totalIssues = finalizationReport.retained.length + finalizationReport.errors.length;

  if (dryRun) {
    console.log('DRY RUN: No changes were made');
    console.log('Would have processed:', totalActions, 'Work items');
  } else {
    console.log('✓ Actions taken:', totalActions);
    console.log('  - Auto-completed:', finalizationReport.autoCompleted.length);
    console.log('  - Cleaned up:', finalizationReport.cleanedUp.length);
  }

  if (totalIssues > 0) {
    console.log('⚠ Issues requiring attention:', totalIssues);
  }

  console.log('');

  if (dryRun) {
    console.log('Run without --dry-run to apply changes');
  } else {
    console.log('Done! Run "git branch | grep work/" to see remaining work branches.');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
