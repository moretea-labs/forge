import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  acknowledgeControllerRoundClaim,
  beginInitialControllerRoundDispatch,
  finishControllerRoundRelayDispatch,
} from '../../src/runtime/control-plane/facade/controller-round-relay';
import { claimControllerSession, getControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { createWorkContract, recordWorkCompletionReceipt } from '../../src/runtime/control-plane/facade/work-contract-store';
import { bindChatgptWorkConversation } from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import { launchSuperController } from '../../src/runtime/control-plane/launcher/thin-launcher';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];
const launchedPids: number[] = [];

afterEach(() => {
  while (launchedPids.length > 0) {
    const pid = launchedPids.pop()!;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'continuation@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Continuation Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'autonomous continuation\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

function mcpContext(
  controllerHome: string,
  repository: ReturnType<typeof registerRepository>,
  input: { principalId: string; sessionId: string; controllerInstanceId: string },
): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
    controllerType: 'chatgpt',
    principalId: input.principalId,
    sessionId: input.sessionId,
    controllerInstanceId: input.controllerInstanceId,
  } as unknown as MultiRepositoryMcpToolContext;
}

describe('autonomous continuation lifecycle', () => {
  test('frozen-schema goal_complete closes a completed Work after MCP session rotation without reclaiming the terminal Work', async () => {
    const root = temp('forge-autonomous-continuation-facade-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    const targetRevision = initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-continuation-facade' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-AUTONOMOUS-CONTINUATION-FACADE';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Finish physical no-change Work before semantic goal closure.',
      acceptanceCriteria: ['terminal goal_complete survives MCP transport rotation'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'completed_no_change',
      status: 'running',
    });

    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:test',
        principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-test',
      },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const owner = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-principal',
      controllerType: 'chatgpt',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      sessionId: 'mcp-before-finalize',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner })?.status).toBe('claimed');

    const recordedAt = '2026-08-27T12:00:00.000Z';
    recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'receipt-autonomous-continuation-facade',
      source: 'controller_work',
      issueId: 'autonomous-continuation',
      taskId: workId,
      workId,
      targetBranch: 'main',
      targetRevision,
      changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
      verifiedAt: recordedAt,
      recordedAt,
    }, 'completed_no_change', 'completed_no_change');
    expect(getControllerSession(store, workId)?.sessionId).toBe('mcp-before-finalize');

    const wrong = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'different-principal',
        sessionId: 'mcp-after-finalize-wrong',
        controllerInstanceId: 'runtime-test',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'repair',
        capability_id: `controller.disposition:goal_complete:${opened.relayScopeId}`,
        work_id: workId,
      },
    ));
    expect(wrong.status).toBe('blocked');
    expect(wrong.summary).toMatch(/WORK_CONTROLLER_OWNER_MISMATCH|WORK_CONTROLLER_PRINCIPAL_MISMATCH|CONTROLLER_RELAY_CLAIM_/);

    const rotatedContext = mcpContext(controllerHome, repository, {
      principalId: 'chatgpt-principal',
      sessionId: 'mcp-after-finalize',
      controllerInstanceId: 'runtime-test',
    });
    const completed = structured(await callRuntimeTool(rotatedContext, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'repair',
      capability_id: `controller.disposition:goal_complete:${opened.relayScopeId}`,
      work_id: workId,
      session_id: owner.sessionId,
      reason: 'Physical no-change finalization completed before semantic round closure.',
    }));
    expect(completed.status).toBe('ok');
    expect(completed.data.relay).toMatchObject({
      originWorkId: workId,
      relayScopeId: opened.relayScopeId,
      disposition: 'goal_complete',
      status: 'goal_complete',
      controllerId: 'chatgpt-principal',
      principalId: 'chatgpt-principal',
      sessionId: 'mcp-after-finalize',
    });
    // Terminal semantic closure must not rewrite or reclaim the physical Work lease.
    expect(getControllerSession(store, workId)?.sessionId).toBe('mcp-before-finalize');

    const released = structured(await callRuntimeTool(rotatedContext, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'controller_release',
      work_id: workId,
    }));
    expect(released.status).toBe('ok');
    expect(getControllerSession(store, workId)).toBeUndefined();
  });

  test('controller_release marks an undisposed claimed round abandoned and a later explicit launch reopens the same fenced chain', async () => {
    const root = temp('forge-autonomous-abandoned-release-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-abandoned-release' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-AUTONOMOUS-ABANDONED-RELEASE';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Release an undisposed claimed round without wedging future explicit continuation.',
      acceptanceCriteria: ['abandoned release remains mechanical and relaunchable'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      maxRepeatedState: 3,
      identity: {
        controllerId: 'schedule:test',
        principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-abandoned',
      },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const owner = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-principal',
      controllerType: 'chatgpt',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      sessionId: 'mcp-undisposed',
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner })?.status).toBe('claimed');

    const released = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'chatgpt-principal',
        sessionId: 'mcp-undisposed',
        controllerInstanceId: 'runtime-test',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'controller_release',
        work_id: workId,
      },
    ));
    expect(released.status).toBe('ok');
    expect(getControllerSession(store, workId)).toBeUndefined();
    expect(released.data.relay).toMatchObject({
      originWorkId: workId,
      relayScopeId: opened.relayScopeId,
      disposition: 'continue_immediately',
      status: 'failed',
      lastError: 'CONTROLLER_RELAY_CLAIM_RELEASED_WITHOUT_DISPOSITION',
      roundCount: 1,
      repeatedStateCount: 0,
    });
    expect(released.data.relay.claimedAt).toBeUndefined();

    const reopened = beginInitialControllerRoundDispatch(store, {
      workId,
      maxRepeatedState: 3,
      identity: {
        controllerId: 'schedule:test-relaunch',
        principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-relaunch',
      },
    });
    expect(reopened).toMatchObject({
      status: 'dispatching',
      relayScopeId: opened.relayScopeId,
      roundCount: 2,
      repeatedStateCount: 1,
      reason: 'launcher_start_recovered_abandoned_claim',
    });
  });

  test('a continued ChatGPT conversation is still instructed to claim the exact Work before continue', async () => {
    const root = temp('forge-autonomous-continuation-launcher-');
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repoId = 'repo-autonomous-continuation-launcher';
    const workId = 'WORK-AUTONOMOUS-CONTINUATION-LAUNCHER';
    const store = { controllerHome, repoId };
    createWorkContract(store, {
      workId,
      repoId,
      mode: 'goal_workloop',
      objective: 'Reuse an existing ChatGPT conversation safely.',
      acceptanceCriteria: ['claim exact Work before continue'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    bindChatgptWorkConversation(store, {
      workId,
      conversationUrl: 'https://chatgpt.com/c/autonomous-continuation-test',
      latestBrowserSessionId: 'forge-chatgpt-work-test',
    });
    const executable = join(root, 'sleeping-forge');
    writeFileSync(executable, '#!/bin/sh\nsleep 5\n', 'utf8');
    chmodSync(executable, 0o755);

    const launched = await launchSuperController({ work: store, handoff: store }, {
      controllerType: 'chatgpt',
      executable,
      workId,
      cwd: root,
      conversationUrl: 'https://chatgpt.com/c/autonomous-continuation-test',
      browserSessionId: 'forge-chatgpt-work-test',
    });
    if (launched.pid) launchedPids.push(launched.pid);
    expect(launched.prompt).toContain('operation=controller_claim');
    expect(launched.prompt).toContain(`work_id=${workId}`);
    expect(launched.prompt).toContain('Only after that exact Work claim succeeds');
    expect(launched.prompt).not.toContain('First call rh_work continue');
  });
});
