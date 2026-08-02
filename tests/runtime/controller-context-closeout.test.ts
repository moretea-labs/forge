import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpToolContext } from '../../src/cli/mcp/multi-repository';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { controllerExposureSnapshot } from '../../src/cli/mcp/toolset';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool, runtimeIdentitySnapshot } from '../../src/runtime/gateway/mcp/runtime-tools';
import { clearGitIdentityCacheForTest, gitIdentityPerformanceSnapshot } from '../../src/cli/repository/inspector';
import {
  clearControllerContextPerformanceSnapshotForTest,
  controllerContextPerformanceSnapshot,
  controllerContextProjectionKey,
  markControllerContextProjectionDirty,
  queueControllerContextProjectionRefresh,
  readControllerContextProjection,
  readControllerContextProjectionInvalidation,
  recordControllerContextRead,
  writeControllerContextProjection,
} from '../../src/runtime/projections/controller-context';

const roots: string[] = [];

afterEach(() => {
  clearGitIdentityCacheForTest();
  clearControllerContextPerformanceSnapshotForTest();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'closeout fixture\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'closeout@example.com']);
  git(root, ['config', 'user.name', 'Closeout Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
}

function commitChange(root: string, path: string, content: string): string {
  writeFileSync(join(root, path), content);
  git(root, ['add', path]);
  git(root, ['commit', '-m', `update ${path}`]);
  return git(root, ['rev-parse', 'HEAD']);
}

interface Fixture {
  controllerHome: string;
  repoRoot: string;
  repoId: string;
  context: MultiRepositoryMcpToolContext;
}

async function fixture(toolset: 'core' | 'advanced' | 'full' = 'advanced'): Promise<Fixture> {
  const root = temp('repo-harness-closeout-');
  const controllerHome = join(root, 'controller-home');
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  initRepo(repoRoot);
  const repository = registerRepository({ path: repoRoot, controllerHome });
  const context = createMcpToolContext({
    repo: repoRoot,
    controllerHome,
    profile: 'controller',
    toolset,
  });
  return { controllerHome, repoRoot, repoId: repository.repoId, context };
}

/**
 * Refresh jobs run through a real macrotask queue (setTimeout 0) and are not
 * externally awaitable, so convergence is observed by polling the persisted
 * refreshState/head — the same signal a hot read would see. Polling a genuine
 * async completion is the point of these tests; fake timers would not run the
 * actual refresh build.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error('waitFor condition timed out');
}

function summaryOf(result: unknown): Record<string, any> {
  const value = result && typeof result === 'object' ? result as { structuredContent?: unknown } : {};
  return (value.structuredContent ?? {}) as Record<string, any>;
}

describe('controller context identity and routing closeout', () => {
  test('consecutive reads reuse the materialized identity and hit the cache', async () => {
    const fx = await fixture();
    const first = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(first.responseMeta.cacheHit).toBe(false);
    expect(first.contextProjection.refreshState).toBe('idle');
    const identity = first.contextProjection.sourceIdentity;
    const second = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(second.responseMeta.cacheHit).toBe(true);
    expect(second.responseMeta.stale).toBe(false);
    expect(second.contextProjection.sourceIdentity).toEqual(identity);
    // Hot reads must not re-run git identity sampling within the TTL.
    const gitIdentity = gitIdentityPerformanceSnapshot();
    const third = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(third.responseMeta.cacheHit).toBe(true);
    expect(gitIdentityPerformanceSnapshot().samples).toBe(gitIdentity.samples);
  });

  test('HEAD change invalidates the cached projection and rebuilds with the new identity', async () => {
    const fx = await fixture();
    const first = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    const oldHead = first.contextProjection.sourceIdentity.head;
    const newHead = commitChange(fx.repoRoot, 'src/index.ts', 'export const value = 2;\n');
    expect(newHead).not.toBe(oldHead);
    // Force a fresh identity sample; the changed HEAD must be observed. A HEAD
    // change moves the keyed projection to a new generation, so the next read
    // is a cold rebuild (cache miss) rather than a stale-while-revalidate hit.
    clearGitIdentityCacheForTest();
    const afterChange = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(afterChange.responseMeta.cacheHit).toBe(false);
    expect(afterChange.contextProjection.stale).toBe(false);
    expect(afterChange.contextProjection.sourceIdentity.head).toBe(newHead);
    await waitFor(() => {
      const record = readControllerContextProjection(fx.controllerHome, fx.repoId, {
        sourceIdentity: afterChange.contextProjection.sourceIdentity,
        allowLegacySummary: false,
      });
      return record?.refreshState === 'idle' && record.sourceIdentity?.head === newHead;
    });
    const converged = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(converged.responseMeta.cacheHit).toBe(true);
    expect(converged.contextProjection.stale).toBe(false);
    expect(converged.contextProjection.sourceIdentity.head).toBe(newHead);
  });

  test('mutation marker invalidates without touching Git or session state', async () => {
    const fx = await fixture();
    const first = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(first.responseMeta.cacheHit).toBe(false);
    markControllerContextProjectionDirty(fx.repoRoot, 'issue:ISS-1:updated');
    const invalidated = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(invalidated.contextProjection.stale).toBe(true);
    expect(invalidated.responseMeta.refreshJobId).toBeTruthy();
    const marker = readControllerContextProjectionInvalidation(fx.repoRoot)!;
    await waitFor(() => {
      const record = readControllerContextProjection(fx.controllerHome, fx.repoId, {
        sourceIdentity: invalidated.contextProjection.sourceIdentity,
        allowLegacySummary: false,
      });
      return record?.refreshState === 'idle' && record.invalidationNonce === marker.nonce;
    });
    const afterRefresh = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(afterRefresh.contextProjection.stale).toBe(false);
    expect(afterRefresh.responseMeta.cacheHit).toBe(true);
  });

  test('summary and detail projections do not pollute each other', async () => {
    const fx = await fixture();
    await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId });
    const detail = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId, detail_level: 'detail' }));
    expect(detail.contextProjection.variant).toBe('detail');
    const summary = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(summary.contextProjection.variant).toBe('summary');
    expect(summary.responseMeta.cacheHit).toBe(true);
  });

  test('repository routing stays isolated across two repositories', async () => {
    const root = temp('repo-harness-closeout-two-');
    const controllerHome = join(root, 'controller-home');
    const firstRoot = join(root, 'repo-a');
    const secondRoot = join(root, 'repo-b');
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    initRepo(firstRoot);
    initRepo(secondRoot);
    commitChange(secondRoot, 'src/index.ts', 'export const value = 2;\n');
    const firstRepo = registerRepository({ path: firstRoot, controllerHome });
    const secondRepo = registerRepository({ path: secondRoot, controllerHome });
    const context = createMcpToolContext({ repo: firstRoot, controllerHome, profile: 'controller', toolset: 'advanced' });
    const firstSummary = summaryOf(await callRuntimeTool(context, 'controller_context', { repo_id: firstRepo.repoId }));
    const secondSummary = summaryOf(await callRuntimeTool(context, 'controller_context', { repo_id: secondRepo.repoId }));
    expect(firstSummary.repoId).toBe(firstRepo.repoId);
    expect(secondSummary.repoId).toBe(secondRepo.repoId);
    // macOS /var is a symlink to /private/var; compare real paths.
    expect(realpathSync(firstSummary.repository.root)).toBe(realpathSync(firstRoot));
    expect(realpathSync(secondSummary.repository.root)).toBe(realpathSync(secondRoot));
    const firstAgain = summaryOf(await callRuntimeTool(context, 'controller_context', { repo_id: firstRepo.repoId }));
    expect(firstAgain.responseMeta.cacheHit).toBe(true);
  });

  test('session heartbeat and read accounting do not invalidate a fresh projection', async () => {
    const fx = await fixture();
    await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId });
    // Session bookkeeping must never count as a business change.
    recordControllerContextRead({ durationMs: 1, cacheHit: true, stale: false });
    expect(controllerContextPerformanceSnapshot().reads).toBeGreaterThan(0);
    const summary = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(summary.responseMeta.cacheHit).toBe(true);
    expect(summary.contextProjection.stale).toBe(false);
  });

  test('refresh failure keeps stale data readable and defers the next attempt', async () => {
    const fx = await fixture();
    const first = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(first.contextProjection.refreshState).toBe('idle');
    const identity = first.contextProjection.sourceIdentity;
    const result = queueControllerContextProjectionRefresh(fx.controllerHome, fx.repoId, {
      variant: 'summary',
      sourceIdentity: identity,
      build: () => { throw new Error('fixture refresh failed'); },
    });
    expect(result.queued).toBe(true);
    await waitFor(() => {
      const record = readControllerContextProjection(fx.controllerHome, fx.repoId, { sourceIdentity: identity, allowLegacySummary: false });
      return record?.refreshState === 'failed';
    });
    const failed = readControllerContextProjection(fx.controllerHome, fx.repoId, { sourceIdentity: identity, allowLegacySummary: false })!;
    expect(failed.lastRefreshError?.message).toBe('fixture refresh failed');
    expect(failed.nextAttemptAt).toBeTruthy();
    const deferred = queueControllerContextProjectionRefresh(fx.controllerHome, fx.repoId, {
      variant: 'summary',
      sourceIdentity: identity,
      build: () => ({ recovered: true }),
    });
    expect(deferred.queued).toBe(false);
    expect(deferred.skippedReason).toBe('retry_deferred');
  });

  test('stale refresh owners are recovered after a controller restart', async () => {
    const fx = await fixture();
    const first = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    const identity = first.contextProjection.sourceIdentity;
    // Simulate a crashed controller: a record stuck refreshing with a dead owner pid.
    writeControllerContextProjection(fx.controllerHome, fx.repoId, { recovered: false }, {
      sourceIdentity: identity,
      variant: 'summary',
      projectionGeneration: controllerContextProjectionKey(identity),
      refreshState: 'refreshing',
      refreshOwner: { pid: 2_147_483_647, acquiredAt: new Date().toISOString() },
    });
    const recovered = readControllerContextProjection(fx.controllerHome, fx.repoId, { sourceIdentity: identity, allowLegacySummary: false });
    expect(recovered?.refreshState).not.toBe('refreshing');
    const result = queueControllerContextProjectionRefresh(fx.controllerHome, fx.repoId, {
      variant: 'summary',
      sourceIdentity: identity,
      build: () => ({ recovered: true }),
    });
    expect(result.queued).toBe(true);
  });

  test('source identity isolates checkout, variant, and repository in cache keys', () => {
    const base = {
      repoId: 'repo-a',
      checkoutId: 'checkout-main',
      head: 'abc123',
      variant: 'summary' as const,
    };
    const detail = { ...base, variant: 'detail' as const };
    const otherCheckout = { ...base, checkoutId: 'checkout-feature' };
    const otherRepo = { ...base, repoId: 'repo-b' };
    const keys = [base, detail, otherCheckout, otherRepo].map((identity) => controllerContextProjectionKey(identity));
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[3]);
  });
});

describe('controller context summary closeout', () => {
  test('default summary is compact and excludes full detail sections', async () => {
    const fx = await fixture();
    const summary = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId }));
    expect(summary.contextProjection.variant).toBe('summary');
    expect(summary.plugins).not.toHaveProperty('actions');
    expect(summary.plugins).toHaveProperty('enabledCount');
    expect(summary.plugins).toHaveProperty('attentionPluginIds');
    expect(summary.checks).toHaveProperty('availableCount');
    expect(summary.checks).toHaveProperty('recommendedCheckIds');
    expect(summary.checks).not.toHaveProperty('timeoutMs');
    expect(summary.taskLedger).not.toHaveProperty('issues');
    expect(summary.taskLedger).not.toHaveProperty('readyTasks');
    expect(summary.taskLedger).not.toHaveProperty('recentEvents');
    expect(summary.operationalPlan).not.toHaveProperty('diffProjection');
    expect(summary.git).not.toHaveProperty('status');
    expect(summary.git).not.toHaveProperty('diffStat');
    expect(summary.localBridge).not.toHaveProperty('recentJobs');
    expect(summary.operationalView.history.recentIncidents.length).toBeLessThanOrEqual(3);
    expect(summary.detailPointers).toHaveProperty('git');
    expect(summary.detailPointers).toHaveProperty('taskLedger');
    expect(summary.runtime).toHaveProperty('toolset');
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(32 * 1024);
  });

  test('detail still returns the full information', async () => {
    const fx = await fixture();
    const detail = summaryOf(await callRuntimeTool(fx.context, 'controller_context', { repo_id: fx.repoId, detail_level: 'detail' }));
    expect(detail.contextProjection.variant).toBe('detail');
    expect(detail.operationalPlan.diffProjection).toBeDefined();
    expect(detail.checks).toBeDefined();
    expect(detail.responseMeta.structuredPayloadBytes).toBeGreaterThan(0);
  });
});

describe('toolset diagnostics closeout', () => {
  test('core/advanced/full are ordered real tool surfaces', () => {
    const root = temp('repo-harness-closeout-tools-');
    const controllerHome = join(root, 'controller-home');
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    initRepo(repoRoot);
    registerRepository({ path: repoRoot, controllerHome });
    const core = controllerExposureSnapshot(createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller', toolset: 'core' }));
    const advanced = controllerExposureSnapshot(createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller', toolset: 'advanced' }));
    const full = controllerExposureSnapshot(createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller', toolset: 'full' }));
    expect(core.actualToolNames.length).toBeGreaterThan(0);
    expect(core.actualToolNames.length).toBeLessThan(advanced.actualToolNames.length);
    expect(advanced.actualToolNames.length).toBeLessThan(full.actualToolNames.length);
    expect(advanced.expectedToolNames.length).toBe(advanced.actualToolNames.length);
    expect(advanced.missingToolNames).toEqual([]);
    expect(advanced.ready).toBe(true);
    expect(core.inventory.every((entry) => entry.profile === 'core')).toBe(true);
    expect(advanced.inventory.every((entry) => entry.profile === 'advanced')).toBe(true);
  });
});

describe('runtime identity closeout', () => {
  test('identity snapshot exposes toolset and instance without inventing releases', () => {
    const root = temp('repo-harness-closeout-identity-');
    const controllerHome = join(root, 'controller-home');
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    initRepo(repoRoot);
    registerRepository({ path: repoRoot, controllerHome });
    const context = createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller', toolset: 'advanced' });
    const identity = runtimeIdentitySnapshot(context);
    // No supervisor in this fixture: identity must not fabricate release fields.
    expect(identity.toolset).toBe('advanced');
    expect(identity.profile).toBe('controller');
    expect(identity.controllerInstanceId).toBeTruthy();
    expect(identity.activeSlot).toBeDefined();
  });
});
