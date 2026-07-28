import { describe, expect, test } from 'bun:test';
import {
  summarizeEntityMigrationReport,
  summarizeRepositoryRegistration,
} from '../../src/cli/mcp/repository-tools';
import { summarizeControllerReadyPayload } from '../../src/runtime/gateway/mcp/runtime-tools';
import { RESPONSE_BUDGET } from '../../src/runtime/shared/response-budget';

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('MCP response compaction', () => {
  test('repository registration summary bounds checkout and migration evidence', () => {
    const checkouts = Array.from({ length: 80 }, (_, index) => ({
      checkoutId: `checkout-${index}`,
      localRoot: `/repo/worktrees/${index}`,
      canonicalRoot: `/repo/worktrees/${index}`,
      worktree: index > 0,
      lifecycle: index === 0 ? 'active' : 'archived',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      lastSeenAt: '2026-07-28T00:00:00.000Z',
    }));
    const repository = {
      schemaVersion: 1,
      repoId: 'repo-test',
      displayName: 'fixture',
      localRoot: '/repo',
      canonicalRoot: '/repo',
      activeCheckoutId: 'checkout-0',
      checkouts,
      defaultBranch: 'main',
      repositoryType: 'git',
      enabled: true,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      lastSeenAt: '2026-07-28T00:00:00.000Z',
      stateStorageStrategy: 'hybrid',
    } as Parameters<typeof summarizeRepositoryRegistration>[0];
    const migration = {
      repoId: 'repo-test',
      checkoutId: 'checkout-0',
      scanned: 720,
      updated: 0,
      unresolved: 164,
      files: Array.from({ length: 12 }, (_, index) => `file-${index}`),
      errors: Array.from({ length: 164 }, (_, index) => ({ path: `session-${index}.json`, error: `failure-${index}` })),
    } as Parameters<typeof summarizeRepositoryRegistration>[1];

    const summary = summarizeRepositoryRegistration(repository, migration);
    const migrationSummary = summary.migration as Record<string, unknown>;
    const repositorySummary = summary.repository as Record<string, unknown>;
    expect(bytes(summary)).toBeLessThan(RESPONSE_BUDGET.statusSummaryBytes);
    expect(repositorySummary.checkouts).toBeUndefined();
    expect(repositorySummary.checkoutCount).toBe(80);
    expect((migrationSummary.errors as unknown[]).length).toBe(3);
    expect(migrationSummary.omittedErrorCount).toBe(161);
    expect(migrationSummary.truncated).toBe(true);

    const detail = summarizeRepositoryRegistration(repository, migration, true);
    expect(((detail.repository as typeof repository).checkouts)).toHaveLength(80);
    expect(((detail.migration as typeof migration).errors)).toHaveLength(164);
    expect(summarizeEntityMigrationReport(migration, true)).toBe(migration);
  });

  test('controller readiness summary omits history and full tool arrays', () => {
    const toolNames = Array.from({ length: 150 }, (_, index) => `tool-${index}`);
    const full = {
      repoId: 'repo-test',
      ready: true,
      state: 'ready',
      reasons: [],
      gateway: { ready: true, thin: true },
      health: { state: 'healthy', ready: true, activeBlockers: [], warnings: [], components: { daemon: { ready: true } } },
      operationalView: { history: { recentIncidents: Array.from({ length: 200 }, (_, index) => ({ id: index, message: 'x'.repeat(500) })) } },
      daemon: { source: { commit: 'abc' }, recovery: { repositories: Array.from({ length: 100 }, (_, index) => ({ index })) } },
      durableScheduler: { status: 'ready', heartbeatAgeMs: 100 },
      workerLoop: { queueDepth: 0, runningWorkers: 0, activeLeases: 0 },
      localBridge: { running: true, health: { ready: true } },
      agentExecutors: { executors: Array.from({ length: 100 }, (_, index) => ({ index })) },
      stableSupervisor: {
        ready: true,
        expectedReleaseRevision: 'abc',
        runningReleaseRevision: 'abc',
        generatedServiceReleaseRevision: 'abc',
        installedServiceReleaseRevision: 'abc',
      },
      stableIngress: { localReady: true, state: 'running' },
      externalEndpoint: { status: 'unknown' },
      toolSurface: {
        ready: true,
        expectedTools: toolNames,
        actualTools: toolNames,
        localRegisteredTools: toolNames,
        currentCallableTools: toolNames,
        missingTools: [],
        unexpectedTools: [],
        duplicateTools: [],
        fingerprint: 'fingerprint',
        schemaStableAcrossAccessModes: true,
      },
      registeredRepositories: 12,
      repository: { history: Array.from({ length: 100 }, (_, index) => ({ index })) },
    };

    const summary = summarizeControllerReadyPayload(full);
    expect(bytes(summary)).toBeLessThan(RESPONSE_BUDGET.statusSummaryBytes);
    expect(summary.operationalView).toBeUndefined();
    expect(summary.daemon).toBeUndefined();
    expect(summary.agentExecutors).toBeUndefined();
    expect(summary.repository).toBeUndefined();
    expect((summary.toolSurface as Record<string, unknown>).expectedToolCount).toBe(150);
    expect((summary.detailPointer as Record<string, unknown>).tool).toBe('controller_ready');
  });
});
