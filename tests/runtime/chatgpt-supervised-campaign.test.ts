import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { reconcileCampaign, tickCampaigns } from '../../src/runtime/workflow/campaigns/engine';
import { createCampaign, getCampaign } from '../../src/runtime/workflow/campaigns/store';
import { normalizeCampaignDependencyReference, normalizeCampaignOperationName } from '../../src/runtime/workflow/campaigns/normalize';

const roots: string[] = [];

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-campaign-frozen-'));
  roots.push(root);
  return root;
}

function campaignInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `campaign-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    semanticKey: 'campaign-frozen',
    repoId: 'repo-a',
    title: 'Frozen campaign',
    goal: 'Migrate unfinished Campaign tasks without Agent dispatch.',
    acceptanceCriteria: ['WorkContracts exist', 'Handoffs exist', 'No ExecutionJobs'],
    nonGoals: ['Automatic Agent dispatch'],
    budget: { maxParallelTasks: 2, maxExecutionJobs: 10, defaultTaskMaxAttempts: 1 },
    tasks: [
      {
        taskId: 'T1',
        title: 'First task',
        operation: 'dispatch_task',
        arguments: { agent: 'codex' },
      },
      {
        taskId: 'T2',
        title: 'Second task',
        operation: 'record_candidate_finding',
        arguments: { semantic_key: 'finding', title: 'finding' },
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ChatGPT-supervised campaigns', () => {
  test('explicit reconcile migrates unfinished tasks into Work + Handoff without jobs', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput()).campaign;

    const first = reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const second = reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);

    expect(first.dispatched).toBe(0);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.dispatched).toBe(0);
    expect(campaign.status).toBe('paused');
    expect(campaign.pauseReason).toContain('Campaign automation frozen');
    expect(campaign.tasks.every((task) => task.status === 'blocked')).toBe(true);
    expect(campaign.tasks.every((task) => task.error?.code === 'CAMPAIGN_MIGRATED_TO_WORK')).toBe(true);

    for (const task of campaign.tasks) {
      const workId = `campaign-${campaign.campaignId}-${task.taskId}`;
      const work = getWorkContract({ controllerHome, repoId: 'repo-a' }, workId);
      expect(work?.workId).toBe(workId);
      expect(work?.status).toBe('blocked');
    }

    const handoffs = listHandoffItems({ controllerHome, repoId: 'repo-a', status: 'all' });
    expect(handoffs).toHaveLength(2);
    expect(listExecutionJobs(controllerHome, 'repo-a', 50)).toHaveLength(0);
  });

  test('automatic campaign ticks no longer dispatch or reconcile', () => {
    const controllerHome = home();
    createCampaign(controllerHome, campaignInput({ requestId: 'tick-1', semanticKey: 'tick-1' }));
    expect(tickCampaigns(controllerHome, ['repo-a'])).toEqual([]);
    expect(listExecutionJobs(controllerHome, 'repo-a', 50)).toHaveLength(0);
  });

  test('normalizes campaign dependency references and legacy operation aliases', () => {
    expect(normalizeCampaignOperationName('launch_task')).toBe('dispatch_task');
    expect(normalizeCampaignOperationName('launch_ready_tasks')).toBe('dispatch_ready_tasks');
    expect(normalizeCampaignDependencyReference('task:T1')).toBe('T1');
    expect(normalizeCampaignDependencyReference('T2')).toBe('T2');
  });

  test('preserves isolated workspace metadata while freezing automation', () => {
    const controllerHome = home();
    const created = createCampaign(controllerHome, campaignInput({
      requestId: 'isolated-1',
      semanticKey: 'isolated-1',
      workspace: { mode: 'isolated', managed: true, checkoutId: 'CHK-isolated' },
    })).campaign;

    const result = reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);

    expect(result.dispatched).toBe(0);
    expect(campaign.workspace.mode).toBe('isolated');
    expect(campaign.workspace.checkoutId).toBe('CHK-isolated');
    expect(campaign.status).toBe('paused');
    expect(listExecutionJobs(controllerHome, 'repo-a', 50)).toHaveLength(0);
  });
});
