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
import { mintEngineeringAdmissionEvidence } from '../../adapters/mcp/runtime-gateway/engineering-preconditions';
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
  startManagedPluginAction,
  waitManagedPluginAction,
} from '../../src/runtime/plugins/lightweight-action';
import { controllerPluginRepository, submitAssistantPluginAction } from '../../src/runtime/plugins/store';
import { startGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { createHandoffItem, getHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { cancelWorkContract, createWorkContract, type WorkContract } from '../../packages/kernel/work/api/index';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { recordCognitiveMemory, type CognitiveWriteAuthorityPort } from '../../packages/kernel/cognition/api/index';
import { cognitionMemoryStore } from '../../src/runtime/control-plane/persistence/cognition-store';
import { writeProjectIdentity, writeProjectPlacement, writeWorkspaceIdentity } from '../../src/runtime/control-plane/workspace/workspace-store';
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

function writeProjectEngineeringContract(root: string): void {
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, '.forge', 'project-engineering.json'), JSON.stringify({
    schemaVersion: 1,
    contractId: 'context-roundtrip-engineering',
    contractVersion: '1',
    projectId: 'context-roundtrip',
    authority: {},
    quality: {},
    checks: [],
    journeys: [],
    platforms: [],
    skillRefs: ['typescript-engineering@1'],
    tooling: [],
  }, null, 2));
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

  test('controller-scoped plugin execution binds one durable Process before observation and reattaches by request id', async () => {
    const controllerHome = tempRoot('forge-home-controller-plugin-managed-');
    const releaseRoot = tempRoot('forge-release-controller-plugin-managed-');
    ensureControllerHome(controllerHome);
    const sidecar = join(releaseRoot, 'forge-plugin-action-sidecar');
    writeFileSync(sidecar, `#!/bin/sh
sleep 1
printf '{"ok":true}\\n'
`, { mode: 0o700 });

    const previousReleasePath = process.env.FORGE_RELEASE_PATH;
    process.env.FORGE_RELEASE_PATH = releaseRoot;
    const repository = controllerPluginRepository(controllerHome);
    const request = {
      pluginId: 'controller-fixture',
      actionId: 'slow-effect',
      requestId: 'controller-managed-plugin-once',
      args: { value: 1 },
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    try {
      const first = await startManagedPluginAction({
        controllerHome,
        repository,
        request,
        interactiveWaitMs: 0,
        timeoutMs: 10_000,
      });
      expect(first.handle.completed).not.toBe(true);
      expect(first.handle.route).toBe('managed');

      const second = await startManagedPluginAction({
        controllerHome,
        repository,
        request,
        interactiveWaitMs: 0,
        timeoutMs: 10_000,
      });
      expect(second.handle.processId).toBe(first.handle.processId);
      expect(second.handle.deduplicated).toBe(true);

      await expect(startManagedPluginAction({
        controllerHome,
        repository,
        request: { ...request, args: { value: 2 } },
        interactiveWaitMs: 0,
        timeoutMs: 10_000,
      })).rejects.toThrow('PROCESS_REQUEST_CONFLICT');

      const completed = await waitManagedPluginAction(
        controllerHome,
        repository.repoId,
        first.handle.processId,
        10_000,
      );
      expect(completed.completed).toBe(true);
      expect(completed.ok).toBe(true);
      expect(completed.processId).toBe(first.handle.processId);

      await expect(startManagedPluginAction({
        controllerHome,
        repository,
        request: { ...request, args: { value: 3 } },
        interactiveWaitMs: 0,
        timeoutMs: 10_000,
      })).rejects.toThrow('PROCESS_REQUEST_CONFLICT');
    } finally {
      if (previousReleasePath === undefined) delete process.env.FORGE_RELEASE_PATH;
      else process.env.FORGE_RELEASE_PATH = previousReleasePath;
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
      readiness?: {
        diagnostics?: {
          semantics?: {
            maintenanceHealthy?: boolean | null;
            maintenanceCandidateCount?: number | null;
            maintenanceObservation?: string;
          };
        };
      };
    };
    expect(detail.activeContractCount).toBe(1);
    expect(detail.invalidActiveContractCount).toBe(1);
    expect(detail.invalidActiveContracts?.[0]).toMatchObject({ workId: malformed.workId });
    expect(detail.readiness?.diagnostics?.semantics).toMatchObject({
      maintenanceHealthy: null,
      maintenanceCandidateCount: null,
      maintenanceObservation: 'not_requested',
    });

    const maintenanceDetailPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'detail', include_maintenance: true,
    }));
    const maintenanceDetail = maintenanceDetailPayload.data as typeof detail;
    expect(maintenanceDetail.readiness?.diagnostics?.semantics).toMatchObject({
      maintenanceObservation: 'unavailable',
    });
    expect(maintenanceDetail.readiness?.diagnostics?.semantics?.maintenanceCandidateCount).toBeNull();
  });

  test('rh_status keeps maintenance diagnostic opt-in on a clean Controller', async () => {
    const business = tempRoot('forge-status-maintenance-business-');
    const controllerHome = tempRoot('forge-status-maintenance-home-');
    initGitRepo(business, 'status-maintenance');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Status Maintenance' });

    const defaultPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'detail',
    }));
    const defaultData = defaultPayload.data as {
      readiness?: { diagnostics?: { semantics?: Record<string, unknown> } };
    };
    expect(defaultData.readiness?.diagnostics?.semantics).toMatchObject({
      maintenanceHealthy: null,
      maintenanceCandidateCount: null,
      maintenanceObservation: 'not_requested',
    });

    const observedPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'detail', include_maintenance: true,
    }));
    const observedData = observedPayload.data as typeof defaultData;
    expect(observedData.readiness?.diagnostics?.semantics).toMatchObject({
      maintenanceObservation: 'observed',
    });
    expect(typeof observedData.readiness?.diagnostics?.semantics?.maintenanceCandidateCount).toBe('number');
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

  test('rh_context excludes pending Handoffs whose owning Work is canonically terminal', async () => {
    const business = tempRoot('forge-context-terminal-handoff-');
    const controllerHome = tempRoot('forge-home-context-terminal-handoff-');
    initGitRepo(business, 'context-terminal-handoff');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Terminal Handoff' });
    const terminalWork = createProjectionWork(controllerHome, repository, 'work-context-terminal-handoff');
    const store = { controllerHome, repoId: repository.repoId };
    const stale = createHandoffItem(store, {
      id: 'handoff-terminal-work',
      repoId: repository.repoId,
      workId: terminalWork.workId,
      title: 'Historical terminal Work decision',
      severity: 'needs_review',
      reason: 'This recent pending record must become historical attention once its Work is terminal.',
      creationReason: 'ambiguous_outcome',
      summary: 'Terminal Work handoff.',
      currentState: { repoId: repository.repoId, workId: terminalWork.workId, statusSummary: 'pending' },
      evidenceRefs: [],
      recommendedDecision: 'No current action.',
      recommendedPrompt: 'Inspect history only.',
      suggestedNextActions: [],
    });
    const current = createHandoffItem(store, {
      id: 'handoff-current-decision',
      repoId: repository.repoId,
      title: 'Current repository decision',
      severity: 'needs_review',
      reason: 'This unresolved repository decision remains current.',
      creationReason: 'ambiguous_outcome',
      summary: 'Current decision.',
      currentState: { repoId: repository.repoId, statusSummary: 'pending' },
      evidenceRefs: [],
      recommendedDecision: 'Review current decision.',
      recommendedPrompt: 'Review current decision.',
      suggestedNextActions: [],
    });
    cancelWorkContract(store, terminalWork.workId, { summary: 'Terminalize Work for Handoff projection regression.' });

    const summaryPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId, operation: 'get', detail_level: 'summary',
    }));
    const summary = summaryPayload.data as { activeAttention?: Array<{ id?: string }>; counts?: { currentAttention?: number } };
    expect(summary.activeAttention?.some((item) => item.id === stale.id)).toBe(false);
    expect(summary.activeAttention?.some((item) => item.id === current.id)).toBe(true);

    const detailPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId, operation: 'list', detail_level: 'detail',
    }));
    const detail = detailPayload.data as { activeAttention?: Array<{ id?: string }> };
    expect(detail.activeAttention?.some((item) => item.id === stale.id)).toBe(false);
    expect(detail.activeAttention?.some((item) => item.id === current.id)).toBe(true);
    expect(getHandoffItem(store, stale.id)?.status).toBe('pending');
  });

  test('rh_context exact Work projects one current task and keeps unrelated repository attention out of that task', async () => {
    const business = tempRoot('forge-context-current-task-lineage-');
    const controllerHome = tempRoot('forge-home-context-current-task-lineage-');
    initGitRepo(business, 'context-current-task-lineage');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Current Task Lineage' });
    const currentWork = createProjectionWork(controllerHome, repository, 'work-context-current-task');
    const unrelatedWork = createProjectionWork(controllerHome, repository, 'work-context-unrelated-task');
    const store = { controllerHome, repoId: repository.repoId };
    const currentHandoff = createHandoffItem(store, {
      id: 'handoff-current-task-only',
      repoId: repository.repoId,
      workId: currentWork.workId,
      title: 'Current task decision',
      severity: 'needs_review',
      reason: 'Belongs to the exact requested Work.',
      creationReason: 'ambiguous_outcome',
      summary: 'Current task attention.',
      currentState: { repoId: repository.repoId, workId: currentWork.workId, statusSummary: 'pending' },
      evidenceRefs: [],
      recommendedDecision: 'Inspect current task only.',
      recommendedPrompt: 'Inspect current task only.',
      suggestedNextActions: [],
    });
    const unrelatedHandoff = createHandoffItem(store, {
      id: 'handoff-unrelated-task',
      repoId: repository.repoId,
      workId: unrelatedWork.workId,
      title: 'Unrelated task decision',
      severity: 'needs_review',
      reason: 'Must remain repository inventory, not current-task context.',
      creationReason: 'ambiguous_outcome',
      summary: 'Unrelated task attention.',
      currentState: { repoId: repository.repoId, workId: unrelatedWork.workId, statusSummary: 'pending' },
      evidenceRefs: [],
      recommendedDecision: 'Do not inject into current task.',
      recommendedPrompt: 'Review only from the unrelated Work.',
      suggestedNextActions: [],
    });

    const exactPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      work_id: currentWork.workId,
      detail_level: 'summary',
    }));
    const exact = exactPayload.data as {
      currentTask?: { workId?: string; objective?: string };
      activeAttention?: Array<{ id?: string; workId?: string }>;
      counts?: { currentWork?: number; currentAttention?: number; repositoryAttention?: number };
    };
    expect(exact.currentTask).toMatchObject({ workId: currentWork.workId, objective: currentWork.objective });
    expect(exact.activeAttention).toEqual([expect.objectContaining({ id: currentHandoff.id, workId: currentWork.workId })]);
    expect(exact.activeAttention?.some((item) => item.id === unrelatedHandoff.id)).toBe(false);
    expect(exact.counts).toMatchObject({ currentWork: 1, currentAttention: 1, repositoryAttention: 2 });

    const repositoryPayload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId,
      operation: 'get',
      detail_level: 'summary',
    }));
    const repositoryContext = repositoryPayload.data as {
      currentTask?: unknown;
      activeWork?: Array<{
        workId?: string;
        relation?: string;
        relevance?: string[];
        objective?: string;
        continuation?: unknown;
        nextSafeAction?: unknown;
      }>;
      counts?: { currentWork?: number };
    };
    expect(repositoryContext.currentTask).toBeUndefined();
    expect(repositoryContext.counts?.currentWork).toBe(0);
    const currentInventory = repositoryContext.activeWork?.find((item) => item.workId === currentWork.workId);
    expect(currentInventory).toMatchObject({
      relation: 'repository_inventory',
      relevance: ['ownership', 'conflict', 'release_admission'],
    });
    expect(currentInventory).not.toHaveProperty('objective');
    expect(currentInventory).not.toHaveProperty('continuation');
    expect(currentInventory).not.toHaveProperty('nextSafeAction');
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

  test('rh_context knowledge-only search audits learned memory within current Project and Workspace scopes', async () => {
    const business = tempRoot('forge-context-knowledge-audit-');
    const controllerHome = tempRoot('forge-home-context-knowledge-audit-');
    initGitRepo(business, 'context-knowledge-audit');
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Knowledge Audit' });
    const instance = ensureForgeInstanceIdentity({ controllerHome, preferredInstanceId: 'forge-context-knowledge-audit' });
    writeWorkspaceIdentity({ controllerHome, value: { workspaceId: 'workspace-audit', title: 'Audit Workspace' } });
    writeProjectIdentity({ controllerHome, value: { projectId: 'project-audit', workspaceId: 'workspace-audit', displayName: 'Audit Project' } });
    writeProjectPlacement({ controllerHome, value: {
      projectId: 'project-audit',
      forgeInstanceId: instance.instanceId,
      repositoryId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
    } });
    const auditScope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'project-audit' };
    const authority: CognitiveWriteAuthorityPort = {
      assertMemoryWrite() {},
      assertEdgeWrite() {},
      evidenceAvailable() { return true; },
    };
    recordCognitiveMemory(cognitionMemoryStore(controllerHome), authority, {
      id: 'mem:rh-context-audit',
      scope: auditScope,
      facets: ['knowledge', 'principle', 'product-design'],
      canonicalText: 'Interaction should be self explanatory; copy explains invisible rules.',
      concepts: ['product.interaction', 'copy.invisible-rules'],
      provenance: {
        sourceKind: 'controller',
        sourceId: 'controller-learning:audit',
        sourceWorkId: 'work-audit-source',
        sourceRoundId: 'round-audit-source',
        recordedAt: '2026-09-21T00:00:00.000Z',
        evidenceRefs: ['E-AUDIT'],
      },
      confidence: 0.94,
      utility: 0.88,
      tier: 'warm',
      validFrom: '2026-09-21T00:00:00.000Z',
      counterEvidenceRefs: [],
    });

    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_context', {
      repo_id: repository.repoId,
      operation: 'search',
      knowledge_query: 'self explanatory',
      knowledge_concept: 'product.interaction',
      knowledge_limit: 8,
      detail_level: 'detail',
    }));
    const data = payload.data as { cognitionAudit?: {
      readonly?: boolean;
      advisoryOnly?: boolean;
      authorityBoundary?: string;
      scopes?: Array<{ kind?: string; id?: string }>;
      items?: Array<{ memory?: { id?: string; confidence?: number; provenance?: { sourceRoundId?: string } }; activation?: { reasons?: unknown[] } }>;
    } };
    expect(data.cognitionAudit).toMatchObject({ readonly: true, advisoryOnly: true });
    expect(data.cognitionAudit?.authorityBoundary).toContain('never overrides');
    expect(data.cognitionAudit?.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project', id: 'project-audit' }),
      expect.objectContaining({ kind: 'workspace', id: 'workspace-audit' }),
    ]));
    expect(data.cognitionAudit?.items).toContainEqual(expect.objectContaining({
      memory: expect.objectContaining({
        id: 'mem:rh-context-audit',
        confidence: 0.94,
        provenance: expect.objectContaining({ sourceRoundId: 'round-audit-source' }),
      }),
      activation: expect.objectContaining({ reasons: expect.any(Array) }),
    }));
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

  test('rh_context runtime-issued closure round-trips into engineering preconditions without depth corruption', async () => {
    const business = tempRoot('forge-context-roundtrip-facade-');
    const controllerHome = tempRoot('forge-home-context-roundtrip-facade-');
    initGitRepo(business, 'context-roundtrip-facade');
    writeProjectEngineeringContract(business);
    git(business, 'add', '.forge/project-engineering.json');
    git(business, 'commit', '-m', 'add engineering contract');
    const sourceRevision = git(business, 'rev-parse', 'HEAD');
    const repository = registerRepository({ path: business, controllerHome, displayName: 'Context Roundtrip Facade' });
    const ctx = mcpContext(controllerHome, repository);

    const contextPayload = structured(await callRuntimeTool(ctx, 'rh_context', {
      repo_id: repository.repoId,
      operation: 'search',
      query: 'ENTRY_MARKER',
      known_paths: ['src/index.ts'],
      retrieval_mode: 'implementation',
      structural_context: 'off',
      max_files: 2,
      max_snippets: 4,
    }));
    const contextData = contextPayload.data as { contextClosure?: Record<string, unknown> };
    const closure = contextData.contextClosure;
    expect(closure).toBeTruthy();
    expect(JSON.stringify(closure)).not.toContain('[bounded-depth]');
    expect((closure?.readiness as { status?: string } | undefined)?.status).toBe('ready');

    const neutralDecisions = {
      ownership: 'No ownership change.', single_writer: 'One Work writer.', transaction: 'No transaction change.', lifecycle: 'No lifecycle change.',
      concurrency: 'No concurrency change.', persistence: 'No persistence change.', failure: 'Fail closed.', projection_cache: 'No projection change.',
      time: 'No time change.', performance: 'No performance change.', compatibility: 'Backward compatible.',
      semantic_scope_identity: 'Exact Work scope.', authorization_trust: 'Existing controller authority.', resource_fencing: 'Existing Work fencing.',
      deployment_topology: 'No topology change.', schema_evolution_durability: 'No schema change.', idempotency_replay: 'Existing request identity.',
      retention_gc: 'No retention change.', observability_evidence: 'Work receipts remain authoritative.', recovery_failure_domain: 'No recovery change.',
      capacity_backpressure: 'No capacity change.', release_upgrade_rollback: 'No release change.', security_privacy: 'No security change.',
      portability: 'No portability change.', migration_retirement: 'No migration change.',
    };
    const engineeringPreconditions = {
      context_closure: closure,
      product_dod: {
        user_outcome: 'Round-trip the exact Context Closure.',
        completion_conditions: ['Receipt is accepted.'], non_regression: ['Digest validation remains strict.'],
        performance_expectations: ['No hot-path expansion.'], non_goals: ['No lifecycle changes.'],
      },
      design_decision: {
        semantic_scope_keys: ['context-closure-roundtrip'], mutation_class: 'isolated_write', decisions: neutralDecisions,
        complexity_budget: { added_writers: 0, added_durable_mechanisms: 0, projection_paths: 0, global_invalidations: 0, lifecycle_hooks: 0, synchronous_critical_path_work: 0, notes: [] },
      },
      independent_critique: { decision: 'approved', findings: [] },
    };

    const minted = mintEngineeringAdmissionEvidence({
      repoRoot: business,
      sourceRevision,
      draft: engineeringPreconditions,
      requirementContext: { objective: 'Prove runtime-issued Context Closure round-trip.', acceptanceCriteria: ['Context Closure round-trips intact.'] },
    });
    expect(minted.contextClosureReceiptId).toBe(closure?.receiptId as string | undefined);

    expect(() => mintEngineeringAdmissionEvidence({
      repoRoot: business,
      sourceRevision,
      draft: {
        ...engineeringPreconditions,
        context_closure: { ...closure, generatedAt: '2099-01-01T00:00:00.000Z' },
      },
      requirementContext: { objective: 'Reject forged Context Closure.', acceptanceCriteria: ['Mutated receipts fail closed.'] },
    })).toThrow('CONTEXT_CLOSURE_RECEIPT_NOT_ISSUED_BY_RUNTIME');
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
