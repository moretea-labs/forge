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
  beginControllerRoundProviderDispatch,
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  bindControllerRoundSuccessorWork,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  reconcileControllerRoundAfterAbandonedRelease,
  settleControllerRoundAfterTurn,
  submitControllerRoundDisposition,
} from '../../packages/kernel/controller/api/index';
import { runSchedulerControllerRoundRecovery, runSchedulerPeriodicCleanup } from '../../src/runtime/control-plane/global-scheduler/maintenance';
import { createRequirement, readRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import type { WorkContract } from '../../src/runtime/control-plane/facade/types';
import { claimControllerSession, getControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { createWorkContract, getWorkContract, recordWorkCompletionReceipt, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/domain/implementation-review';
import { reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../src/runtime/control-plane/launcher/chatgpt-work-binding-store';
import { getChatgptControllerRoundSettlement } from '../../adapters/chatgpt/controller-round-settlement-store';
import { launchSuperController } from '../../src/runtime/control-plane/launcher/thin-launcher';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

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
  test('a settled Controller turn defaults a nonterminal Work to exactly one continuation obligation without user input', () => {
    const root = temp('forge-autonomous-turn-settled-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-turn-settled' });
    const store = { controllerHome, repoId: repository.repoId };

    const openClaimed = (workId: string) => {
      createWorkContract(store, {
        workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop',
        objective: `Autonomously continue ${workId} without a user continue message.`,
        acceptanceCriteria: ['the settled Controller turn either continues automatically or stops only on explicit blocking state'],
        allowedPaths: [], forbiddenPaths: [], checks: [],
        constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
        requestedBy: 'chatgpt', status: 'running',
      });
      const identity = {
        controllerId: `chatgpt-${workId}`, controllerType: 'chatgpt' as const, principalId: `chatgpt-${workId}`,
        controllerInstanceId: 'runtime-turn-settled', sessionId: `session-${workId}`,
      };
      beginInitialControllerRoundDispatch(store, { workId, identity });
      finishControllerRoundRelayDispatch(store, { workId, ok: true });
      const owner = claimControllerSession(store, { ...identity, workId, leaseMs: 60_000 });
      const claimed = acknowledgeControllerRoundClaim(store, { workId, session: owner });
      expect(claimed?.status).toBe('claimed');
      return { owner, claimed: claimed! };
    };

    const automaticWorkId = 'WORK-AUTONOMOUS-TURN-SETTLED';
    const automatic = openClaimed(automaticWorkId);
    const settled = settleControllerRoundAfterTurn(store, { workId: automaticWorkId, completionEvidenceId: 'assistant-turn:1:settled' });
    expect(settled).toMatchObject({
      status: 'pending_release', disposition: 'continue_immediately', lifecycleStage: 'semantic_round_closed',
      roundCount: automatic.claimed.roundCount + 1, controllerTurnCompletionEvidenceId: 'assistant-turn:1:settled',
    });
    const replay = settleControllerRoundAfterTurn(store, { workId: automaticWorkId, completionEvidenceId: 'assistant-turn:1:settled' });
    expect(replay).toMatchObject({ status: 'pending_release', roundCount: settled!.roundCount });
    releaseControllerSession(store, automaticWorkId, automatic.owner.controllerId);
    expect(beginControllerRoundRelayAfterRelease(store, { workId: automaticWorkId, releasedSession: automatic.owner })).toMatchObject({
      status: 'dispatching', controllerTurnCompletionEvidenceId: undefined, controllerTurnSettledAt: undefined,
    });

    const explicitWaitWorkId = 'WORK-AUTONOMOUS-TURN-EXPLICIT-WAIT';
    const explicitWait = openClaimed(explicitWaitWorkId);
    const waited = submitControllerRoundDisposition(store, {
      workId: explicitWaitWorkId,
      identity: {
        controllerId: explicitWait.owner.controllerId, controllerType: 'chatgpt',
        principalId: explicitWait.owner.principalId!, controllerInstanceId: explicitWait.owner.controllerInstanceId!,
        sessionId: explicitWait.owner.sessionId,
      },
      disposition: 'wait', relayScopeId: explicitWait.claimed.relayScopeId,
    });
    expect(waited.status).toBe('waiting');
    expect(settleControllerRoundAfterTurn(store, { workId: explicitWaitWorkId, completionEvidenceId: 'assistant-turn:wait:settled' }))
      .toMatchObject({ status: 'waiting', disposition: 'wait', roundCount: waited.roundCount });

    const blockedWorkId = 'WORK-AUTONOMOUS-TURN-BLOCKED';
    openClaimed(blockedWorkId);
    createHandoffItem(store, {
      id: 'handoff-autonomous-user-action', repoId: repository.repoId, workId: blockedWorkId,
      title: 'User decision required', severity: 'blocked', reason: 'A user-owned approval decision is required.',
      creationReason: 'policy_approval_required', summary: 'Do not autonomously continue through the approval boundary.',
      currentState: { repoId: repository.repoId, workId: blockedWorkId, statusSummary: 'approval required' },
      evidenceRefs: [], blockingDecision: 'Approve or reject the requested action.',
      recommendedDecision: 'Wait for the user decision.', recommendedPrompt: 'Review the pending approval.',
      suggestedNextActions: [],
    });
    expect(settleControllerRoundAfterTurn(store, { workId: blockedWorkId, completionEvidenceId: 'assistant-turn:block:settled' })).toMatchObject({
      status: 'waiting_for_user', disposition: 'wait_for_user', handoffId: 'handoff-autonomous-user-action',
      controllerTurnCompletionEvidenceId: 'assistant-turn:block:settled',
    });
  });

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
      occurrenceId: 'occurrence-test',
      identity: {
        controllerId: 'chatgpt-principal', controllerType: 'chatgpt',
        principalId: 'chatgpt-principal',
        controllerInstanceId: 'runtime-test',
        sessionId: 'chatgpt-session',
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

  test('frozen-schema goal_complete closes an explicitly completed Work round after MCP session rotation without reclaiming terminal Work', async () => {
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
      outcomeStatement: 'A terminal Controller goal_complete closes only the ControllerRound; Requirement authority remains independent.',
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
      occurrenceId: 'occurrence-test',
      identity: {
        controllerId: 'chatgpt-principal', controllerType: 'chatgpt',
        principalId: 'chatgpt-principal',
        controllerInstanceId: 'runtime-test',
        sessionId: 'mcp-before-finalize',
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
    const beforeSemanticClose = getWorkContract(store, workId)!;
    reviseWorkSemanticContext(store, workId, { expectedRevision: beforeSemanticClose.semanticRevision ?? 1, state: 'completed' });
    expect(getWorkContract(store, workId)?.status).toBe('completed');
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
    expect(wrong.summary).toMatch(/WORK_CONTROLLER_OWNER_MISMATCH|WORK_CONTROLLER_PRINCIPAL_MISMATCH|CONTROLLER_RELAY_CLAIM_|WORK_CONTROLLER_RELAY_SCOPE_MISMATCH/);

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
    expect(completed.data.requirementAcceptance).toBeUndefined();
    expect(readRequirement({ controllerHome }, requirementId)?.value.state).toBe('active');
    expect(completed.data.relay).toMatchObject({
      originWorkId: workId,
      relayScopeId: opened.relayScopeId,
      disposition: 'goal_complete',
      status: 'goal_complete',
      controllerId: 'chatgpt-principal',
      principalId: 'chatgpt-principal',
      sessionId: 'mcp-before-finalize',
    });
    // The rotated MCP transport authenticates this terminal closure but does not
    // become durable ControllerRound authority. Preserve the original claimed relay
    // epoch and do not rewrite or reclaim the physical Work lease.
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
      occurrenceId: 'occurrence-abandoned',
      maxRepeatedState: 3,
      identity: {
        controllerId: 'chatgpt-principal', controllerType: 'chatgpt',
        principalId: 'chatgpt-principal',
        controllerInstanceId: 'runtime-test',
        sessionId: 'mcp-undisposed',
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
      failureClass: 'abandoned_release',
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


  test('cancelled Work abandons its claimed round after exact release so Requirement scope can reopen', () => {
    const root = temp('forge-autonomous-cancelled-round-release-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-cancelled-round-release' });
    const store = { controllerHome, repoId: repository.repoId };
    const requirementId = 'REQ-AUTONOMOUS-CANCELLED-ROUND';
    createRequirement({ controllerHome }, {
      requirementId,
      title: 'Cancelled round recovery',
      outcomeStatement: 'A cancelled Work cannot permanently own the Requirement ControllerRound scope.',
    });
    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'activate_cancelled_round_requirement',
      mutate: (current) => ({ ...current, state: 'active' }),
    });

    const workId = 'WORK-AUTONOMOUS-CANCELLED-ROUND';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Cancel one claimed round without wedging the Requirement scope.',
      acceptanceCriteria: ['cancelled claimed round is mechanically abandoned after exact release'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running', requirementId,
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:cancelled-round', controllerType: 'chatgpt', principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test', sessionId: 'occurrence-cancelled-round',
      },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const owner = claimControllerSession(store, {
      workId, controllerId: 'chatgpt-principal', controllerType: 'chatgpt', principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test', sessionId: 'mcp-cancelled-round',
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: owner })?.status).toBe('claimed');
    transitionWorkContractPhase(store, workId, { status: 'cancelled', phase: 'cleanup', state: 'skipped', summary: 'Cancelled for recovery regression.' });
    releaseControllerSession(store, workId, owner.controllerId);

    const rotatedTransportOwner = { ...owner, sessionId: 'mcp-cancelled-round-rotated' };
    const abandoned = reconcileControllerRoundAfterAbandonedRelease(store, { workId, releasedSession: rotatedTransportOwner });
    expect(abandoned).toMatchObject({
      relayScopeId: opened.relayScopeId,
      status: 'failed',
      lastError: 'CONTROLLER_RELAY_CLAIM_RELEASED_WITHOUT_DISPOSITION',
    });

    const successorWorkId = 'WORK-AUTONOMOUS-CANCELLED-ROUND-SUCCESSOR';
    createWorkContract(store, {
      workId: successorWorkId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Prove the same Requirement scope can open another round after cancellation.',
      acceptanceCriteria: ['same Requirement relay scope is reusable'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running', requirementId,
    });
    const reopened = beginInitialControllerRoundDispatch(store, {
      workId: successorWorkId,
      identity: {
        controllerId: 'schedule:cancelled-round-successor', controllerType: 'chatgpt', principalId: 'forge-scheduler',
        controllerInstanceId: 'runtime-test', sessionId: 'occurrence-cancelled-round-successor',
      },
    });
    expect(reopened).toMatchObject({ status: 'dispatching', relayScopeId: opened.relayScopeId });
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

  test('exact terminal authority closes provider waiting_for_user after explicit semantic Work completion without reclaiming it', async () => {
    const root = temp('forge-terminal-provider-wait-goal-complete-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    const targetRevision = initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'terminal-provider-wait-goal-complete' });
    const store = { controllerHome, repoId: repository.repoId };
    const requirementId = 'REQ-TERMINAL-PROVIDER-WAIT-GOAL-COMPLETE';
    createRequirement({ controllerHome }, {
      requirementId,
      title: 'Terminal provider wait goal closure',
      outcomeStatement: 'A completed Work can close provider authorization wait with exact Controller authority.',
    });
    updateRequirement({ controllerHome }, {
      requirementId,
      action: 'test_activate_requirement',
      mutate: (current) => ({ ...current, state: 'active' }),
    });
    const workId = 'WORK-TERMINAL-PROVIDER-WAIT-GOAL-COMPLETE';
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Complete physical Work while the provider relay waits for user authorization.',
      acceptanceCriteria: ['Exact terminal authority closes provider wait without reclaiming Work.'],
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
      occurrenceId: 'occ-terminal-provider-wait',
      identity: {
        controllerId: 'chatgpt-principal', controllerType: 'chatgpt', principalId: 'chatgpt-principal',
        controllerInstanceId: 'runtime-before-wait', sessionId: 'mcp-before-wait',
      },
    });
    const handoffId = 'hnd-terminal-provider-wait';
    createHandoffItem(store, {
      id: handoffId,
      repoId: repository.repoId,
      workId,
      title: 'provider authorization required',
      severity: 'needs_review',
      reason: 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED',
      creationReason: 'missing_authorization',
      summary: 'provider authorization required before dispatch',
      currentState: { repoId: repository.repoId, workId, statusSummary: 'waiting for provider authorization' },
      evidenceRefs: [],
      recommendedDecision: 'resume after authorization',
      recommendedPrompt: 'resume the existing controller round',
      suggestedNextActions: [],
    });
    expect(finishControllerRoundRelayDispatch(store, {
      workId,
      ok: false,
      waitForUser: true,
      handoffId,
      error: 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED',
    })).toMatchObject({
      status: 'waiting_for_user',
      blockedReason: 'provider_user_action_required',
      authorityId: opened.authorityId,
      claimGeneration: 0,
    });
    expect(getControllerSession(store, workId)).toBeUndefined();

    const recordedAt = '2026-09-21T11:00:00.000Z';
    transitionWorkContractPhase(store, workId, {
      status: 'running', phase: 'verification', state: 'satisfied',
      summary: 'Exact no-change candidate verified while provider authorization wait remains advisory to semantic completion.',
    });
    requestWorkImplementationReview(store, workId, 'Terminal provider-wait candidate requires explicit Controller review.');
    recordWorkImplementationReview(store, workId, {
      schemaVersion: 1,
      reviewId: 'REV-terminal-provider-wait',
      workId,
      reviewerPrincipalId: 'chatgpt-principal',
      reviewerControllerSessionId: 'mcp-before-wait',
      decision: 'approved',
      rationale: 'Physical Work is complete and the only relay blocker is provider authorization unrelated to semantic completion.',
      findings: [],
      sourceRevision: targetRevision,
      workspaceFingerprint: 'terminal-provider-wait-content',
      verificationWorkspaceFingerprint: 'terminal-provider-wait-verification',
      changedPaths: [],
      changedPathDigest: implementationReviewChangedPathDigest([]),
      acceptanceCriteriaSummary: 'Exact terminal authority may close provider wait without reclaiming terminal Work.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt,
    });
    recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'receipt-terminal-provider-wait',
      source: 'controller_work',
      issueId: 'terminal-provider-wait',
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
    const beforeSemanticClose = getWorkContract(store, workId)!;
    reviseWorkSemanticContext(store, workId, { expectedRevision: beforeSemanticClose.semanticRevision ?? 1, state: 'completed' });
    expect(getWorkContract(store, workId)?.status).toBe('completed');
    expect(getControllerSession(store, workId)).toBeUndefined();

    const wrong = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'chatgpt-principal',
        sessionId: 'mcp-after-finalize-wrong-authority',
        controllerInstanceId: 'runtime-after-finalize',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'repair',
        capability_id: `controller.disposition:goal_complete:cra_00000000000000000000000000000000:${opened.relayScopeId}`,
        work_id: workId,
        requirement_id: requirementId,
        reason: 'Wrong authority must not close the provider wait.',
      },
    ));
    expect(wrong.status).toBe('blocked');

    const completed = structured(await callRuntimeTool(
      mcpContext(controllerHome, repository, {
        principalId: 'chatgpt-principal',
        sessionId: 'mcp-after-finalize',
        controllerInstanceId: 'runtime-after-finalize',
      }),
      'rh_work',
      {
        repo_id: repository.repoId,
        operation: 'repair',
        capability_id: `controller.disposition:goal_complete:${opened.authorityId}:${opened.relayScopeId}`,
        work_id: workId,
        requirement_id: requirementId,
        reason: 'Semantic Work completion is proven; provider authorization wait does not block exact ControllerRound closure.',
      },
    ));
    expect(completed.status).toBe('ok');
    expect(completed.data.requirementAcceptance).toBeUndefined();
    expect(readRequirement({ controllerHome }, requirementId)?.value.state).toBe('active');
    expect(completed.data.relay).toMatchObject({
      status: 'goal_complete',
      disposition: 'goal_complete',
      authorityId: opened.authorityId,
      claimGeneration: 0,
      controllerId: 'chatgpt-principal',
      principalId: 'chatgpt-principal',
    });
    expect(getControllerSession(store, workId)).toBeUndefined();
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
      occurrenceId: 'occ-stage3b-round-1',
      maxRounds: 4,
      maxRepeatedState: 4,
      identity: {
        controllerId: 'chatgpt-stage3b', controllerType: 'chatgpt',
        principalId: 'chatgpt-stage3b', controllerInstanceId: 'provider-runtime-1', sessionId: 'provider-session-1',
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
    expect(round2.observationWindow).toHaveLength(1);
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
    expect(round3.observationWindow).toHaveLength(2);
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
    expect(terminal.observationWindow).toHaveLength(3);
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
      occurrenceId: 'occ-terminal-successor',
      identity: { controllerId: 'chatgpt-terminal-successor', controllerType: 'chatgpt', principalId: 'chatgpt-terminal-successor', controllerInstanceId: 'provider-runtime-terminal-successor', sessionId: 'provider-session-terminal-successor' },
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
    const predecessorBeforeClose = getWorkContract(store, predecessorWorkId)!;
    reviseWorkSemanticContext(store, predecessorWorkId, { expectedRevision: predecessorBeforeClose.semanticRevision ?? 1, state: 'completed' });
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

  test('periodic restart reconciliation settles leaked Forge tabs exactly once and preserves user-owned tabs exactly once', async () => {
    const root = temp('forge-autonomous-tab-restart-reconcile-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'tab-restart-reconcile' });
    const store = { controllerHome, repoId: repository.repoId };

    const createWaitingRound = (workId: string, browserSessionId: string) => {
      createWorkContract(store, {
        workId,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        mode: 'goal_workloop',
        objective: 'Keep semantic round durable while ephemeral browser resource is reconciled.',
        acceptanceCriteria: ['restart cleanup is exactly-once and ownership-safe'],
        allowedPaths: [],
        forbiddenPaths: [],
        checks: [],
        constraints: { requireHandoffOnAmbiguity: true },
        requestedBy: 'chatgpt',
        status: 'running',
      });
      const binding = bindChatgptWorkConversation(store, {
        workId,
        conversationUrl: `https://chatgpt.com/c/${workId.toLowerCase()}`,
        latestBrowserSessionId: browserSessionId,
      });
      const identity = {
        controllerId: `controller-${workId}`,
        controllerType: 'chatgpt' as const,
        principalId: `controller-${workId}`,
        controllerInstanceId: 'runtime-before-restart',
        sessionId: `session-${workId}`,
      };
      const opened = beginInitialControllerRoundDispatch(store, {
        workId,
        identity,
        bindingId: binding.bindingId,
      });
      finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId: binding.bindingId });
      const owner = claimControllerSession(store, { workId, ...identity, leaseMs: 60_000 });
      acknowledgeControllerRoundClaim(store, { workId, session: owner });
      const waiting = submitControllerRoundDisposition(store, {
        workId,
        relayScopeId: opened.relayScopeId,
        identity,
        disposition: 'wait',
        reason: 'Simulate an inactive durable round observed after Runtime restart.',
      });
      expect(waiting.status).toBe('waiting');
      releaseControllerSession(store, workId, owner.controllerId);
      return waiting;
    };

    const forgeRelay = createWaitingRound('WORK-TAB-RESTART-FORGE', 'forge-owned-browser-session');
    const userRelay = createWaitingRound('WORK-TAB-RESTART-USER', 'user-owned-browser-session');
    const calls: string[] = [];
    const settleBrowserTab = async (input: { browserSessionId: string }) => {
      calls.push(input.browserSessionId);
      return input.browserSessionId === 'user-owned-browser-session'
        ? { status: 'preserved_user_owned' as const }
        : { status: 'closed' as const };
    };
    const cleanupInput = {
      controllerHome,
      controllerPid: process.pid,
      nowMs: 0,
      cleanupIntervalMs: 60_000,
      repositories: [repository],
      runtimeCleanup: (() => ({ ok: true })) as any,
      terminalWorkCleanup: (async () => ({ inspected: 0, cleaned: 0, blocked: [] })) as any,
      processGc: (() => ({ ok: true })) as any,
      settleBrowserTab: settleBrowserTab as any,
    };

    await runSchedulerPeriodicCleanup(cleanupInput);
    expect(calls.sort()).toEqual(['forge-owned-browser-session', 'user-owned-browser-session'].sort());
    expect(getChatgptControllerRoundSettlement(store, {
      workId: forgeRelay.originWorkId,
      relayScopeId: forgeRelay.relayScopeId,
    })?.status).toBe('closed');
    expect(getChatgptControllerRoundSettlement(store, {
      workId: userRelay.originWorkId,
      relayScopeId: userRelay.relayScopeId,
    })?.status).toBe('preserved_user_owned');

    calls.length = 0;
    await runSchedulerPeriodicCleanup(cleanupInput);
    expect(calls).toEqual([]);
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
    // The exact conversation binding makes the Workflow Supervisor the outer-turn
    // owner, so this pass may only enroll it. Without a Supervisor daemon the pass
    // records a bounded failure instead of dispatching a provider prompt.
    expect(observed).toEqual([]);
    const retryPending = getControllerRoundRelay(store, workId)!;
    expect(retryPending).toMatchObject({ status: 'dispatching', consecutiveFailures: 1 });
    expect(retryPending.lastError).toContain('WORKFLOW_SUPERVISOR_ENROLLMENT_');
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

  test('stalled conversation-pending recovery safely performs the first fresh provider dispatch when no provider attempt began', async () => {
    const root = temp('forge-autonomous-recovery-pre-provider-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-recovery-pre-provider' });
    const workId = 'WORK-AUTONOMOUS-RECOVERY-PRE-PROVIDER';
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Recover a transport interruption that happened before the first provider send began.',
      acceptanceCriteria: ['one fresh dispatch occurs only after durable proof that no provider attempt began'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:pre-provider-recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-pre-provider-recovery',
      },
    });
    expect(opened.status).toBe('dispatching');
    expect(opened.providerDispatchAttempt ?? 0).toBe(0);
    const diagnosticFailureAt = Date.parse(opened.updatedAt) + 1_000;
    const diagnosticFailure = finishControllerRoundRelayDispatch(store, {
      workId,
      ok: false,
      error: 'WORKFLOW_SUPERVISOR_EXACT_WORK_CONVERSATION_REQUIRED',
      recovery: true,
      nowMs: diagnosticFailureAt,
    })!;
    expect(diagnosticFailure).toMatchObject({
      status: 'dispatching',
      lastError: 'WORKFLOW_SUPERVISOR_EXACT_WORK_CONVERSATION_REQUIRED',
    });
    expect(diagnosticFailure.providerDispatchAttempt ?? 0).toBe(0);
    expect(diagnosticFailure.providerDispatchEffectId).toBeUndefined();
    expect(diagnosticFailure.providerDispatchStartedAt).toBeUndefined();
    expect(diagnosticFailure.providerDispatchReceiptId).toBeUndefined();
    const recoveryAt = Date.parse(diagnosticFailure.nextRecoveryAt!);
    const observed: Array<Record<string, unknown>> = [];

    const result = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: recoveryAt,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt: async (input: any) => {
        observed.push(input);
        const binding = bindChatgptWorkConversation(store, {
          workId,
          conversationUrl: 'https://chatgpt.com/c/recovered-pre-provider-conversation',
          latestBrowserSessionId: 'browser-pre-provider-recovery',
        });
        return {
          status: 'dispatched' as const,
          provider: 'controller-browser' as const,
          browserSessionId: binding.latestBrowserSessionId!,
          conversationUrl: binding.conversationUrl,
          conversationId: binding.conversationId,
          localAlias: binding.localAlias,
          resumedFromBinding: false,
          model: 'gpt-5.6',
          reasoning: 'medium' as const,
          tabPolicy: 'auto' as const,
          executionPreferenceVerified: true,
          providerDeliveryStatus: 'dispatch_confirmed' as const,
        };
      },
    });

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      workId,
      conversationUrl: undefined,
      transportConversation: 'fresh',
    });
    expect(getChatgptWorkConversationBinding(store, workId)?.conversationId).toBe('recovered-pre-provider-conversation');
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      status: 'dispatched',
      providerDispatchAttempt: 1,
    });
  });

  test('stalled provider-started recovery becomes outcome-unknown before scheduler can replay it', async () => {
    const root = temp('forge-autonomous-recovery-provider-started-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-recovery-provider-started' });
    const workId = 'WORK-AUTONOMOUS-RECOVERY-PROVIDER-STARTED';
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Never replay a provider send after dispatch may have started without an exact conversation identity.',
      acceptanceCriteria: ['ambiguous provider dispatch remains fenced'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:provider-started-recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-provider-started-recovery',
      },
      maxFailures: 2,
    });
    const started = beginControllerRoundProviderDispatch(store, {
      workId,
      authorityId: opened.authorityId!,
      expectedUpdatedAt: opened.updatedAt,
    });
    expect(started).toMatchObject({ status: 'dispatching', providerDispatchAttempt: 1 });
    const recoveryAt = Date.parse(started.updatedAt) + 61_000;
    let dispatches = 0;

    const result = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: recoveryAt,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt: async () => {
        dispatches += 1;
        throw new Error('ambiguous provider send must not be replayed');
      },
    });

    expect(result).toEqual({ claimed: 0, dispatched: 0, failed: 0 });
    expect(dispatches).toBe(0);
    expect(getControllerRoundRelay(store, workId)).toMatchObject({
      status: 'blocked',
      providerDispatchAttempt: 1,
      blockedReason: 'provider_dispatch_outcome_unknown',
      lastError: 'CONTROLLER_RELAY_PROVIDER_DISPATCH_STALLED_AFTER_EFFECT_START',
    });
  });

  test('stalled ControllerRound recovery records bounded failure when Supervisor enrollment does not happen', async () => {
    const root = temp('forge-autonomous-recovery-enrollment-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome);
    initRepo(repoRoot);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'autonomous-recovery-enrollment' });
    const workId = 'WORK-AUTONOMOUS-RECOVERY-ENROLLMENT';
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Surface a truthful bounded reason when Supervisor enrollment cannot happen.',
      acceptanceCriteria: ['the relay never stays silently dispatching'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    // An exact conversation binding makes the Workflow Supervisor the outer-turn
    // owner, so this pass may only enroll it - never dispatch a provider prompt.
    const binding = bindChatgptWorkConversation(store, {
      workId,
      conversationUrl: 'https://chatgpt.com/c/enrollment-conversation',
      latestBrowserSessionId: 'browser-enrollment',
    });
    beginInitialControllerRoundDispatch(store, {
      workId,
      identity: {
        controllerId: 'schedule:enrollment-recovery', controllerType: 'chatgpt',
        principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test',
        sessionId: 'occurrence-enrollment-recovery',
      },
      bindingId: binding.bindingId,
      maxFailures: 2,
    });
    const dispatched = finishControllerRoundRelayDispatch(store, { workId, ok: true, bindingId: binding.bindingId })!;
    const recoveryAt = Date.parse(dispatched.updatedAt) + 61_000;
    let dispatches = 0;
    const result = await runSchedulerControllerRoundRecovery({
      controllerHome,
      nowMs: recoveryAt,
      repositories: [repository],
      graceMs: 60_000,
      maxRecoveries: 1,
      authorizeWake: () => undefined,
      dispatchPrompt: async () => {
        dispatches += 1;
        throw new Error('recovery must not dispatch while Supervisor owns the outer turn');
      },
    });
    // The recovery attempt is counted as a failure and recorded on the relay, so the
    // next pass backs off instead of repeating the same silent scan every minute.
    expect(result).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(dispatches).toBe(0);
    const relay = getControllerRoundRelay(store, workId)!;
    expect(relay.status).toBe('dispatching');
    expect(relay.consecutiveFailures).toBe(1);
    expect(relay.lastError).toContain('WORKFLOW_SUPERVISOR_ENROLLMENT_');
    expect(relay.nextRecoveryAt).toBeTruthy();
    expect(Date.parse(relay.nextRecoveryAt!)).toBe(recoveryAt + 60_000);
  });

  test('stalled ControllerRound recovery ignores retired phase/review projections and continues repositories independently', async () => {
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
      acceptanceCriteria: ['retired phase/review projections do not suppress recovery of semantic-open Work'],
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

    // Retired phase/review projections are compatibility evidence, not semantic
    // Work authority. Both semantic-open relays are therefore recoverable, and
    // each bounded Supervisor enrollment failure is recorded independently.
    expect(result).toEqual({ claimed: 2, dispatched: 0, failed: 2 });
    // Both Works carry an exact conversation binding, so the Supervisor owns the
    // outer turn: recovery settles each relay with a bounded reason and never
    // dispatches a provider prompt itself.
    expect(observed).toEqual([]);
    const healthyRelayAfterRecovery = getControllerRoundRelay(healthyStore, healthyWorkId)!;
    expect(healthyRelayAfterRecovery.status).toBe('dispatching');
    expect(healthyRelayAfterRecovery.lastError).toContain('WORKFLOW_SUPERVISOR_ENROLLMENT_');
    const legacyProjectionRelayAfterRecovery = getControllerRoundRelay(malformedStore, malformedWorkId)!;
    expect(legacyProjectionRelayAfterRecovery.status).toBe('dispatching');
    expect(legacyProjectionRelayAfterRecovery.lastError).toContain('WORKFLOW_SUPERVISOR_');
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
