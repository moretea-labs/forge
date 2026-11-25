import { describe, expect, test } from 'bun:test';
import type { RepositoryRecord } from '../../src/core/repository/types';
import type {
  RequirementDispatchCandidate,
  CrossProjectRequirementDispatchSelection,
} from '../../src/runtime/control-plane/facade/cross-project-requirement-dispatch';
import {
  availableAutopilotDispatchSlots,
  dispatchAuthorizedCrossProjectRequirements,
  type AutopilotHostResourceSample,
} from '../../src/runtime/autopilot/cross-project-dispatch';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');

function candidate(
  input: Partial<RequirementDispatchCandidate> &
    Pick<RequirementDispatchCandidate, 'requirementId' | 'projectId' | 'repoId'>,
): RequirementDispatchCandidate {
  return {
    ...input,
    workspaceId: input.workspaceId ?? 'workspace-test',
    requirementRevision: input.requirementRevision ?? 1,
    title: input.title ?? input.requirementId,
    persistedState: input.persistedState ?? 'planned',
    readiness: input.readiness ?? 'ready',
    effectivePriority: input.effectivePriority ?? 'normal',
    prioritySource: input.prioritySource ?? 'system_default',
    blockingRequirementIds: input.blockingRequirementIds ?? [],
    updatedAt: input.updatedAt ?? '2026-11-24T00:00:00.000Z',
  };
}

function selection(ready: RequirementDispatchCandidate[]): CrossProjectRequirementDispatchSelection {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-25T00:00:00.000Z',
    candidates: ready,
    ready,
    counts: { ready: ready.length, blocked: 0, waiting_for_user: 0, done: 0, cancelled: 0, unknown: 0 },
  };
}

function repository(repoId: string, checkoutId: string): RepositoryRecord {
  const at = '2026-11-24T00:00:00.000Z';
  return {
    schemaVersion: 1,
    repoId,
    displayName: repoId,
    localRoot: '/tmp/' + repoId,
    canonicalRoot: '/tmp/' + repoId,
    activeCheckoutId: checkoutId,
    checkouts: [
      {
        checkoutId,
        localRoot: '/tmp/' + repoId,
        canonicalRoot: '/tmp/' + repoId,
        worktree: false,
        branch: 'main',
        createdAt: at,
        updatedAt: at,
        lastSeenAt: at,
        lifecycle: 'active',
      },
    ],
    repositoryType: 'git',
    enabled: true,
    createdAt: at,
    updatedAt: at,
    lastSeenAt: at,
    configurationPath: '/tmp/' + repoId + '/.forge',
    stateStorageStrategy: 'controller-home',
  };
}

function grant(requirementId: string, repoId: string, checkoutId: string, requirementRevision = 1) {
  return {
    schemaVersion: 1 as const,
    grantId: 'grant-' + requirementId,
    principalId: 'test-user',
    ownerScope: `forge-autopilot:${repoId}:${requirementId}`,
    capabilities: ['autopilot:execute'],
    target: { kind: 'requirement', id: requirementId, repoId },
    riskCeiling: 'workspace_write' as const,
    constraints: { requirementRevision, checkoutId, provider: 'joycode' },
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    expiresAt: '2026-11-26T00:00:00.000Z',
  };
}

const host: AutopilotHostResourceSample = {
  cpuCount: 8,
  load1: 1,
  freeMemoryBytes: 8 * GIB,
  totalMemoryBytes: 16 * GIB,
};

describe('cross-project Requirement Autopilot dispatch (#707)', () => {
  test('skips an ungranted urgent Requirement and continues to a granted independent Requirement', () => {
    const urgent = candidate({
      requirementId: 'REQ-URGENT-NO-GRANT',
      projectId: 'project-a',
      repoId: 'repo-a',
      effectivePriority: 'urgent',
      prioritySource: 'requirement',
    });
    const ready = candidate({
      requirementId: 'REQ-READY',
      projectId: 'project-b',
      repoId: 'repo-b',
      effectivePriority: 'normal',
    });
    const started: string[] = [];
    const sources: string[] = [];
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-b', 'checkout-b')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([urgent, ready]),
        listGrants: () => [grant('REQ-READY', 'repo-b', 'checkout-b')],
        listPlacements: () => [],
        sampleHostResources: () => host,
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: () => undefined,
        start: ({ requirementId, dispatchSource }) => {
          started.push(requirementId);
          sources.push(dispatchSource ?? 'missing');
          return {} as never;
        },
      },
    );

    expect(started).toEqual(['REQ-READY']);
    expect(sources).toEqual(['global_scheduler']);
    expect(result.startedRequirementIds).toEqual(['REQ-READY']);
    expect(result.decisions.map((entry) => [entry.requirementId, entry.outcome])).toEqual([
      ['REQ-URGENT-NO-GRANT', 'not_authorized'],
      ['REQ-READY', 'started'],
    ]);
  });

  test('stale authorization and unavailable checkouts are local blockers, not global stops', () => {
    const stale = candidate({
      requirementId: 'REQ-STALE',
      projectId: 'project-a',
      repoId: 'repo-a',
      effectivePriority: 'urgent',
    });
    const checkoutMissing = candidate({
      requirementId: 'REQ-MISSING-CHECKOUT',
      projectId: 'project-b',
      repoId: 'repo-b',
    });
    const ready = candidate({ requirementId: 'REQ-READY-AFTER-BLOCKERS', projectId: 'project-c', repoId: 'repo-c' });
    const started: string[] = [];
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-a', 'checkout-a'), repository('repo-c', 'checkout-c')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([stale, checkoutMissing, ready]),
        listGrants: () => [
          grant('REQ-STALE', 'repo-a', 'checkout-a', 2),
          grant('REQ-MISSING-CHECKOUT', 'repo-b', 'checkout-b'),
          grant('REQ-READY-AFTER-BLOCKERS', 'repo-c', 'checkout-c'),
        ],
        listPlacements: () => [],
        sampleHostResources: () => host,
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: () => undefined,
        start: ({ requirementId }) => {
          started.push(requirementId);
          return {} as never;
        },
      },
    );

    expect(started).toEqual(['REQ-READY-AFTER-BLOCKERS']);
    expect(result.decisions.map((entry) => entry.outcome)).toEqual([
      'stale_authorization',
      'checkout_unavailable',
      'started',
    ]);
  });

  test('recovers a persisted running Run after Runtime restart without creating a duplicate', () => {
    const ready = candidate({ requirementId: 'REQ-RECOVER', projectId: 'project-a', repoId: 'repo-a' });
    const exactGrant = grant('REQ-RECOVER', 'repo-a', 'checkout-a');
    const resumed: string[] = [];
    const started: string[] = [];
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-a', 'checkout-a')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([ready]),
        listGrants: () => [exactGrant],
        listPlacements: () => [],
        sampleHostResources: () => host,
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: () => ({ value: { grantId: exactGrant.grantId, status: 'running' } }) as never,
        start: ({ requirementId }) => {
          started.push(requirementId);
          return {} as never;
        },
        resume: ({ requirementId }) => {
          resumed.push(requirementId);
          return {} as never;
        },
      },
    );

    expect(started).toEqual([]);
    expect(resumed).toEqual(['REQ-RECOVER']);
    expect(result.resumedRequirementIds).toEqual(['REQ-RECOVER']);
  });

  test('does not auto-resume paused or terminal Runs', () => {
    const paused = candidate({ requirementId: 'REQ-PAUSED', projectId: 'project-a', repoId: 'repo-a' });
    const completed = candidate({ requirementId: 'REQ-COMPLETED', projectId: 'project-b', repoId: 'repo-b' });
    const grants = [grant('REQ-PAUSED', 'repo-a', 'checkout-a'), grant('REQ-COMPLETED', 'repo-b', 'checkout-b')];
    const resumed: string[] = [];
    const started: string[] = [];
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-a', 'checkout-a'), repository('repo-b', 'checkout-b')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([paused, completed]),
        listGrants: () => grants,
        listPlacements: () => [],
        sampleHostResources: () => host,
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: (_home, repoId) =>
          ({
            value: {
              grantId: grants.find((entry) => entry.target.repoId === repoId)!.grantId,
              status: repoId === 'repo-a' ? 'paused' : 'completed',
            },
          }) as never,
        start: ({ requirementId }) => {
          started.push(requirementId);
          return {} as never;
        },
        resume: ({ requirementId }) => {
          resumed.push(requirementId);
          return {} as never;
        },
      },
    );

    expect(started).toEqual([]);
    expect(resumed).toEqual([]);
    expect(result.decisions.map((entry) => entry.outcome)).toEqual(['run_paused', 'run_terminal']);
  });

  test('continues after a provider failure and dispatches the next independent Requirement', () => {
    const first = candidate({
      requirementId: 'REQ-PROVIDER-FAIL',
      projectId: 'project-a',
      repoId: 'repo-a',
      effectivePriority: 'urgent',
    });
    const second = candidate({ requirementId: 'REQ-NEXT', projectId: 'project-b', repoId: 'repo-b' });
    const started: string[] = [];
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-a', 'checkout-a'), repository('repo-b', 'checkout-b')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([first, second]),
        listGrants: () => [
          grant('REQ-PROVIDER-FAIL', 'repo-a', 'checkout-a'),
          grant('REQ-NEXT', 'repo-b', 'checkout-b'),
        ],
        listPlacements: () => [],
        sampleHostResources: () => host,
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: () => undefined,
        start: ({ requirementId }) => {
          if (requirementId === 'REQ-PROVIDER-FAIL') throw new Error('AUTOPILOT_PROVIDER_UNAVAILABLE');
          started.push(requirementId);
          return {} as never;
        },
      },
    );

    expect(started).toEqual(['REQ-NEXT']);
    expect(result.decisions.map((entry) => entry.outcome)).toEqual(['dispatch_failed', 'started']);
  });

  test('computes capacity from live CPU and memory headroom and fails closed on unknown samples', () => {
    expect(availableAutopilotDispatchSlots({ sample: host, activeLoops: 1 })).toBe(3);
    expect(
      availableAutopilotDispatchSlots({
        sample: { ...host, load1: 20 },
        activeLoops: 0,
      }),
    ).toBe(0);
    expect(
      availableAutopilotDispatchSlots({
        sample: { ...host, freeMemoryBytes: Number.NaN },
        activeLoops: 0,
      }),
    ).toBe(0);
  });

  test('does not dispatch when dynamic host capacity is exhausted', () => {
    const ready = candidate({ requirementId: 'REQ-CAPACITY', projectId: 'project-a', repoId: 'repo-a' });
    let starts = 0;
    const result = dispatchAuthorizedCrossProjectRequirements(
      {
        controllerHome: '/controller',
        repositories: [repository('repo-a', 'checkout-a')],
        nowMs: NOW,
      },
      {
        selectCandidates: () => selection([ready]),
        listGrants: () => [grant('REQ-CAPACITY', 'repo-a', 'checkout-a')],
        listPlacements: () => [],
        sampleHostResources: () => ({ ...host, load1: 20 }),
        activeLoopCount: () => 0,
        isLoopActive: () => false,
        readRun: () => undefined,
        start: () => {
          starts += 1;
          return {} as never;
        },
      },
    );

    expect(starts).toBe(0);
    expect(result.decisions[0]?.outcome).toBe('capacity');
  });
});
