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
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  bindControllerRoundSuccessorWork,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  submitControllerRoundDisposition,
} from '../../src/runtime/control-plane/facade/controller-round-relay';
import { runSchedulerControllerRoundRecovery } from '../../src/runtime/control-plane/global-scheduler/maintenance';
import { createRequirement, readRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import type { WorkContract } from '../../src/runtime/control-plane/facade/types';
import { claimControllerSession, getControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { createWorkContract, getWorkContract, recordWorkCompletionReceipt, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
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
  test('a dispatched ChatGPT relay reclaims a stale prior controller without weakening ordinary ownership fencing', async () => {
    const root = temp('forge-autonomous-stale-owner-recovery-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-stale-owner-recovery' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-AUTONOMOUS-STALE-OWNER-RECOVERY';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Recover a stale Codex owner into the browser-launched ChatGPT round.',
      acceptanceCriteria: ['the dispatched ChatGPT relay rotates the stale ownership generation'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const oldOwner = claimControllerSession({
      ...store,
      now: () => new Date(Date.now() - 6 * 60_000).toISOString(),
    }, {
      workId,
      controllerId: 'external:codex:stale',
      controllerType: 'codex',
      sessionId: 'external-session:codex:stale',
      principalId: 'external:codex:stale',
      controllerInstanceId: 'runtime-old',
      leaseMs: 5 * 60_000,
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:test', controllerType: 'chatgpt',
        principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-test',
      },
    });
    const staleOwnerBinding = bindChatgptWorkConversation(store, {
      workId,
      conversationUrl: 'https://chatgpt.com/c/stale-owner-recovery',
      latestBrowserSessionId: 'forge-chatgpt-work-test',
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId: staleOwnerBinding.bindingId });

    const claimed = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'chatgpt-principal',
        sessionId: 'chatgpt-session',
        controllerInstanceId: 'runtime-test',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'controller_claim',
        controller_type: 'chatgpt',
        work_id: workId,
        relay_scope_id: opened.relayScopeId,
        controller_authority_id: opened.authorityId,
      },
    ));

    expect(claimed.status).toBe('ok');
    expect(claimed.data.session).toMatchObject({
      workId,
      controllerId: 'chatgpt-principal',
      controllerType: 'chatgpt',
      principalId: 'chatgpt-principal',
      sessionId: 'chatgpt-session',
      claimGeneration: (oldOwner.claimGeneration ?? 1) + 1,
    });
    expect(claimed.data.relay).toMatchObject({ status: 'claimed', originWorkId: workId });
    expect(getControllerSession(store, workId)?.controllerId).toBe('chatgpt-principal');
  });

  test('frozen-schema goal_complete closes a completed Work after MCP session rotation without reclaiming the terminal Work', async () => {
    const root = temp('forge-autonomous-continuation-facade-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    const targetRevision = initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-continuation-facade' });
    const store = { controllerHome, repoId: repository.repoId };
    const requirementId = 'REQ-AUTONOMOUS-CONTINUATION-FACADE';
    createRequirement({ controllerHome }, {
      requirementId,
      title: 'Terminal semantic goal closure',
      outcomeStatement: 'A terminal Controller goal_complete explicitly accepts the Requirement.',
    });
    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'test_activate_requirement',
      mutate: (current) => ({ ...current, state: 'active' }),
    });
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
      requirementId,
    });

    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:test', controllerType: 'chatgpt',
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
    transitionWorkContractPhase(store, workId, { status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact no-change candidate verified for terminal relay semantics.' });
    requestWorkImplementationReview(store, workId, 'No-change candidate requires explicit Controller review before completion.');
    recordWorkImplementationReview(store, workId, {
      schemaVersion: 1,
      reviewId: 'REV-autonomous-continuation-facade',
      workId,
      reviewerPrincipalId: 'chatgpt-principal',
      reviewerControllerSessionId: 'mcp-before-finalize',
      decision: 'approved',
      rationale: 'The exact no-change candidate is reviewed before terminal goal closure.',
      findings: [],
      sourceRevision: targetRevision,
      workspaceFingerprint: 'autonomous-no-change-content',
      verificationWorkspaceFingerprint: 'autonomous-no-change-verification',
      changedPaths: [],
      changedPathDigest: implementationReviewChangedPathDigest([]),
      acceptanceCriteriaSummary: 'Terminal goal_complete survives MCP transport rotation.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt,
    });
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
    expect(completed.data.requirementAcceptance).toMatchObject({
      accepted: true,
      requirement: { requirementId, state: 'done' },
    });
    expect(readRequirement({ controllerHome }, requirementId)?.value.state).toBe('done');
    expect(completed.data.relay).toMatchObject({
      originWorkId: workId,
      relayScopeId: opened.relayScopeId,
      disposition: 'goal_complete',
      status: 'goal_complete',
      controllerId: 'chatgpt-principal',
      principalId: 'chatgpt-principal',
      sessionId: 'mcp-after-finalize',
    });
    // The relay records the current replaceable transport, while terminal semantic
    // closure must not rewrite or reclaim the physical Work lease or its durable authority.
    expect(completed.data.relay.authorityId).toBe(opened.authorityId);
    expect(getControllerSession(store, workId)?.sessionId).toBe('mcp-before-finalize');

    const wrongInstanceRelease = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'chatgpt-principal',
        sessionId: 'mcp-after-finalize-wrong-instance',
        controllerInstanceId: 'runtime-other',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'controller_release',
        work_id: workId,
        relay_scope_id: opened.relayScopeId,
        controller_authority_id: opened.authorityId,
      },
    ));
    expect(wrongInstanceRelease.status).toBe('blocked');
    expect(wrongInstanceRelease.summary).toContain('WORK_CONTROLLER_INSTANCE_MISMATCH');
    expect(getControllerSession(store, workId)?.sessionId).toBe('mcp-before-finalize');

    const released = structured(await callRuntimeTool(rotatedContext, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'controller_release',
      work_id: workId,
      relay_scope_id: opened.relayScopeId,
      controller_authority_id: opened.authorityId,
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
        controllerId: 'schedule:test', controllerType: 'chatgpt',
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
        relay_scope_id: opened.relayScopeId,
        controller_authority_id: opened.authorityId,
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
        controllerId: 'schedule:test-relaunch', controllerType: 'chatgpt',
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
    expect(opened.authorityId).toBeTruthy();
    expect(reopened.authorityId).toBeTruthy();
    expect(reopened.authorityId).not.toBe(opened.authorityId);
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
    expect(launched.prompt).toContain('When that exact Work claim succeeds');
    expect(launched.prompt).toContain('capture data.controllerAuthorityId');
    expect(launched.prompt).not.toContain('First call rh_work continue');
  });

  test('three semantic rounds survive provider conversation and session turnover before goal_complete', () => {
    const root = temp('forge-stage3b-three-round-turnover-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'stage3b-three-round-turnover' });
    const store = { controllerHome, repoId: repository.repoId };
    const workId = 'WORK-STAGE3B-THREE-ROUND-TURNOVER';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Prove durable Work/ControllerRound authority survives provider conversation and transport replacement.',
      acceptanceCriteria: ['three rounds complete across provider turnover and finish with goal_complete'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const binding1 = bindChatgptWorkConversation(store, {
      workId,
      conversationUrl: 'https://chatgpt.com/c/stage3b-round-1',
      latestBrowserSessionId: 'browser-stage3b-round-1',
      localAlias: 'Stage3B round 1',
    });
    const round1 = beginInitialControllerRoundDispatch(store, {
      workId,
      bindingId: binding1.bindingId,
      maxRounds: 4,
      maxRepeatedState: 4,
      identity: {
        controllerId: 'schedule:stage3b-round-1', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'scheduler-runtime', sessionId: 'occ-stage3b-round-1',
      },
    });
    finishControllerRoundRelayDispatch(store, {
      workId, ok: true, bindingId: binding1.bindingId, providerDispatchReceiptId: 'provider-receipt-stage3b-1',
    });
    const owner1 = claimControllerSession(store, {
      workId, controllerId: 'chatgpt-stage3b', controllerType: 'chatgpt', principalId: 'chatgpt-stage3b',
      controllerInstanceId: 'provider-runtime-1', sessionId: 'provider-session-1', leaseMs: 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner1 })).toMatchObject({
      status: 'claimed', sessionId: 'provider-session-1', bindingId: binding1.bindingId,
      providerDispatchReceiptId: 'provider-receipt-stage3b-1',
    });
    expect(submitControllerRoundDisposition(store, {
      workId, disposition: 'continue_immediately', relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId,
      maxRounds: 4, maxRepeatedState: 4,
      identity: {
        controllerId: owner1.controllerId, controllerType: owner1.controllerType,
        principalId: owner1.principalId ?? owner1.controllerId,
        controllerInstanceId: owner1.controllerInstanceId ?? '', sessionId: owner1.sessionId,
      },
    })).toMatchObject({ status: 'pending_release', lifecycleStage: 'semantic_round_closed', roundCount: 2 });
    releaseControllerSession(store, workId, owner1.controllerId);

    const round2 = beginControllerRoundRelayAfterRelease(store, { workId, releasedSession: owner1 })!;
    expect(round2).toMatchObject({ status: 'dispatching', relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId, roundCount: 2 });
    expect(round2.authorityId).not.toBe(round1.authorityId);
    const binding2 = rebindChatgptWorkConversation(store, {
      workId, previousConversationId: binding1.conversationId,
      conversationUrl: 'https://chatgpt.com/c/stage3b-round-2', latestBrowserSessionId: 'browser-stage3b-round-2',
    });
    expect(binding2.bindingId).toBe(binding1.bindingId);
    expect(binding2.conversationId).not.toBe(binding1.conversationId);
    finishControllerRoundRelayDispatch(store, {
      workId, ok: true, bindingId: binding2.bindingId, providerDispatchReceiptId: 'provider-receipt-stage3b-2',
    });
    const owner2 = claimControllerSession(store, {
      workId, controllerId: 'chatgpt-stage3b', controllerType: 'chatgpt', principalId: 'chatgpt-stage3b',
      controllerInstanceId: 'provider-runtime-2', sessionId: 'provider-session-2', leaseMs: 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner2 })).toMatchObject({
      status: 'claimed', sessionId: 'provider-session-2', controllerInstanceId: 'provider-runtime-2', bindingId: binding1.bindingId,
      providerDispatchReceiptId: 'provider-receipt-stage3b-2',
    });
    expect(submitControllerRoundDisposition(store, {
      workId, disposition: 'continue_immediately', relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId,
      maxRounds: 4, maxRepeatedState: 4,
      identity: {
        controllerId: owner2.controllerId, controllerType: owner2.controllerType,
        principalId: owner2.principalId ?? owner2.controllerId,
        controllerInstanceId: owner2.controllerInstanceId ?? '', sessionId: owner2.sessionId,
      },
    })).toMatchObject({ status: 'pending_release', lifecycleStage: 'semantic_round_closed', roundCount: 3 });
    releaseControllerSession(store, workId, owner2.controllerId);

    const round3 = beginControllerRoundRelayAfterRelease(store, { workId, releasedSession: owner2 })!;
    expect(round3).toMatchObject({ status: 'dispatching', relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId, roundCount: 3 });
    expect(round3.authorityId).not.toBe(round2.authorityId);
    const binding3 = rebindChatgptWorkConversation(store, {
      workId, previousConversationId: binding2.conversationId,
      conversationUrl: 'https://chatgpt.com/c/stage3b-round-3', latestBrowserSessionId: 'browser-stage3b-round-3',
    });
    expect(binding3.bindingId).toBe(binding1.bindingId);
    finishControllerRoundRelayDispatch(store, {
      workId, ok: true, bindingId: binding3.bindingId, providerDispatchReceiptId: 'provider-receipt-stage3b-3',
    });
    const owner3 = claimControllerSession(store, {
      workId, controllerId: 'chatgpt-stage3b', controllerType: 'chatgpt', principalId: 'chatgpt-stage3b',
      controllerInstanceId: 'provider-runtime-3', sessionId: 'provider-session-3', leaseMs: 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner3 })).toMatchObject({
      status: 'claimed', sessionId: 'provider-session-3', controllerInstanceId: 'provider-runtime-3', bindingId: binding1.bindingId,
      providerDispatchReceiptId: 'provider-receipt-stage3b-3',
    });
    const terminal = submitControllerRoundDisposition(store, {
      workId, disposition: 'goal_complete', relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId,
      reason: 'Stage3B three-round canary completed after provider conversation/session turnover.',
      identity: {
        controllerId: owner3.controllerId, controllerType: owner3.controllerType,
        principalId: owner3.principalId ?? owner3.controllerId,
        controllerInstanceId: owner3.controllerInstanceId ?? '', sessionId: owner3.sessionId,
      },
    });
    expect(terminal).toMatchObject({
      status: 'goal_complete', disposition: 'goal_complete', lifecycleStage: 'semantic_round_closed',
      relayScopeId: round1.relayScopeId, bindingId: binding1.bindingId, roundCount: 3,
      providerDispatchReceiptId: 'provider-receipt-stage3b-3',
    });
    expect(getChatgptWorkConversationBinding(store, workId)).toMatchObject({
      bindingId: binding1.bindingId, conversationId: 'stage3b-round-3', latestBrowserSessionId: 'browser-stage3b-round-3',
    });
  });

  test('completed Plan Work hands its claimed ControllerRound to one already-admitted successor without reopening terminal ownership', () => {
    const root = temp('forge-terminal-plan-successor-relay-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    const targetRevision = initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'terminal-plan-successor-relay' });
    const store = { controllerHome, repoId: repository.repoId };
    const requirementId = 'REQ-terminal-plan-successor-relay';
    const predecessorWorkId = 'work-terminal-plan-predecessor';
    const successorWorkId = 'work-terminal-plan-successor';
    createRequirement({ controllerHome }, {
      requirementId, title: 'Terminal Plan successor relay', outcomeStatement: 'Continue a multi-step Plan without reopening terminal Work ownership.',
    });
    createWorkContract(store, {
      workId: predecessorWorkId, repoId: repository.repoId, requirementId, planId: 'PLAN-terminal-successor', planStepId: 'stage-a',
      planSourceRevision: targetRevision, baseRevision: targetRevision, mode: 'goal_workloop', workKind: 'completed_no_change',
      objective: 'Complete stage A.', acceptanceCriteria: ['stage A complete'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const initial = beginInitialControllerRoundDispatch(store, {
      workId: predecessorWorkId, requirementId,
      identity: { controllerId: 'schedule:terminal-successor', controllerType: 'chatgpt', principalId: 'forge-scheduler', controllerInstanceId: 'scheduler-runtime', sessionId: 'occ-terminal-successor' },
    });
    finishControllerRoundRelayDispatch(store, { workId: predecessorWorkId, ok: true });
    const owner = claimControllerSession(store, {
      workId: predecessorWorkId, controllerId: 'chatgpt-terminal-successor', controllerType: 'chatgpt', principalId: 'chatgpt-terminal-successor',
      controllerInstanceId: 'provider-runtime-terminal-successor', sessionId: 'provider-session-terminal-successor', leaseMs: 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId: predecessorWorkId, session: owner })).toMatchObject({ status: 'claimed' });

    const recordedAt = '2026-09-05T09:00:00.000Z';
    transitionWorkContractPhase(store, predecessorWorkId, { status: 'running', phase: 'verification', state: 'satisfied', summary: 'Exact no-change predecessor verified.' });
    requestWorkImplementationReview(store, predecessorWorkId, 'Terminal predecessor requires review before completion.');
    recordWorkImplementationReview(store, predecessorWorkId, {
      schemaVersion: 1, reviewId: 'REV-terminal-plan-predecessor', workId: predecessorWorkId, reviewerPrincipalId: owner.principalId ?? owner.controllerId,
      reviewerControllerSessionId: owner.sessionId, decision: 'approved', rationale: 'Reviewed predecessor before successor relay handoff.', findings: [],
      sourceRevision: targetRevision, workspaceFingerprint: 'terminal-plan-content', verificationWorkspaceFingerprint: 'terminal-plan-verification',
      changedPaths: [], changedPathDigest: implementationReviewChangedPathDigest([]), acceptanceCriteriaSummary: 'stage A complete',
      verificationEvidence: [], architectureEvidence: [], recordedAt,
    });
    recordWorkCompletionReceipt(store, predecessorWorkId, {
      schemaVersion: 1, receiptId: 'receipt-terminal-plan-predecessor', source: 'controller_work', issueId: 'terminal-plan-successor',
      taskId: predecessorWorkId, workId: predecessorWorkId, targetBranch: 'main', targetRevision, changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt }, verifiedAt: recordedAt, recordedAt,
    }, 'completed_no_change', 'completed_no_change');
    expect(getWorkContract(store, predecessorWorkId)?.status).toBe('completed');
    expect(getControllerSession(store, predecessorWorkId)?.sessionId).toBe(owner.sessionId);

    createWorkContract(store, {
      workId: successorWorkId, repoId: repository.repoId, requirementId, predecessorWorkId, planId: 'PLAN-terminal-successor', planStepId: 'stage-b',
      planSourceRevision: targetRevision, baseRevision: targetRevision, mode: 'goal_workloop', workKind: 'repository_change', objective: 'Continue stage B.',
      acceptanceCriteria: ['stage B complete'], allowedPaths: ['src/**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    const identity = {
      controllerId: owner.controllerId, controllerType: owner.controllerType, principalId: owner.principalId ?? owner.controllerId,
      controllerInstanceId: owner.controllerInstanceId ?? '', sessionId: owner.sessionId,
    };
    const bound = bindControllerRoundSuccessorWork(store, {
      workId: predecessorWorkId, successorWorkId, identity, controllerAuthorityId: initial.authorityId,
    });
    expect(bound).toMatchObject({ status: 'claimed', originWorkId: predecessorWorkId, successorWorkId });
    const pending = submitControllerRoundDisposition(store, {
      workId: predecessorWorkId, identity, disposition: 'continue_immediately', relayScopeId: initial.relayScopeId, requirementId,
    });
    expect(pending).toMatchObject({ status: 'pending_release', successorWorkId });

    releaseControllerSession(store, predecessorWorkId, owner.controllerId);
    const next = beginControllerRoundRelayAfterRelease(store, { workId: predecessorWorkId, releasedSession: owner })!;
    expect(next).toMatchObject({
      status: 'dispatching', originWorkId: successorWorkId, predecessorWorkId, requirementId, relayScopeId: initial.relayScopeId, claimGeneration: 0,
    });
    expect(next.authorityId).toBeTruthy();
    expect(next.authorityId).not.toBe(initial.authorityId);
    const predecessorRelay = getControllerRoundRelay(store, predecessorWorkId);
    expect(predecessorRelay).toMatchObject({ status: 'handed_off', successorWorkId });
    expect(predecessorRelay?.authorityId).toBeUndefined();
    expect(getControllerRoundRelay(store, successorWorkId)).toMatchObject({ status: 'dispatching', originWorkId: successorWorkId, predecessorWorkId });
    expect(beginControllerRoundRelayAfterRelease(store, { workId: predecessorWorkId, releasedSession: owner })).toBeUndefined();
    expect(() => claimControllerSession(store, {
      workId: predecessorWorkId, controllerId: 'chatgpt-terminal-successor', controllerType: 'chatgpt', principalId: 'chatgpt-terminal-successor',
      controllerInstanceId: 'provider-runtime-terminal-successor-2', sessionId: 'provider-session-terminal-successor-2', leaseMs: 60_000,
    })).toThrow(/WORK_CONTROLLER_CLAIM_TERMINAL/);

    finishControllerRoundRelayDispatch(store, { workId: successorWorkId, ok: true });
    const successorOwner = claimControllerSession(store, {
      workId: successorWorkId, controllerId: 'chatgpt-terminal-successor', controllerType: 'chatgpt', principalId: 'chatgpt-terminal-successor',
      controllerInstanceId: 'provider-runtime-terminal-successor-2', sessionId: 'provider-session-terminal-successor-2', leaseMs: 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId: successorWorkId, session: successorOwner })).toMatchObject({
      status: 'claimed', originWorkId: successorWorkId, predecessorWorkId,
    });
  });

  test('stalled ChatGPT Work recovery uses the exact Work continuation with durable bounded backoff', async () => {
    const root = temp('forge-autonomous-recovery-backoff-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-recovery-backoff' });
    const workId = 'WORK-AUTONOMOUS-RECOVERY-BACKOFF';
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Recover an unclosed dispatched round without losing durable Work identity.',
      acceptanceCriteria: ['retry is Work-bound and bounded'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const recoveryBinding = bindChatgptWorkConversation(store, {
      workId,
      conversationUrl: 'https://chatgpt.com/c/recovery-conversation',
      latestBrowserSessionId: 'browser-recovery',
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-recovery',
      },
      bindingId: recoveryBinding.bindingId,
      maxFailures: 2,
    });
    const dispatched = finishControllerRoundRelayDispatch(store, {
      workId,
      ok: true,
      bindingId: recoveryBinding.bindingId,
    })!;
    const firstRecoveryAt = Date.parse(dispatched.updatedAt) + 61_000;
    const observed: Array<Record<string, unknown>> = [];
    const dispatchPrompt = async (input: any) => {
      observed.push(input);
      return {
        status: 'failed' as const,
        provider: 'controller-browser' as const,
        browserSessionId: input.browserSessionId ?? 'browser-recovery',
        conversationUrl: input.conversationUrl,
        resumedFromBinding: false,
        model: 'gpt-5.6',
        reasoning: 'high' as const,
        tabPolicy: 'auto' as const,
        executionPreferenceVerified: false,
        error: { code: 'TRANSIENT_RECOVERY_FAILURE', message: 'Connection closed' },
      };
    };

    const first = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: firstRecoveryAt,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt,
    });
    expect(first).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(observed[0]).toMatchObject({
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot ?? repository.localRoot,
      workId,
      browserSessionId: 'browser-recovery',
      conversationUrl: 'https://chatgpt.com/c/recovery-conversation',
    });
    const retryPending = getControllerRoundRelay(store, workId)!;
    expect(retryPending).toMatchObject({ status: 'dispatching', consecutiveFailures: 1, lastError: 'Connection closed' });
    expect(retryPending.nextRecoveryAt).toBeTruthy();
    const retryAt = Date.parse(retryPending.nextRecoveryAt!);
    expect(retryAt).toBe(firstRecoveryAt + 60_000);

    const early = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: retryAt - 1,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt,
    });
    expect(early).toEqual({ claimed: 0, dispatched: 0, failed: 0 });

    const second = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: retryAt,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt,
    });
    expect(second).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      status: 'blocked',
      consecutiveFailures: 2,
      blockedReason: 'consecutive_failures:2>=2',
    });
    expect(getControllerRoundRelay(store, workId)?.nextRecoveryAt).toBeUndefined();
  });

  test('stalled ControllerRound recovery isolates malformed Work history per repository and continues healthy repositories', async () => {
    const root = temp('forge-autonomous-recovery-malformed-repo-isolation-');
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);

    const malformedRepoRoot = join(root, 'malformed-repo');
    const healthyRepoRoot = join(root, 'healthy-repo');
    initRepo(malformedRepoRoot);
    initRepo(healthyRepoRoot);
    const malformedRepository = registerRepository({
      path: malformedRepoRoot,
      controllerHome,
      displayName: 'autonomous-recovery-malformed-repo',
    });
    const healthyRepository = registerRepository({
      path: healthyRepoRoot,
      controllerHome,
      displayName: 'autonomous-recovery-healthy-repo',
    });

    const malformedStore = { controllerHome, repoId: malformedRepository.repoId };
    const malformedWorkId = 'WORK-AUTONOMOUS-RECOVERY-MALFORMED-REPO';
    createWorkContract(malformedStore, {
      workId: malformedWorkId,
      repoId: malformedRepository.repoId,
      checkoutId: malformedRepository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Retain malformed history without stalling scheduler maintenance.',
      acceptanceCriteria: ['malformed Work remains invalid and untouched'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
    });
    const malformedRelay = beginInitialControllerRoundDispatch(malformedStore, {
      workId: malformedWorkId,
      identity: {
        controllerId: 'schedule:malformed-recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-malformed-recovery',
      },
    });
    const malformedDispatched = finishControllerRoundRelayDispatch(malformedStore, {
      workId: malformedWorkId,
      ok: true,
      bindingId: malformedRelay.bindingId,
    })!;
    const malformedRecord = readControlPlaneRecord<WorkContract>(
      controllerHome,
      'work_contract',
      malformedRepository.repoId,
      malformedWorkId,
    )!;
    const malformedAt = malformedRecord.value.updatedAt;
    const review = malformedRecord.value.phaseEvidence?.review;
    writeControlPlaneRecord(controllerHome, {
      namespace: 'work_contract',
      scope: malformedRepository.repoId,
      key: malformedWorkId,
      schemaVersion: 2,
      expectedRevision: malformedRecord.revision,
      action: 'test_malformed_controller_round_work_phase_evidence',
      value: {
        ...malformedRecord.value,
        phase: 'delivery',
        phaseEvidence: {
          ...malformedRecord.value.phaseEvidence,
          implementation: { ...malformedRecord.value.phaseEvidence!.implementation, state: 'satisfied' },
          verification: { ...malformedRecord.value.phaseEvidence!.verification, state: 'satisfied' },
          review: {
            ...(review ?? { source: 'legacy_inferred', summary: 'Legacy review remains pending.', evidenceRefs: [], recordedAt: malformedAt }),
            state: 'pending',
          },
        },
      },
    });

    const healthyStore = { controllerHome, repoId: healthyRepository.repoId };
    const healthyWorkId = 'WORK-AUTONOMOUS-RECOVERY-HEALTHY-REPO';
    createWorkContract(healthyStore, {
      workId: healthyWorkId,
      repoId: healthyRepository.repoId,
      checkoutId: healthyRepository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Recover normally after another repository has malformed Work history.',
      acceptanceCriteria: ['healthy stalled round still dispatches'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const healthyBinding = bindChatgptWorkConversation(healthyStore, {
      workId: healthyWorkId,
      conversationUrl: 'https://chatgpt.com/c/healthy-recovery-isolation',
      latestBrowserSessionId: 'browser-healthy-recovery-isolation',
    });
    const healthyRelay = beginInitialControllerRoundDispatch(healthyStore, {
      workId: healthyWorkId,
      identity: {
        controllerId: 'schedule:healthy-recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-healthy-recovery',
      },
      bindingId: healthyBinding.bindingId,
    });
    const healthyDispatched = finishControllerRoundRelayDispatch(healthyStore, {
      workId: healthyWorkId,
      ok: true,
      bindingId: healthyBinding.bindingId,
    })!;

    const nowMs = Math.max(Date.parse(malformedDispatched.updatedAt), Date.parse(healthyDispatched.updatedAt)) + 61_000;
    const observed: Array<Record<string, unknown>> = [];
    const result = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs,
      repositories: [malformedRepository, healthyRepository],
      graceMs: 60_000,
      maxRecoveries: 2,
      authorizeWake: () => undefined,
      dispatchPrompt: async (input: any) => {
        observed.push(input);
        return {
          status: 'dispatched' as const,
          provider: 'controller-browser' as const,
          browserSessionId: input.browserSessionId ?? 'browser-healthy-recovery-isolation',
          conversationUrl: input.conversationUrl,
          resumedFromBinding: true,
          model: 'gpt-5.6',
          reasoning: 'high' as const,
          tabPolicy: 'auto' as const,
          executionPreferenceVerified: true,
        };
      },
    });

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 1 });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ repoId: healthyRepository.repoId, workId: healthyWorkId });
    expect(getControllerRoundRelay(healthyStore, healthyWorkId)).toMatchObject({ status: 'dispatched' });
    expect(getControllerRoundRelay(malformedStore, malformedWorkId)).toMatchObject({ status: 'dispatched' });
    const retainedMalformed = readControlPlaneRecord<WorkContract>(
      controllerHome,
      'work_contract',
      malformedRepository.repoId,
      malformedWorkId,
    )!;
    expect(retainedMalformed.value.phase).toBe('delivery');
    expect(retainedMalformed.value.phaseEvidence?.review.state).toBe('pending');
  });

});
