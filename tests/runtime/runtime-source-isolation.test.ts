import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import {
  collectRuntimeSourceIdentity,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  evaluateActiveRuntimeSourceDrift,
  evaluateRuntimeSourceDrift,
  formatRuntimeSourceDriftMessage,
  packageRuntimeSourceRoot,
  readRuntimeGeneration,
  resolveControllerRuntimeSourceRoot,
  rotateRuntimeGeneration,
} from '../../src/runtime/control-plane/runtime-generation';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';
import {
  resolveLightweightPluginActionRuntimeInvocation,
  startLightweightPluginAction,
  waitLightweightPluginAction,
} from '../../src/runtime/plugins/lightweight-action';
import { submitAssistantPluginAction } from '../../src/runtime/plugins/store';
import { startGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { createWorkContract, type WorkContract } from '../../packages/kernel/work/api/index';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

const roots: string[] = [];
const previousEnv = process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];
  else process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = previousEnv;
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initGitRepo(repoRoot: string, name: string): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name }, null, 2));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
}

function pinRuntimeSource(root: string): void {
  process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = root;
}

function mcpContext(controllerHome: string, repository: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  const policy = getMcpPolicy('controller', { repoRoot: repository.canonicalRoot });
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy,
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, unknown>;
}

function createProjectionWork(
  controllerHome: string,
  repository: ReturnType<typeof registerRepository>,
  workId: string,
): WorkContract {
  return createWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    mode: 'goal_workloop',
    objective: `Project ${workId} through bounded Runtime facade reads.`,
    acceptanceCriteria: ['Runtime facade reads remain available.'],
    constraints: { requireHandoffOnAmbiguity: true, workspaceMode: 'isolated', requireWorktree: true },
    requestedBy: 'chatgpt',
    status: 'running',
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
  });
}

function corruptProjectionWork(controllerHome: string, repoId: string, workId: string): void {
  const record = readControlPlaneRecord<WorkContract>(controllerHome, 'work_contract', repoId, workId)!;
  writeControlPlaneRecord(controllerHome, {
    namespace: 'work_contract', scope: repoId, key: workId, schemaVersion: 2,
    expectedRevision: record.revision, action: 'test_malformed_runtime_facade_projection',
    value: {
      ...record.value,
      phase: 'delivery',
      phaseEvidence: {
        ...record.value.phaseEvidence,
        implementation: { ...record.value.phaseEvidence.implementation, state: 'satisfied' },
        verification: { ...record.value.phaseEvidence.verification, state: 'satisfied' },
        review: { ...record.value.phaseEvidence.review, state: 'pending' },
        delivery: { ...record.value.phaseEvidence.delivery, state: 'active' },
      },
    },
  });
}

describe('runtime source isolation', () => {
  test('resolver prefers package root over ambient execution cwd', () => {
    const business = tempRoot('forge-business-cwd-');
    initGitRepo(business, 'business-app');
    const resolved = resolveControllerRuntimeSourceRoot({ cwd: business, env: {} });
    expect(resolved.reason).toBe('package-root');
    expect(resolved.root).toBe(packageRuntimeSourceRoot());
    expect(realpathSync(resolved.root!)).not.toBe(realpathSync(business));
  });

  test('package Runtime lightweight ios.build reaches its handler from a non-Forge repository cwd', async () => {
    const business = tempRoot('forge-business-ios-lightweight-');
    const controllerHome = tempRoot('forge-home-ios-lightweight-');
    const releaseRoot = tempRoot('forge-package-release-ios-lightweight-');
    const fakeBin = tempRoot('forge-ios-lightweight-bin-');
    initGitRepo(business, 'business-ios-app');
    mkdirSync(join(business, 'Business.xcodeproj'), { recursive: true });
    writeFileSync(join(business, 'Business.xcodeproj', 'project.pbxproj'), '// lightweight iOS fixture\n');
    ensureControllerHome(controllerHome);
    git(business, 'add', '.');
    git(business, 'commit', '-m', 'add iOS fixture');
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Business iOS app' });
    const startedWork = startGoalWorkloop({
      workStore: { controllerHome, repoId: repository.repoId },
      handoffStore: { controllerHome, repoId: repository.repoId },
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
    }, {
      objective: 'Build the non-Forge iOS fixture through the typed plugin action.',
      acceptanceCriteria: ['The lightweight iOS build reaches xcodebuild.'],
      allowedPaths: ['**'], forbiddenPaths: [], checks: [],
      modeInput: {
        scopeClear: true, mutation: true, requiresExternalEffect: false, remoteWrite: false,
        requiresRecovery: false, requiresWorker: false, requiresApproval: false,
      },
    });
    const workId = String((startedWork.data as { work?: { workId?: string } }).work?.workId ?? '');
    expect(workId).toBeTruthy();
    symlinkSync(packageRuntimeSourceRoot(), join(releaseRoot, 'package'), 'dir');
    expect(existsSync(join(business, 'src', 'runtime', 'shared', 'node-ts-loader.mjs'))).toBe(false);

    const invocation = resolveLightweightPluginActionRuntimeInvocation({
      releasePath: releaseRoot,
      sourceDir: '/$bunfs/runtime/plugins',
      nodeExecutable: '/runtime-owned/trusted-node',
    });
    expect(invocation).toMatchObject({ identity: 'package_release_node', executable: '/runtime-owned/trusted-node' });
    expect(invocation.argsPrefix[1]).toBe(join(releaseRoot, 'package', 'src', 'runtime', 'shared', 'node-ts-loader.mjs'));
    expect(invocation.argsPrefix[2]).toBe(join(releaseRoot, 'package', 'src', 'runtime', 'plugins', 'plugin-action-sidecar.ts'));
    expect(invocation.argsPrefix.join(' ')).not.toContain('/$bunfs/');
    expect(invocation.argsPrefix.join(' ')).not.toContain(business);
    if (process.platform !== 'darwin') return;

    writeFileSync(join(fakeBin, 'xcodebuild'), `#!/bin/sh
if [ "$1" = "-version" ]; then
  printf 'Xcode 16.0\\nBuild version 16A000\\n'
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "-list" ]; then
    printf '{"project":{"schemes":["Business"]}}\\n'
    exit 0
  fi
done
derived=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-derivedDataPath" ]; then
    derived="$arg"
    break
  fi
  previous="$arg"
done
if [ -n "$derived" ]; then
  mkdir -p "$derived/Build/Products/Debug-iphonesimulator/Business.app"
fi
printf 'BUILD SUCCEEDED\\n'
`, { mode: 0o700 });

    const previousReleasePath = process.env.FORGE_RELEASE_PATH;
    const previousPath = process.env.PATH;
    process.env.FORGE_RELEASE_PATH = releaseRoot;
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    const request = {
      pluginId: 'ios',
      actionId: 'build',
      requestId: 'non-forge-package-runtime-ios-build',
      workId,
      args: { scheme: 'Business', project: 'Business.xcodeproj', simulator_name: 'iPhone 16 Pro' },
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    try {
      const started = await startLightweightPluginAction({
        controllerHome,
        repository,
        request,
        interactiveWaitMs: 5_000,
        timeoutMs: 15_000,
      });
      const completed = started.handle.completed
        ? started.handle
        : await waitLightweightPluginAction(controllerHome, repository.repoId, started.handle.processId, 15_000);
      expect(completed.ok).toBe(true);
      expect(completed.workId).toBe(workId);
      expect(`${completed.stdoutTail ?? ''}\n${completed.stderrTail ?? ''}`).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(`${completed.stdoutTail ?? ''}\n${completed.stderrTail ?? ''}`).not.toContain('/$bunfs/');
      const submitted = await submitAssistantPluginAction(controllerHome, repository, request);
      expect(submitted.deduplicated).toBe(true);
      expect(submitted.workId).toBe(workId);
      expect(submitted.receipt.workId).toBe(workId);
      expect(submitted.action.resourceClaims).toEqual([
        { resource: 'workspace', mode: 'write' },
        { resource: 'repo-state', mode: 'write' },
      ]);
      expect(submitted.result?.result).toMatchObject({ ready: true, ok: true, scheme: 'Business' });
      expect(String((submitted.result?.result as Record<string, unknown>).appPath ?? '')).toContain('Business.app');
    } finally {
      if (previousReleasePath === undefined) delete process.env.FORGE_RELEASE_PATH;
      else process.env.FORGE_RELEASE_PATH = previousReleasePath;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('immutable release identity never inherits a newer ambient parent Git HEAD', () => {
    const parent = tempRoot('forge-release-parent-');
    initGitRepo(parent, 'controller-runtime-fixture');
    const sourceCommit = git(parent, 'rev-parse', 'HEAD');
    const releaseRoot = join(parent, '_ops', 'controller-home', 'supervisor', 'releases', `release-${sourceCommit}`);
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 3,
      releaseRevision: sourceCommit,
      sourceCommit,
      cleanWorkspace: true,
    }));

    writeFileSync(join(parent, 'src', 'newer-main.ts'), 'export const newerMain = true;\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'advance ambient main');
    const ambientHead = git(parent, 'rev-parse', 'HEAD');
    expect(ambientHead).not.toBe(sourceCommit);

    const identity = collectRuntimeSourceIdentity(releaseRoot);
    expect(identity.canonicalRoot).toBe(realpathSync(releaseRoot));
    expect(identity.branch).toBeNull();
    expect(identity.commit).toBe(sourceCommit);
    expect(identity.releaseRevision).toBe(sourceCommit);
    expect(identity.defaultBranchCommit).toBe(sourceCommit);
    expect(identity.dirty).toBe(false);
  });

  test('immutable Runtime drift evaluation self-validates the frozen release instead of the long-lived MCP source checkout', () => {
    const parent = tempRoot('forge-release-drift-parent-');
    initGitRepo(parent, 'controller-runtime-fixture');
    const sourceCommit = git(parent, 'rev-parse', 'HEAD');
    const releaseRoot = join(parent, '_ops', 'controller-home', 'runtime', 'releases', `release-${sourceCommit}`);
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 3,
      releaseRevision: sourceCommit,
      sourceCommit,
      cleanWorkspace: true,
    }));
    const active = collectRuntimeSourceIdentity(releaseRoot);
    pinRuntimeSource(parent);
    writeFileSync(join(parent, 'src', 'gateway-main-advanced.ts'), 'export const gatewayAdvanced = true;\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'advance long-lived gateway source');

    const drift = evaluateActiveRuntimeSourceDrift(active);
    expect(drift.restartRequired).toBe(false);
    expect(drift.code).toBe('RUNTIME_SOURCE_OK');
    expect(drift.current?.canonicalRoot).toBe(realpathSync(releaseRoot));
    expect(drift.current?.releaseRevision).toBe(sourceCommit);
  });

  test('inherited immutable release binding does not replace an explicitly inspected independent source root', () => {
    const releaseParent = tempRoot('forge-bound-release-parent-');
    initGitRepo(releaseParent, 'controller-runtime-fixture');
    const releaseCommit = git(releaseParent, 'rev-parse', 'HEAD');
    const releaseRoot = join(releaseParent, '_ops', 'controller-home', 'runtime', 'releases', `release-${releaseCommit}`);
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 3,
      releaseId: `release-${releaseCommit}`,
      releaseRevision: `release-${releaseCommit}`,
      sourceCommit: releaseCommit,
      cleanWorkspace: true,
    }));
    const sourceRoot = tempRoot('forge-independent-source-');
    initGitRepo(sourceRoot, 'independent-controller-source');
    const previous = {
      path: process.env.FORGE_RELEASE_PATH,
      id: process.env.FORGE_RELEASE_ID,
      revision: process.env.FORGE_RELEASE_REVISION,
      sourceCommit: process.env.FORGE_RELEASE_SOURCE_COMMIT,
      clean: process.env.FORGE_RELEASE_CLEAN_WORKSPACE,
    };
    process.env.FORGE_RELEASE_PATH = releaseRoot;
    process.env.FORGE_RELEASE_ID = `release-${releaseCommit}`;
    process.env.FORGE_RELEASE_REVISION = `release-${releaseCommit}`;
    process.env.FORGE_RELEASE_SOURCE_COMMIT = releaseCommit;
    process.env.FORGE_RELEASE_CLEAN_WORKSPACE = 'true';
    try {
      const sourceIdentity = collectRuntimeSourceIdentity(sourceRoot);
      expect(sourceIdentity.canonicalRoot).toBe(realpathSync(sourceRoot));
      expect(sourceIdentity.releaseRevision).toBeUndefined();
      const releaseIdentity = collectRuntimeSourceIdentity(releaseRoot);
      expect(releaseIdentity.canonicalRoot).toBe(realpathSync(releaseRoot));
      expect(releaseIdentity.releaseRevision).toBe(`release-${releaseCommit}`);
    } finally {
      const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
      restore('FORGE_RELEASE_PATH', previous.path);
      restore('FORGE_RELEASE_ID', previous.id);
      restore('FORGE_RELEASE_REVISION', previous.revision);
      restore('FORGE_RELEASE_SOURCE_COMMIT', previous.sourceCommit);
      restore('FORGE_RELEASE_CLEAN_WORKSPACE', previous.clean);
    }
  });

  test('malformed immutable release manifest fails closed instead of using ambient Git identity', () => {
    const parent = tempRoot('forge-invalid-release-parent-');
    initGitRepo(parent, 'controller-runtime-fixture');
    const releaseRoot = join(parent, '_ops', 'controller-home', 'supervisor', 'releases', 'invalid-release');
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'manifest.json'), JSON.stringify({ sourceCommit: git(parent, 'rev-parse', 'HEAD') }));

    expect(() => collectRuntimeSourceIdentity(releaseRoot)).toThrow(/RUNTIME_RELEASE_MANIFEST_INCOMPLETE/);
  });

  test('execution repository is never used as current runtime source for drift', () => {
    const runtimeRoot = tempRoot('forge-runtime-src-');
    const businessRoot = tempRoot('forge-business-src-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(businessRoot, 'business-app');
    git(businessRoot, 'checkout', '-b', 'perf-i18n-global-opt');

    const active = collectRuntimeSourceIdentity(runtimeRoot);
    pinRuntimeSource(runtimeRoot);

    const withExecutionOverride = evaluateRuntimeSourceDrift(
      active,
      collectRuntimeSourceIdentity(businessRoot),
    );
    expect(withExecutionOverride.restartRequired).toBe(true);
    expect(withExecutionOverride.reasons.some((reason) => reason.includes('runtime source root moved'))).toBe(true);

    const isolated = evaluateActiveRuntimeSourceDrift(active);
    expect(isolated.restartRequired).toBe(false);
    expect(isolated.code).toBe('RUNTIME_SOURCE_OK');
    expect(isolated.current?.canonicalRoot).toBe(realpathSync(runtimeRoot));
    expect(isolated.current?.branch).toBe('main');
  });

  test('session-like repository switch leaves generation identity unchanged', () => {
    const runtimeRoot = tempRoot('forge-runtime-gen-');
    const repoA = tempRoot('forge-exec-a-');
    const repoB = tempRoot('forge-exec-b-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(repoA, 'business-a');
    initGitRepo(repoB, 'business-b');
    pinRuntimeSource(runtimeRoot);

    const controllerHome = tempRoot('forge-runtime-home-');
    ensureControllerHome(controllerHome);
    const before = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    const beforeRaw = readFileSync(join(controllerHome, 'system', 'runtime-generation.json'), 'utf8');

    // Simulate bind/switch of execution repositories without rotating generation.
    registerRepository({ path: repoA, controllerHome, displayName: 'A' });
    registerRepository({ path: repoB, controllerHome, displayName: 'B' });
    const after = readRuntimeGeneration(controllerHome);
    const afterRaw = readFileSync(join(controllerHome, 'system', 'runtime-generation.json'), 'utf8');

    expect(after?.generation).toBe(before.generation);
    expect(after?.revision).toBe(before.revision);
    expect(after?.source.canonicalRoot).toBe(before.source.canonicalRoot);
    expect(afterRaw).toBe(beforeRaw);

    const drift = evaluateActiveRuntimeSourceDrift(after?.source);
    expect(drift.restartRequired).toBe(false);
  });

  test('missing runtime snapshot is fail-closed with structured message', () => {
    const drift = evaluateRuntimeSourceDrift(undefined, collectRuntimeSourceIdentity(packageRuntimeSourceRoot()));
    expect(drift.restartRequired).toBe(true);
    expect(drift.code).toBe('RUNTIME_SOURCE_SNAPSHOT_MISSING');
    expect(drift.reasons).toEqual(['Controller runtime source snapshot is missing']);
    expect(formatRuntimeSourceDriftMessage(drift)).toContain('snapshot is missing');
    expect(formatRuntimeSourceDriftMessage(drift)).not.toContain('execution workspace');
  });

  test('true runtime source dirty triggers stale with accurate message', () => {
    const runtimeRoot = tempRoot('forge-runtime-dirty-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    const active = collectRuntimeSourceIdentity(runtimeRoot);
    writeFileSync(join(runtimeRoot, 'src', 'runtime-change.ts'), 'export const changed = true;\n');
    pinRuntimeSource(runtimeRoot);

    const drift = evaluateActiveRuntimeSourceDrift(active);
    expect(drift.restartRequired).toBe(true);
    expect(drift.code).toBe('RUNTIME_SOURCE_SNAPSHOT_STALE');
    expect(drift.reasons).toContain('runtime source files changed after startup');
    expect(formatRuntimeSourceDriftMessage(drift)).toContain('Controller runtime source changed after startup');
  });

  test('accepts a clean non-default branch as the authoritative runtime checkout', () => {
    const runtimeRoot = tempRoot('forge-runtime-stable-branch-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    git(runtimeRoot, 'checkout', '-b', 'codex/canonical-stable-baseline');
    const active = collectRuntimeSourceIdentity(runtimeRoot);

    writeFileSync(join(runtimeRoot, 'src', 'main-only-change.ts'), 'export const mainOnly = true;\n');
    git(runtimeRoot, 'checkout', 'main');
    git(runtimeRoot, 'add', '.');
    git(runtimeRoot, 'commit', '-m', 'main diverges from stable runtime');
    git(runtimeRoot, 'checkout', 'codex/canonical-stable-baseline');

    const current = collectRuntimeSourceIdentity(runtimeRoot);
    expect(current.defaultBranch).toBe('main');
    expect(current.defaultBranchCommit).not.toBe(active.commit);
    const drift = evaluateRuntimeSourceDrift(active, current);

    expect(drift.restartRequired).toBe(false);
    expect(drift.code).toBe('RUNTIME_SOURCE_OK');
  });

  test('MCP rh_status does not mark RUNTIME_SOURCE stale for a different execution repository', async () => {
    const runtimeRoot = tempRoot('forge-runtime-mcp-');
    const businessRoot = tempRoot('forge-business-mcp-');
    const controllerHome = tempRoot('forge-home-mcp-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(businessRoot, 'business-app');
    git(businessRoot, 'checkout', '-b', 'perf-i18n-global-opt');
    pinRuntimeSource(runtimeRoot);
    ensureControllerHome(controllerHome);

    const generation = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
      generation: generation.generation,
      source: generation.source,
    });
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`, 'utf8');
    writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    });

    const repository = registerRepository({ path: businessRoot, controllerHome, displayName: 'Business' });
    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId,
      operation: 'get',
    }));
    const data = payload.data as {
      readiness: { ready: boolean; reasonCodes: string[] };
      repositoryState?: { branch?: string | null };
      runtime?: { source?: { canonicalRoot?: string; branch?: string | null } };
      controllerSnapshot?: { activeWork?: unknown[]; activePlans?: unknown[]; pendingHandoffs?: unknown[]; bounded?: boolean };
    };
    expect(data.readiness.reasonCodes.some((code) => code.startsWith('RUNTIME_SOURCE'))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('runtime source root moved');
    expect(data.controllerSnapshot).toMatchObject({ bounded: true });
    expect(Array.isArray(data.controllerSnapshot?.activeWork)).toBe(true);
    expect(Array.isArray(data.controllerSnapshot?.activePlans)).toBe(true);
    // repository state still reflects the business checkout
    if (data.repositoryState?.branch) {
      expect(data.repositoryState.branch).toBe('perf-i18n-global-opt');
    }
  });

  test('rh_status row-isolates malformed active Work while keeping bounded diagnostics', async () => {
    const runtimeRoot = tempRoot('forge-runtime-status-invalid-work-');
    const business = tempRoot('forge-status-invalid-work-');
    const controllerHome = tempRoot('forge-home-status-invalid-work-');
    initGitRepo(runtimeRoot, 'status-invalid-work-runtime');
    initGitRepo(business, 'status-invalid-work');
    pinRuntimeSource(runtimeRoot);
    ensureControllerHome(controllerHome);
    const generation = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
      generation: generation.generation,
      source: generation.source,
    });
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`, 'utf8');
    writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    });
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Status Invalid Work' });
    const valid = createProjectionWork(controllerHome, repository, 'work-status-valid');
    const malformed = createProjectionWork(controllerHome, repository, 'work-status-malformed');
    corruptProjectionWork(controllerHome, repository.repoId, malformed.workId);

    const summaryPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'summary',
    }));
    const summary = summaryPayload.data as {
      controllerSnapshot?: {
        activeWork?: Array<{ workId?: string }>;
        invalidActiveWorkCount?: number;
        invalidActiveWork?: Array<{ workId?: string; error?: string }>;
      };
    };
    expect(summary.controllerSnapshot?.activeWork?.some((entry) => entry.workId === valid.workId)).toBe(true);
    expect(summary.controllerSnapshot?.invalidActiveWorkCount).toBe(1);
    expect(summary.controllerSnapshot?.invalidActiveWork?.[0]).toMatchObject({
      workId: malformed.workId,
      error: expect.stringContaining('WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: review'),
    });

    const detailPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'detail',
    }));
    expect(detailPayload.error).toBeUndefined();
    const detail = detailPayload.data as {
      activeContractCount?: number;
      invalidActiveContractCount?: number;
      invalidActiveContracts?: Array<{ workId?: string; error?: string }>;
    };
    expect(detail.activeContractCount).toBe(1);
    expect(detail.invalidActiveContractCount).toBe(1);
    expect(detail.invalidActiveContracts?.[0]).toMatchObject({ workId: malformed.workId });
  });

  test('rh_context row-isolates malformed active Work for repository-wide get/list reads', async () => {
    const business = tempRoot('forge-context-invalid-work-');
    const controllerHome = tempRoot('forge-home-context-invalid-work-');
    initGitRepo(business, 'context-invalid-work');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Invalid Work' });
    const valid = createProjectionWork(controllerHome, repository, 'work-context-valid');
    const malformed = createProjectionWork(controllerHome, repository, 'work-context-malformed');
    corruptProjectionWork(controllerHome, repository.repoId, malformed.workId);

    const summaryPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'summary',
    }));
    const summary = summaryPayload.data as {
      activeWork?: Array<{ workId?: string }>;
      invalidActiveWork?: Array<{ workId?: string; error?: string }>;
      counts?: { invalidActiveWork?: number; invalidActiveWorkShown?: number };
    };
    expect(summary.activeWork?.some((entry) => entry.workId === valid.workId)).toBe(true);
    expect(summary.counts).toMatchObject({ invalidActiveWork: 1, invalidActiveWorkShown: 1 });
    expect(summary.invalidActiveWork?.[0]).toMatchObject({
      workId: malformed.workId,
      error: expect.stringContaining('WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: review'),
    });

    const detailPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId, operation: 'list', detail_level: 'detail',
    }));
    const detail = detailPayload.data as {
      activeWork?: Array<{ workId?: string }>;
      invalidActiveWork?: Array<{ workId?: string }>;
      counts?: { invalidActiveWork?: number };
    };
    expect(detail.activeWork?.some((entry) => entry.workId === valid.workId)).toBe(true);
    expect(detail.counts?.invalidActiveWork).toBe(1);
    expect(detail.invalidActiveWork?.[0]).toMatchObject({ workId: malformed.workId });
  });

  test('rh_context Work summary defers plugin capability and historical process hydration', async () => {
    const business = tempRoot('forge-context-summary-fast-');
    const controllerHome = tempRoot('forge-home-context-summary-fast-');
    initGitRepo(business, 'context-summary-fast');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Summary Fast' });
    const started = startGoalWorkloop({
      workStore: { controllerHome, repoId: repository.repoId },
      handoffStore: { controllerHome, repoId: repository.repoId },
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
    }, {
      objective: 'Keep one bounded Work available for fast summary projection.',
      acceptanceCriteria: ['Summary projection remains bounded.'],
      allowedPaths: ['**'], forbiddenPaths: [], checks: [],
      modeInput: {
        scopeClear: true, mutation: true, requiresExternalEffect: false, remoteWrite: false,
        requiresRecovery: false, requiresWorker: false, requiresApproval: false,
      },
    });
    const workId = String((started.data as { work?: { workId?: string } }).work?.workId ?? '');
    expect(workId).toBeTruthy();
    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      work_id: workId,
      detail_level: 'summary',
    }));
    const data = payload.data as {
      capabilityInventory?: { mode?: string; deferred?: boolean };
      counts?: { capabilityInventoryDeferred?: boolean; historicalProcessScanDeferred?: boolean };
      work?: { workId?: string };
    };
    expect(data.work?.workId).toBe(workId);
    expect(data.capabilityInventory).toEqual(expect.objectContaining({ mode: 'detail_only', deferred: true }));
    expect(data.counts).toEqual(expect.objectContaining({ capabilityInventoryDeferred: true, historicalProcessScanDeferred: true }));
    expect('capabilityCount' in data).toBe(false);
  });

  test('rh_context search exposes multi-wave readiness and folds semantic failures into mutation readiness', async () => {
    const business = tempRoot('forge-context-readiness-facade-');
    const controllerHome = tempRoot('forge-home-context-readiness-facade-');
    initGitRepo(business, 'context-readiness-facade');
    writeFileSync(join(business, 'src', 'index.ts'), "import { helper } from './helper';\nexport const ENTRY_MARKER = helper;\n");
    writeFileSync(join(business, 'src', 'helper.ts'), 'export const helper = 42;\n');
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Readiness Facade' });
    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId, operation: 'search', query: 'ENTRY_MARKER', known_paths: ['src/index.ts'], retrieval_mode: 'review', structural_context: 'off', max_files: 4, max_snippets: 8,
      semantic_navigation: [{ navigation: 'references', path: 'src/index.ts', line: 0, column: 1 }],
    }));
    const data = payload.data as { readiness?: { status?: string; readyForHighConfidenceMutation?: boolean; semantic?: { status?: string; reasonCodes?: string[] }; unresolvedReasonCodes?: string[] }; expansion?: { waveCount?: number; expansionPerformed?: boolean; materializedPaths?: string[] }; semanticNavigation?: { requested?: number; errors?: Array<{ code?: string }> } };
    expect(data.expansion).toMatchObject({ expansionPerformed: true });
    expect(data.expansion?.waveCount).toBeGreaterThanOrEqual(2);
    expect(data.expansion?.materializedPaths).toContain('src/helper.ts');
    expect(data.semanticNavigation?.requested).toBe(1);
    expect(data.semanticNavigation?.errors?.some((entry) => entry.code === 'SEMANTIC_NAVIGATION_REQUEST_INVALID')).toBe(true);
    expect(data.readiness).toMatchObject({ status: 'insufficient', readyForHighConfidenceMutation: false, semantic: { status: 'error' } });
    expect(data.readiness?.unresolvedReasonCodes).toContain('semantic.semantic_navigation_request_invalid');
  });

  test('rh_context list query returns bounded read-only intent discovery and preserves plugin_action_execute authority', async () => {
    const business = tempRoot('forge-context-capability-search-');
    const controllerHome = tempRoot('forge-home-capability-search-');
    initGitRepo(business, 'context-capability-search');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Capability Search' });
    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId,
      operation: 'list',
      query: 'browser login authentication',
      detail_level: 'summary',
    }));
    const data = payload.data as {
      capabilitySearch?: {
        query?: string;
        readOnlyDiscovery?: boolean;
        executeWith?: string;
        matches?: Array<{ capabilityId?: string; descriptor?: { exposedVia?: string } }>;
      };
    };
    expect(data.capabilitySearch).toMatchObject({
      query: 'browser login authentication',
      readOnlyDiscovery: true,
      executeWith: 'plugin_action_execute',
    });
    expect(data.capabilitySearch?.matches?.some((entry) => entry.capabilityId === 'plugin.browser')).toBe(true);
    expect(data.capabilitySearch?.matches?.find((entry) => entry.capabilityId === 'plugin.browser')?.descriptor?.exposedVia).toBe('plugin_action_execute');
  });

});
