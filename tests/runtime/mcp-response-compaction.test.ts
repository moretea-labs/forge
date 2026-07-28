import { describe, expect, test } from 'bun:test';
import {
  summarizeEntityMigrationReport,
  summarizeRepositoryRegistration,
} from '../../src/cli/mcp/repository-tools';
import { buildControllerReadyRevisionView, summarizeControllerReadyPayload } from '../../src/runtime/gateway/mcp/runtime-tools';
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

  test('controller revision view exposes authoritative identities and fails closed on runtime drift', () => {
    const view = buildControllerReadyRevisionView({
      currentRelease: { releaseRevision: 'release-expected', sourceCommit: 'source-commit' },
      supervisorState: {
        supervisor: { releaseRevision: 'release-expected' },
        controllerDaemon: { releaseRevision: 'release-runtime' },
        gatewayHost: { releaseRevision: 'release-gateway' },
      },
      activeSlotIdentity: { releaseRevision: 'release-slot', sourceCommit: 'slot-source' },
      serviceCoherence: { ok: true, expected: { releaseRevision: 'release-expected' }, failures: [] },
      runtimeCoherence: {
        ok: false,
        legacyReleaseMetadata: false,
        releasePathCoherent: true,
        releaseRevisionCoherent: false,
        releaseCoherent: false,
        generationCoherent: true,
        slotCoherent: true,
        failures: ['release revision mismatch'],
      },
    });
    expect(view).toMatchObject({
      stableSupervisorRevision: 'release-expected',
      activeRuntimeRevision: 'release-runtime',
      activeSlotRevision: 'release-slot',
      gatewayRevision: 'release-gateway',
      sourceRevision: 'source-commit',
      expectedRevision: 'release-expected',
      coherence: {
        ok: false,
        service: { ok: true },
        runtime: { ok: false, releaseRevisionCoherent: false },
      },
    });
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
      stableSupervisorRevision: 'release-a',
      activeRuntimeRevision: 'release-a',
      activeSlotRevision: 'release-a',
      gatewayRevision: 'release-a',
      sourceRevision: 'commit-a',
      expectedRevision: 'release-a',
      coherence: {
        ok: true,
        service: { ok: true, failures: [] },
        runtime: {
          ok: true,
          legacyReleaseMetadata: false,
          releasePathCoherent: true,
          releaseRevisionCoherent: true,
          releaseCoherent: true,
          generationCoherent: true,
          slotCoherent: true,
          failures: [],
        },
      },
      routeBehavior: {
        schemaVersion: 1,
        fingerprint: 'route-fingerprint',
        probeCount: 100,
        probes: Array.from({ length: 100 }, (_, index) => ({ id: `probe-${index}`, path: 'direct', reasons: ['fixture'] })),
      },
      toolSurface: {
        ready: true,
        expectedTools: toolNames,
        actualTools: toolNames,
        localRegisteredTools: toolNames,
        currentCallableTools: toolNames,
        missingTools: [],
        unexpectedTools: [],
        duplicateTools: [],
        fingerprint: 'schema-fingerprint',
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
    expect(summary.stableSupervisorRevision).toBe('release-a');
    expect(summary.activeRuntimeRevision).toBe('release-a');
    expect(summary.activeSlotRevision).toBe('release-a');
    expect(summary.gatewayRevision).toBe('release-a');
    expect(summary.sourceRevision).toBe('commit-a');
    expect(summary.expectedRevision).toBe('release-a');
    expect((summary.coherence as { ok?: boolean }).ok).toBe(true);
    expect((summary.routeBehavior as Record<string, unknown>).fingerprint).toBe('route-fingerprint');
    expect((summary.routeBehavior as Record<string, unknown>).probes).toBeUndefined();
    expect((summary.toolSurface as Record<string, unknown>).fingerprint).not.toBe((summary.routeBehavior as Record<string, unknown>).fingerprint);
    expect((summary.detailPointer as Record<string, unknown>).tool).toBe('controller_ready');
  });
});
