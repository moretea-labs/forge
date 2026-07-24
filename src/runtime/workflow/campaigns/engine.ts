import type { CampaignReconcileResult, CampaignTask } from './types';
import { getCampaign, updateCampaign } from './store';
import { createHandoffItem, createWorkContract, getWorkContract } from '../../control-plane/facade';

const SUCCESS_TASK_STATUSES = new Set<CampaignTask['status']>(['succeeded', 'succeeded_no_change', 'skipped']);

function now(): string { return new Date().toISOString(); }

/**
 * Campaign is a historical planning and migration view. Explicit reconciliation
 * migrates unfinished tasks into WorkContracts and HandoffItems without dispatching
 * ExecutionJobs, Agent Runs, retries, or supervisor triggers.
 */
function migrateFrozenCampaign(controllerHome: string, repoId: string, campaignId: string): CampaignReconcileResult {
  const before = getCampaign(controllerHome, repoId, campaignId);
  if (before.pauseReason?.startsWith('Campaign automation frozen;')) {
    return { campaignId, changed: false, dispatched: 0, checkpointsOpened: 0, status: before.status };
  }
  const migratable = before.tasks.filter((task) => !SUCCESS_TASK_STATUSES.has(task.status));
  let migrated = 0;
  for (const task of migratable) {
    const store = { controllerHome, repoId };
    const workId = `campaign-${before.campaignId}-${task.taskId}`;
    const terminalFailure = ['failed', 'failed_no_effect', 'cancelled'].includes(task.status);
    const work = getWorkContract(store, workId) ?? createWorkContract(store, {
      workId,
      repoId,
      mode: 'direct_control',
      objective: task.objective || task.title,
      acceptanceCriteria: before.goals.at(-1)?.acceptanceCriteria ?? [],
      constraints: {
        requireHandoffOnAmbiguity: true,
        workspaceMode: before.workspace.mode === 'isolated' ? 'isolated' : 'current',
      },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      status: terminalFailure ? 'failed' : task.status === 'waiting_review' ? 'ready' : 'blocked',
      requestedBy: 'system',
      scopeSummary: `Migrated from frozen Campaign ${before.campaignId} task ${task.taskId}.`,
    });
    const handoffId = `campaign-migration-${before.campaignId}-${task.taskId}`;
    try {
      createHandoffItem(store, {
        id: handoffId,
        repoId,
        workId: work.workId,
        title: `Campaign task migrated: ${task.title}`,
        severity: terminalFailure ? 'failed' : task.status === 'waiting_review' ? 'ready_to_continue' : 'blocked',
        creationReason: 'ambiguous_outcome',
        reason: 'Campaign automation is frozen; an external SuperController must inspect and continue this WorkContract.',
        summary: `Campaign task ${task.taskId} was migrated without dispatching a legacy Job.`,
        currentState: {
          repoId,
          workId: work.workId,
          statusSummary: task.status,
          blockedBy: task.dependsOn,
          checks: task.jobId ? [{ checkId: task.jobId, ok: false, summary: 'Legacy Campaign Job reference retained for inspection.' }] : undefined,
        },
        attemptedActions: [
          ...(task.jobId ? [`legacy ExecutionJob: ${task.jobId}`] : []),
          ...(task.runId ? [`legacy Agent Run: ${task.runId}`] : []),
        ],
        evidenceRefs: task.evidenceIds.map((evidenceId) => ({ evidenceId, title: 'Campaign evidence' })),
        recommendedDecision: 'Claim the WorkContract and inspect retained evidence before continuation.',
        recommendedPrompt: `Claim Work ${work.workId}, inspect the Campaign handoff, and continue through the repository MCP facade.`,
        suggestedNextActions: [],
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
    }
    migrated += 1;
  }
  const updated = updateCampaign(controllerHome, repoId, campaignId, `migration:${campaignId}:${before.revision}`, (campaign) => {
    for (const task of campaign.tasks) {
      if (SUCCESS_TASK_STATUSES.has(task.status)) continue;
      task.status = 'blocked';
      task.nextAttemptAt = undefined;
      task.executionFinishedAt ??= now();
      task.error = {
        code: 'CAMPAIGN_MIGRATED_TO_WORK',
        message: 'Campaign automation is frozen; continue through the linked WorkContract and HandoffItem.',
        retryable: false,
      };
    }
    campaign.status = 'paused';
    campaign.pauseReason = `Campaign automation frozen; ${migrated} task(s) migrated to WorkContracts.`;
    campaign.nextReconcileAt = undefined;
    return campaign;
  }, {
    eventType: 'campaign_migrated_to_work',
    eventData: { migrated },
    wakeScheduler: false,
  });
  return { campaignId, changed: updated.revision !== before.revision, dispatched: 0, checkpointsOpened: 0, status: updated.status };
}

export function reconcileCampaign(controllerHome: string, repoId: string, campaignId: string): CampaignReconcileResult {
  return migrateFrozenCampaign(controllerHome, repoId, campaignId);
}

export interface TickCampaignsOptions {
  maxCampaigns?: number;
}

export function tickCampaigns(controllerHome: string, repoIds: string[], options: TickCampaignsOptions = {}): CampaignReconcileResult[] {
  // Automatic reconcile, retry, dispatch, and supervisor triggering are retired.
  void controllerHome;
  void repoIds;
  void options;
  return [];
}
