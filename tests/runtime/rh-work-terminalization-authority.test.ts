import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract, getWorkContract, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { claimControllerSession, getControllerSession, resumeControllerSession, withControllerSessionTerminalizationFence } from '../../src/runtime/control-plane/facade/controller-session-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-terminalization-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-terminalization-home-'));
  roots.push(repoRoot, controllerHome);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Terminalization fixture' });
  return { repoRoot, controllerHome, repository };
}

function ctx(
  controllerHome: string,
  repository: ReturnType<typeof registerRepository>,
  principalId: string,
  sessionId: string,
  controllerInstanceId: string,
): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    principalId,
    sessionId,
    controllerInstanceId,
    controllerType: 'chatgpt',
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function createReadyWork(controllerHome: string, repoId: string, workId: string): void {
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    mode: 'goal_workloop',
    objective: 'terminalization authority regression',
    acceptanceCriteria: ['preserve current controller authority'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'ready',
  });
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work terminalization authority', () => {
  test('claim-before-stale-stop is rejected while the current owner may stop across transport rotation', async () => {
    const fx = fixture();
    const workId = 'work-claim-before-stale-stop';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-a',
      controllerType: 'chatgpt',
      sessionId: 'transport-claimed',
      principalId: 'principal-a',
      controllerInstanceId: 'runtime-new',
      leaseMs: 60_000,
    });
    expect(owner.claimGeneration).toBe(1);

    const stale = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'system', reason: 'launcher had not reached a new Controller claim' },
    ));
    expect(stale.status).toBe('blocked');
    expect(stale.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const staleFinalize = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-stale-finalize', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'finalize', work_id: workId, requested_by: 'chatgpt' },
    ));
    expect(staleFinalize.status).toBe('blocked');
    expect(staleFinalize.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const current = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-a', 'transport-rotated', 'runtime-new'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'chatgpt', reason: 'current owner semantic disposition' },
    ));
    expect(current.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('cancelled');
  }, 15_000);

  test('stale controller release cannot clear a newer ownership epoch', async () => {
    const fx = fixture();
    const workId = 'work-stale-release';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const first = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-release',
      controllerType: 'chatgpt',
      sessionId: 'transport-old',
      principalId: 'principal-release',
      controllerInstanceId: 'runtime-old',
      leaseMs: 60_000,
    });
    const newer = resumeControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: first.controllerId,
      controllerType: first.controllerType,
      sessionId: 'transport-new',
      principalId: 'principal-release',
      controllerInstanceId: 'runtime-new',
      expectedClaimGeneration: first.claimGeneration,
      leaseMs: 60_000,
    });
    expect(newer.claimGeneration).toBe((first.claimGeneration ?? 1) + 1);

    const staleRelease = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-release', 'transport-stale-release', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'controller_release', work_id: workId },
    ));
    expect(staleRelease.status).toBe('blocked');
    expect(staleRelease.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.controllerInstanceId).toBe('runtime-new');

    const staleStop = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-release', 'transport-stale-stop', 'runtime-old'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: workId, requested_by: 'system', reason: 'stale launcher cleanup' },
    ));
    expect(staleStop.status).toBe('blocked');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');
  }, 15_000);

  test('claim generation is fenced atomically and explicit unclaimed user stop remains valid', async () => {
    const fx = fixture();
    const workId = 'work-generation-fence';
    createReadyWork(fx.controllerHome, fx.repository.repoId, workId);
    const owner = claimControllerSession({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      controllerId: 'principal-b',
      controllerType: 'chatgpt',
      sessionId: 'transport-b',
      principalId: 'principal-b',
      controllerInstanceId: 'runtime-b',
      leaseMs: 60_000,
    });
    const staleGeneration = withControllerSessionTerminalizationFence(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      {
        workId,
        actor: 'regression-stale-generation',
        authority: {
          controllerId: owner.controllerId,
          controllerType: owner.controllerType,
          principalId: owner.principalId!,
          controllerInstanceId: owner.controllerInstanceId!,
          claimGeneration: (owner.claimGeneration ?? 1) + 1,
        },
      },
      () => transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId, {
        phase: 'cleanup',
        status: 'cancelled',
        state: 'skipped',
        summary: 'must not run',
      }),
    );
    expect(staleGeneration.allowed).toBe(false);
    if (!staleGeneration.allowed) expect(staleGeneration.reason).toBe('stale_controller_authority');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, workId)?.status).toBe('ready');

    const explicitWorkId = 'work-explicit-user-stop';
    createReadyWork(fx.controllerHome, fx.repository.repoId, explicitWorkId);
    const explicit = structured(await callRuntimeTool(
      ctx(fx.controllerHome, fx.repository, 'principal-user', 'transport-user', 'runtime-user'),
      'rh_work',
      { repo_id: fx.repository.repoId, operation: 'stop', work_id: explicitWorkId, requested_by: 'user', reason: 'explicit user stop' },
    ));
    expect(explicit.status).toBe('ok');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, explicitWorkId)?.status).toBe('cancelled');
  }, 15_000);
});
