import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendVerificationRecord,
  createWorkContract,
} from '../../packages/kernel/work/api/index';
import {
  acknowledgeControllerRoundClaim,
  beginControllerRoundRelayAfterRelease,
  beginInitialControllerRoundDispatch,
  claimControllerSession,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  readControllerRoundContextSnapshot,
  readControllerRoundSemanticStateFingerprint,
  releaseControllerSession,
  submitControllerRoundDisposition,
  type ControllerSession,
} from '../../packages/kernel/controller/api/index';
import type { WorkflowPublicationReceipt } from '../../packages/workflow-runtime/api/index';
import { memoryAddressKey } from '../../packages/kernel/cognition/api/index';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { writeWorkflowRunCheckpoint } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { prepareControllerAssistantContextBundle } from '../../src/runtime/root/controller-round-composition';
import { schedulePublicationOutcomeCollection } from '../../src/runtime/root/assistant-learning-loop';
import { prepareAssistantWorkContext, recordControllerExperience, recordControllerOutcome } from '../../src/runtime/context/assistant-work-context';
import { persistAutomaticControllerRoundLearning } from '../../src/runtime/context/automatic-learning';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { writeProjectIdentity, writeProjectPlacement, writeWorkspaceIdentity } from '../../src/runtime/control-plane/workspace/workspace-store';
import { callRhWorkControllerOperation } from '../../adapters/mcp/runtime-gateway/work-controller-operations';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function time(minute: number): string {
  return new Date(Date.parse('2026-09-08T00:00:00.000Z') + minute * 60_000).toISOString();
}

function fixture(name: string, options: { knowledge?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `forge-learning-loop-${name}-`));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'README.md'), 'learning loop fixture\n');
  writeFileSync(join(repoRoot, 'docs', 'strategy.md'), '小红书 推广 真实指标 经验 下一轮使用。优先使用真实发布结果，不猜测互动数据。\n');
  writeFileSync(join(repoRoot, '.forge', 'project-engineering.json'), JSON.stringify({
    schemaVersion: 1,
    contractId: `learning-${name}`,
    contractVersion: '1',
    projectId: 'project-learning-loop',
    authority: { product: ['docs/strategy.md'], architecture: [], source: ['src/**'] },
    quality: { ux: [], performance: [], nonRegression: ['Learning evidence remains source-bound.'] },
    checks: [],
    journeys: [],
    platforms: [],
    tooling: [],
    skillRefs: [],
    exceptions: [],
    ...(options.knowledge === false ? {} : {
      knowledgeSources: [{
        id: 'xhs-strategy', kind: 'repository', path: 'docs/strategy.md', required: true,
        applicability: { channel: 'xiaohongshu', account: 'account-a', locale: 'zh-CN' },
      }],
    }),
  }, null, 2));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'learning-loop@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Learning Loop Test'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: name });
  const instance = ensureForgeInstanceIdentity({
    controllerHome,
    preferredInstanceId: `forge-learning-${name.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120)}`,
    now: () => time(0),
    label: 'Learning Loop Test',
  });
  const workspaceId = 'workspace-learning-loop';
  writeWorkspaceIdentity({ controllerHome, value: { workspaceId, title: 'Learning Loop Workspace' } });
  writeProjectIdentity({ controllerHome, value: { projectId: 'project-learning-loop', workspaceId, displayName: 'Learning Loop Project' } });
  writeProjectPlacement({ controllerHome, value: {
    projectId: 'project-learning-loop',
    forgeInstanceId: instance.instanceId,
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
  } });
  let now = time(0);
  const store = { controllerHome, repoId: repository.repoId, now: () => now };
  const workId = `work-${name}`;
  createWorkContract(store, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
    mode: 'goal_workloop',
    objective: '小红书 推广 真实指标 经验 下一轮使用，并根据执行证据持续改进。',
    acceptanceCriteria: ['Two learning loops close on durable evidence.'],
    constraints: { workspaceMode: 'current', requireWorktree: false },
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    status: 'running',
  });
  return {
    controllerHome, repoRoot, repository, store, workId, workspaceId, forgeInstanceId: instance.instanceId,
    setNow(value: string) { now = value; },
  };
}

type Fx = ReturnType<typeof fixture>;

function relayIdentity(owner: ControllerSession) {
  return {
    controllerId: owner.controllerId,
    controllerType: owner.controllerType,
    principalId: owner.principalId ?? owner.controllerId,
    controllerInstanceId: owner.controllerInstanceId ?? '',
    sessionId: owner.sessionId,
  };
}

function claimInitialRound(fx: Fx, index: number, maxRounds = 12) {
  const identity = {
    controllerId: 'chatgpt-learning', controllerType: 'chatgpt' as const,
    principalId: 'chatgpt-learning', controllerInstanceId: `runtime-${index}`, sessionId: `session-${index}`,
  };
  const dispatch = beginInitialControllerRoundDispatch(fx.store, {
    workId: fx.workId, occurrenceId: `occurrence-${index}`, identity, maxRounds, maxRepeatedState: 8, maxFailures: 4,
  });
  finishControllerRoundRelayDispatch(fx.store, { workId: fx.workId, ok: true, providerDispatchReceiptId: `dispatch-${index}` });
  const owner = claimControllerSession(fx.store, { ...identity, workId: fx.workId, leaseMs: 60_000 });
  const bundle = prepareControllerAssistantContextBundle(fx.store, fx.workId);
  const relay = acknowledgeControllerRoundClaim(fx.store, { workId: fx.workId, session: owner, assistantContextSnapshot: bundle?.snapshot });
  expect(relay?.status).toBe('claimed');
  return { relay: relay!, owner, bundle };
}

function claimReleasedRound(fx: Fx, released: ControllerSession, index: number) {
  const dispatch = beginControllerRoundRelayAfterRelease(fx.store, { workId: fx.workId, releasedSession: released });
  expect(dispatch?.status).toBe('dispatching');
  finishControllerRoundRelayDispatch(fx.store, { workId: fx.workId, ok: true, providerDispatchReceiptId: `dispatch-${index}` });
  const owner = claimControllerSession(fx.store, {
    workId: fx.workId,
    controllerId: 'chatgpt-learning', controllerType: 'chatgpt', principalId: 'chatgpt-learning',
    controllerInstanceId: `runtime-${index}`, sessionId: `session-${index}`, leaseMs: 60_000,
  });
  const bundle = prepareControllerAssistantContextBundle(fx.store, fx.workId);
  const relay = acknowledgeControllerRoundClaim(fx.store, { workId: fx.workId, session: owner, assistantContextSnapshot: bundle?.snapshot });
  expect(relay?.status).toBe('claimed');
  return { relay: relay!, owner, bundle };
}

function contextUsage(bundle: NonNullable<ReturnType<typeof prepareControllerAssistantContextBundle>>, usedItemId?: string) {
  return bundle.snapshot.items.map((item) => ({
    kind: item.kind,
    itemId: item.itemId,
    decision: item.itemId === usedItemId ? 'used' as const : 'rejected' as const,
    reason: item.itemId === usedItemId ? 'This evidence changed the current decision.' : 'Not needed for this round.',
  }));
}

function closeContinue(fx: Fx, round: ReturnType<typeof claimInitialRound> | ReturnType<typeof claimReleasedRound>, options: {
  usedItemId?: string;
  executionQualityDecisions?: Parameters<typeof submitControllerRoundDisposition>[1]['executionQualityDecisions'];
  executionQualityAdjustmentResults?: Parameters<typeof submitControllerRoundDisposition>[1]['executionQualityAdjustmentResults'];
} = {}) {
  const relay = submitControllerRoundDisposition(fx.store, {
    workId: fx.workId,
    identity: relayIdentity(round.owner),
    disposition: 'continue_immediately',
    relayScopeId: round.relay.relayScopeId,
    maxRounds: 12,
    maxRepeatedState: 8,
    maxFailures: 4,
    executionQualityDecisions: options.executionQualityDecisions,
    executionQualityAdjustmentResults: options.executionQualityAdjustmentResults,
    ...(round.bundle ? {
      assistantContextDigest: round.bundle.snapshot.digest,
      assistantContextUsage: contextUsage(round.bundle, options.usedItemId),
    } : {}),
  });
  expect(relay.status).toBe('pending_release');
  releaseControllerSession(fx.store, fx.workId, round.owner.controllerId);
  return relay;
}

function verificationRecord(fx: Fx, receiptId: string, recordedAt: string, semanticVersion: string, status: 'passed' | 'failed' = 'passed') {
  return {
    checkId: 'package:learning-probe',
    outcome: status === 'passed' ? 'valid_pass' as const : 'valid_fail' as const,
    summary: `learning probe ${status}`,
    recordedAt,
    sourceRevision: semanticVersion,
    workspaceFingerprint: `workspace:${semanticVersion}`,
    verificationInputFingerprint: `input:${semanticVersion}`,
    commandFingerprint: 'command:learning-probe',
    receipt: {
      schemaVersion: 1 as const,
      receiptId,
      resultDigest: `result:${semanticVersion}:${status}`,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: 'package:learning-probe',
      processId: `process:${receiptId}`,
      checkCacheKey: `cache:${semanticVersion}`,
      checkRevision: semanticVersion,
      checkDefinitionDigest: 'definition:learning-probe',
      checkEnvironmentFingerprint: 'environment:test',
      status,
      runtimeStatus: status === 'passed' ? 'succeeded' as const : 'failed' as const,
      ok: status === 'passed',
      exitCode: status === 'passed' ? 0 : 1,
      timedOut: false,
      cancelled: false,
      artifactPath: `/tmp/${receiptId}.json`,
      summary: `learning probe ${status}`,
      startedAt: recordedAt,
      finishedAt: recordedAt,
    },
  };
}

describe('connected assistant learning loops', () => {
  test('knowledge -> Controller decision -> publication -> 24h Outcome -> Experience -> next ControllerRound reuse', () => {
    const fx = fixture('assistant-task');
    fx.setNow(time(1));
    const first = claimInitialRound(fx, 1);
    const knowledge = first.bundle?.snapshot.items.find((item) => item.kind === 'knowledge');
    expect(knowledge?.itemId).toStartWith('xhs-strategy:');

    const publication: WorkflowPublicationReceipt = {
      schemaVersion: 1,
      receiptId: 'workflow-publication-learning-post',
      workflowId: 'xiaohongshu.publish',
      channel: 'xiaohongshu',
      account: 'account-a',
      postId: 'post-learning-1',
      postUrl: 'https://www.xiaohongshu.com/explore/post-learning-1',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      publishedAt: time(5),
      effectReceiptRef: 'effect-publish-1',
      verificationEvidenceRefs: ['effect-verify-1'],
      timeSource: 'effect_receipt_recorded_at',
    };
    writeWorkflowRunCheckpoint({
      controllerHome: fx.controllerHome,
      checkpoint: {
        schemaVersion: 1,
        binding: { workId: fx.workId, runId: 'publish-run-1' },
        workflowId: publication.workflowId,
        version: '1.0.0',
        contentDigest: `sha256:${'b'.repeat(64)}`,
        status: 'succeeded',
        nextStepIndex: 2,
        receipts: [
          { stepId: 'publish', outcome: 'succeeded', receiptRef: publication.effectReceiptRef, recordedAt: publication.publishedAt },
          { stepId: 'verify', outcome: 'succeeded', receiptRef: publication.verificationEvidenceRefs[0], recordedAt: time(6) },
        ],
        outputs: {},
        publicationReceipt: publication,
      },
      inputs: { session_id: 'browser-xhs-post' },
      now: new Date(time(6)),
    });
    const schedule = schedulePublicationOutcomeCollection({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      publication,
      workflowInputs: { session_id: 'browser-xhs-post' },
    });
    expect(schedule.trigger).toMatchObject({ type: 'calendar', calendarAt: time(5 + 24 * 60) });
    expect(schedule.action).toMatchObject({ operation: 'browser_probe', target: 'runtime' });
    expect(schedule.action.arguments).toMatchObject({
      work_id: fx.workId,
      probe_url: publication.postUrl,
      probe_session_id: 'browser-xhs-post',
      wake_on_first_observation: true,
    });
    expect(schedule.stopConditions).toContain('work_terminal');

    closeContinue(fx, first, { usedItemId: knowledge?.itemId });
    fx.setNow(time(5 + 24 * 60 + 5));
    const second = claimReleasedRound(fx, first.owner, 2);
    const outcome = recordControllerOutcome({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      identity: { workId: fx.workId, controllerId: second.owner.controllerId, authorityId: second.relay.authorityId! },
      draft: {
        id: 'outcome-learning-post',
        scope: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
        evidenceRef: publication.receiptId,
        remoteObject: { id: publication.postId, url: publication.postUrl, account: publication.account, channel: publication.channel },
        observedAt: time(5 + 24 * 60 + 5),
        window: { start: publication.publishedAt, end: time(5 + 24 * 60) },
        metrics: [
          { name: 'likes', unit: 'count', value: 18, cumulative: true },
          { name: 'comments', unit: 'count', value: 3, cumulative: true },
        ],
      },
      now: time(5 + 24 * 60 + 5),
    });
    expect(outcome.sourceRoundId).toBe(`${second.relay.relayScopeId}:${second.relay.roundCount}`);
    const experience = recordControllerExperience({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      identity: { workId: fx.workId, controllerId: second.owner.controllerId, authorityId: second.relay.authorityId! },
      draft: {
        id: 'experience-learning-post',
        scope: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
        applicability: { channel: 'xiaohongshu', account: 'account-a', locale: 'zh-CN' },
        kind: 'observation',
        statement: '小红书 推广真实指标显示该发布获得互动，下一轮继续使用真实指标经验而不是猜测。',
        evidenceRefs: [outcome.id],
        counterEvidenceRefs: [],
        recordedAt: time(5 + 24 * 60 + 5),
        expiresAt: time(5 + 24 * 60 + 5 + 30 * 24 * 60),
      },
      now: time(5 + 24 * 60 + 5),
    });
    expect(experience.evidenceRefs).toEqual([outcome.id]);

    closeContinue(fx, second);
    fx.setNow(time(5 + 24 * 60 + 10));
    const third = claimReleasedRound(fx, second.owner, 3);
    const experienceItemId = memoryAddressKey({ scope: experience.scope, id: experience.id });
    const recalled = third.bundle?.snapshot.items.find((item) => item.kind === 'experience' && item.itemId === experienceItemId);
    expect(recalled).toMatchObject({ kind: 'experience', itemId: experienceItemId, revision: 1 });
    const settled = submitControllerRoundDisposition(fx.store, {
      workId: fx.workId,
      identity: relayIdentity(third.owner),
      disposition: 'wait',
      relayScopeId: third.relay.relayScopeId,
      ...(third.bundle ? {
        assistantContextDigest: third.bundle.snapshot.digest,
        assistantContextUsage: contextUsage(third.bundle, experienceItemId),
      } : {}),
    });
    expect(settled.status).toBe('waiting');
    expect(settled.observationWindow?.at(-1)?.assistantContextUsage).toContainEqual(expect.objectContaining({
      kind: 'experience', itemId: experienceItemId, decision: 'used',
    }));
  });

  test('execution evidence -> degradation signal -> adjustment -> post-adjustment verification -> Experience -> next ControllerRound reuse', () => {
    const fx = fixture('execution-improvement', { knowledge: false });
    fx.setNow(time(10));
    const first = claimInitialRound(fx, 1);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-repeat-1', time(11), 'stable'));
    const fpAfterFirst = readControllerRoundSemanticStateFingerprint(fx.store, fx.workId);
    closeContinue(fx, first);

    fx.setNow(time(20));
    const second = claimReleasedRound(fx, first.owner, 2);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-repeat-2', time(21), 'stable'));
    expect(readControllerRoundSemanticStateFingerprint(fx.store, fx.workId)).toBe(fpAfterFirst);
    closeContinue(fx, second);

    fx.setNow(time(30));
    const third = claimReleasedRound(fx, second.owner, 3);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-repeat-3', time(31), 'stable'));
    expect(readControllerRoundSemanticStateFingerprint(fx.store, fx.workId)).toBe(fpAfterFirst);
    closeContinue(fx, third);

    fx.setNow(time(40));
    const fourth = claimReleasedRound(fx, third.owner, 4);
    const qualityContext = readControllerRoundContextSnapshot(fx.store, fourth.relay);
    const signal = qualityContext.executionQualitySignals?.find((item) => item.code === 'repeated_verification');
    expect(signal?.evidenceRefs).toEqual(expect.arrayContaining(['receipt-repeat-1', 'receipt-repeat-2', 'receipt-repeat-3']));
    closeContinue(fx, fourth, {
      executionQualityDecisions: [{
        fingerprint: signal!.fingerprint!, action: 'adjustment',
        reason: 'Repeated identical verification is not useful; change the execution approach before checking again.',
        verificationCondition: 'A new post-adjustment verification fact must be recorded after the decision.',
      }],
    });

    fx.setNow(time(50));
    const fifth = claimReleasedRound(fx, fourth.owner, 5);
    expect(() => submitControllerRoundDisposition(fx.store, {
      workId: fx.workId,
      identity: relayIdentity(fifth.owner),
      disposition: 'continue_immediately',
      relayScopeId: fifth.relay.relayScopeId,
      maxRounds: 12, maxRepeatedState: 8, maxFailures: 4,
      executionQualityAdjustmentResults: [{
        fingerprint: signal!.fingerprint!, outcome: 'improved', evidenceRefs: ['receipt-repeat-3'],
        reason: 'Old evidence must not validate the new adjustment.',
      }],
    })).toThrow('CONTROLLER_QUALITY_ADJUSTMENT_VERIFICATION_EVIDENCE_INVALID');

    const beforeAdjustedVerification = readControllerRoundSemanticStateFingerprint(fx.store, fx.workId);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-adjusted-1', time(51), 'adjusted'));
    const afterAdjustedVerification = readControllerRoundSemanticStateFingerprint(fx.store, fx.workId);
    expect(afterAdjustedVerification).not.toBe(beforeAdjustedVerification);
    closeContinue(fx, fifth, {
      executionQualityAdjustmentResults: [{
        fingerprint: signal!.fingerprint!, outcome: 'improved', evidenceRefs: ['receipt-adjusted-1'],
        reason: 'The adjusted execution produced a new source-bound verification fact.',
      }],
    });

    fx.setNow(time(60));
    const sixth = claimReleasedRound(fx, fifth.owner, 6);
    const experience = recordControllerExperience({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      identity: { workId: fx.workId, controllerId: sixth.owner.controllerId, authorityId: sixth.relay.authorityId! },
      qualityAdjustmentFingerprint: signal!.fingerprint!,
      draft: {
        id: 'experience-execution-adjustment',
        scope: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
        applicability: {},
        kind: 'observation',
        statement: '执行证据显示重复验证后改变执行方式并用调整后的验证结果确认改进；下一轮应优先采用该调整。',
        evidenceRefs: [],
        counterEvidenceRefs: [],
        recordedAt: time(60),
        expiresAt: time(60 + 30 * 24 * 60),
      },
      now: time(60),
    });
    expect(experience.evidenceRefs).toContain('receipt-adjusted-1');
    closeContinue(fx, sixth);

    fx.setNow(time(70));
    const seventh = claimReleasedRound(fx, sixth.owner, 7);
    const experienceItemId = memoryAddressKey({ scope: experience.scope, id: experience.id });
    const recalled = seventh.bundle?.snapshot.items.find((item) => item.kind === 'experience' && item.itemId === experienceItemId);
    expect(recalled).toMatchObject({ kind: 'experience', itemId: experienceItemId, revision: 1 });
    const settled = submitControllerRoundDisposition(fx.store, {
      workId: fx.workId,
      identity: relayIdentity(seventh.owner),
      disposition: 'wait',
      relayScopeId: seventh.relay.relayScopeId,
      ...(seventh.bundle ? {
        assistantContextDigest: seventh.bundle.snapshot.digest,
        assistantContextUsage: contextUsage(seventh.bundle, experienceItemId),
      } : {}),
    });
    expect(settled.status).toBe('waiting');
    expect(settled.observationWindow?.at(-1)?.assistantContextUsage).toContainEqual(expect.objectContaining({
      kind: 'experience', itemId: experienceItemId, decision: 'used',
    }));
  });
  test('closed execution-quality evidence automatically becomes durable cognitive memory and is recalled next round', () => {
    const fx = fixture('automatic-cognition', { knowledge: false });
    fx.setNow(time(10));
    const first = claimInitialRound(fx, 1);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-auto-1', time(11), 'stable'));
    closeContinue(fx, first);

    fx.setNow(time(20));
    const second = claimReleasedRound(fx, first.owner, 2);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-auto-2', time(21), 'stable'));
    closeContinue(fx, second);

    fx.setNow(time(30));
    const third = claimReleasedRound(fx, second.owner, 3);
    appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, 'receipt-auto-3', time(31), 'stable'));
    closeContinue(fx, third);

    fx.setNow(time(40));
    const fourth = claimReleasedRound(fx, third.owner, 4);
    const qualityContext = readControllerRoundContextSnapshot(fx.store, fourth.relay);
    const signal = qualityContext.executionQualitySignals?.find((item) => item.code === 'repeated_verification');
    expect(signal).toBeDefined();
    const sourceRoundId = `${fourth.relay.relayScopeId}:${fourth.relay.roundCount}`;
    closeContinue(fx, fourth);

    const learning = persistAutomaticControllerRoundLearning({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      sourceRoundId,
      signals: [signal!],
      now: time(41),
    });
    expect(learning.storedMemoryIds).toHaveLength(1);
    expect(learning.skipped).toEqual([]);

    fx.setNow(time(50));
    const fifth = claimReleasedRound(fx, fourth.owner, 5);
    const memoryItemId = memoryAddressKey({
      scope: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
      id: learning.storedMemoryIds[0]!,
    });
    expect(fifth.bundle?.snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'knowledge',
      itemId: memoryItemId,
      revision: 1,
    }));
  });

  test('persists Controller-extracted semantic learning after disposition and recalls it on the next round', async () => {
    const fx = fixture('controller-semantic-learning', { knowledge: false });
    fx.setNow(new Date().toISOString());
    const round = claimInitialRound(fx, 1);
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      principalId: round.owner.principalId ?? round.owner.controllerId,
      sessionId: round.owner.sessionId,
      controllerInstanceId: round.owner.controllerInstanceId,
      controllerType: 'chatgpt' as const,
      policy: getMcpPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'core',
    } as unknown as MultiRepositoryMcpToolContext;
    const signal = {
      scope_kind: 'project',
      kind: 'principle',
      valence: 'positive',
      summary: '小红书推广决策应使用真实观察指标，不猜测互动数据。',
      concepts: ['xiaohongshu', 'promotion.real-metrics', 'evidence.observed'],
      facets: ['marketing-principle'],
      admission_source: 'explicit_human',
      portability: 'local',
      salience: 0.95,
      confidence: 0.94,
      utility: 0.86,
    };

    const result = await callRhWorkControllerOperation(ctx, fx.repository, 'controller_disposition', {
      work_id: fx.workId,
      disposition: 'continue_immediately',
      controller_authority_id: round.relay.authorityId,
      relay_scope_id: round.relay.relayScopeId,
      learning_signals: [signal],
      ...(round.bundle ? {
        assistant_context_digest: round.bundle.snapshot.digest,
        assistant_context_usage: contextUsage(round.bundle),
      } : {}),
    });
    expect(result).toBeTruthy();
    const payload = result!.structuredContent as Record<string, any>;
    expect(payload.status, JSON.stringify(payload)).toBe('ok');
    expect(payload.warnings).toEqual([]);
    expect(payload.data.relay.status).toBe('pending_release');
    expect(payload.data.automaticLearning.storedMemoryIds).toHaveLength(1);
    const learnedId = payload.data.automaticLearning.storedMemoryIds[0] as string;
    const sourceRoundId = `${round.relay.relayScopeId}:${round.relay.roundCount}`;

    const retry = persistAutomaticControllerRoundLearning({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      sourceRoundId,
      signals: [],
      controllerSignals: [{
        scopeKind: 'project',
        kind: 'principle',
        valence: 'positive',
        summary: signal.summary,
        concepts: signal.concepts,
        facets: signal.facets,
        admissionSource: 'explicit_human',
        portability: 'local',
        salience: signal.salience,
        confidence: signal.confidence,
        utility: signal.utility,
        evidenceRefs: [],
        counterEvidenceRefs: [],
      }],
    });
    expect(retry.storedMemoryIds).toEqual([learnedId]);

    releaseControllerSession(fx.store, fx.workId, round.owner.controllerId);
    fx.setNow(new Date().toISOString());
    const nextRound = claimReleasedRound(fx, round.owner, 2);
    const learnedItemId = memoryAddressKey({
      scope: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
      id: learnedId,
    });
    expect(nextRound.bundle?.snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'knowledge',
      itemId: learnedItemId,
      revision: 1,
    }));
  });

  test('surfaces automatic learning failure after durable disposition without rolling back or disguising it as skipped', async () => {
    const fx = fixture('transport-learning-warning', { knowledge: false });
    const workId = 'work-transport-learning-warning-unbound';
    createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      scopeRef: { schemaVersion: 1, kind: 'work', id: workId },
      mode: 'goal_workloop',
      objective: 'Prove post-disposition learning failure is diagnostic only.',
      acceptanceCriteria: [],
      constraints: { workspaceMode: 'current', requireWorktree: false },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
    });
    fx.setNow(new Date().toISOString());
    const unboundFx = { ...fx, workId };
    const round = claimInitialRound(unboundFx, 1);
    // Inject the ambiguity after claim so AssistantContext can be prepared
    // successfully and only post-disposition learning observes the failure.
    writeProjectIdentity({
      controllerHome: fx.controllerHome,
      value: {
        projectId: 'project-learning-loop-shadow',
        workspaceId: fx.workspaceId,
        displayName: 'Learning Loop Shadow Project',
      },
    });
    writeProjectPlacement({
      controllerHome: fx.controllerHome,
      value: {
        projectId: 'project-learning-loop-shadow',
        forgeInstanceId: fx.forgeInstanceId,
        repositoryId: fx.repository.repoId,
        checkoutId: fx.repository.activeCheckoutId,
      },
    });
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      principalId: round.owner.principalId ?? round.owner.controllerId,
      sessionId: round.owner.sessionId,
      controllerInstanceId: round.owner.controllerInstanceId,
      controllerType: 'chatgpt' as const,
      policy: getMcpPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'core',
    } as unknown as MultiRepositoryMcpToolContext;

    const result = await callRhWorkControllerOperation(ctx, fx.repository, 'controller_disposition', {
      work_id: workId,
      disposition: 'wait',
      controller_authority_id: round.relay.authorityId,
      relay_scope_id: round.relay.relayScopeId,
      ...(round.bundle ? {
        assistant_context_digest: round.bundle.snapshot.digest,
        assistant_context_usage: contextUsage(round.bundle),
      } : {}),
    });
    expect(result).toBeTruthy();
    const payload = result!.structuredContent as Record<string, any>;
    expect(payload.status).toBe('ok');
    expect(payload.warnings).toEqual([
      expect.stringContaining('Automatic learning failed after the Controller disposition was durably recorded: PROJECT_PLACEMENT_AMBIGUOUS'),
    ]);
    expect(payload.data.automaticLearning).toEqual({
      storedMemoryIds: [],
      consolidatedMemoryIds: [],
      promotedMemoryIds: [],
      requirementCandidateIds: [],
      skipped: [],
    });
    expect(payload.data.relay).toMatchObject({
      originWorkId: workId,
      disposition: 'wait',
      status: 'waiting',
    });
    expect(getControllerRoundRelay(fx.store, workId)).toMatchObject({
      originWorkId: workId,
      disposition: 'wait',
      status: 'waiting',
    });
  });

  test('promotes corroborated engineering learning to Workspace and recalls it in a sibling Project', () => {
    const fx = fixture('workspace-learning', { knowledge: false });
    let previousOwner: ControllerSession | undefined;
    let promotedMemoryId: string | undefined;
    let requirementCandidateId: string | undefined;

    for (let index = 1; index <= 3; index += 1) {
      fx.setNow(time(index * 10));
      const round = index === 1
        ? claimInitialRound(fx, index)
        : claimReleasedRound(fx, previousOwner!, index);
      const receiptId = `receipt-root-cause-${index}`;
      appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, receiptId, time(index * 10 + 1), `root-cause-${index}`));
      const sourceRoundId = `${round.relay.relayScopeId}:${round.relay.roundCount}`;
      closeContinue(fx, round);
      const learning = persistAutomaticControllerRoundLearning({
        controllerHome: fx.controllerHome,
        repoId: fx.repository.repoId,
        workId: fx.workId,
        sourceRoundId,
        signals: [{
          code: 'repeated_root_cause',
          fingerprint: `root-cause-pattern-${index}`,
          evidenceRefs: [receiptId],
          observation: 'Related symptoms share one architecture root cause; batch the correction instead of patching each symptom.',
        }],
        now: time(index * 10 + 2),
      });
      if (index < 3) {
        expect(learning.promotedMemoryIds).toEqual([]);
        expect(learning.requirementCandidateIds).toEqual([]);
      } else {
        expect(learning.consolidatedMemoryIds.length).toBeGreaterThan(0);
        expect(learning.promotedMemoryIds).toHaveLength(1);
        expect(learning.requirementCandidateIds).toHaveLength(1);
        promotedMemoryId = learning.promotedMemoryIds[0];
        requirementCandidateId = learning.requirementCandidateIds[0];
      }
      previousOwner = round.owner;
    }

    const consumerRoot = mkdtempSync(join(tmpdir(), 'forge-learning-loop-consumer-'));
    roots.push(consumerRoot);
    mkdirSync(join(consumerRoot, '.forge'), { recursive: true });
    writeFileSync(join(consumerRoot, 'README.md'), 'consumer project\n');
    writeFileSync(join(consumerRoot, '.forge', 'project-engineering.json'), JSON.stringify({
      schemaVersion: 1,
      contractId: 'learning-consumer',
      contractVersion: '1',
      projectId: 'project-learning-consumer',
      authority: { product: ['README.md'], architecture: [], source: ['src/**'] },
      quality: { ux: [], performance: [], nonRegression: [] },
      checks: [], journeys: [], platforms: [], tooling: [], skillRefs: [], exceptions: [],
    }, null, 2));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: consumerRoot });
    execFileSync('git', ['config', 'user.email', 'learning-loop@example.test'], { cwd: consumerRoot });
    execFileSync('git', ['config', 'user.name', 'Learning Loop Test'], { cwd: consumerRoot });
    execFileSync('git', ['add', '.'], { cwd: consumerRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: consumerRoot });
    const consumerRepository = registerRepository({ path: consumerRoot, controllerHome: fx.controllerHome, displayName: 'learning consumer' });
    writeProjectIdentity({ controllerHome: fx.controllerHome, value: {
      projectId: 'project-learning-consumer',
      workspaceId: fx.workspaceId,
      displayName: 'Learning Consumer Project',
    } });
    writeProjectPlacement({ controllerHome: fx.controllerHome, value: {
      projectId: 'project-learning-consumer',
      forgeInstanceId: fx.forgeInstanceId,
      repositoryId: consumerRepository.repoId,
      checkoutId: consumerRepository.activeCheckoutId,
    } });
    const consumerWorkId = 'work-learning-consumer';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: consumerRepository.repoId }, {
      workId: consumerWorkId,
      repoId: consumerRepository.repoId,
      checkoutId: consumerRepository.activeCheckoutId,
      scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-learning-consumer' },
      mode: 'goal_workloop',
      objective: 'Apply forge.execution-quality.repeated_root_cause guidance to avoid symptom-by-symptom patches.',
      acceptanceCriteria: [],
      constraints: { workspaceMode: 'current', requireWorktree: false },
      allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'chatgpt', status: 'running',
    });

    const consumerContext = prepareControllerAssistantContextBundle({
      controllerHome: fx.controllerHome,
      repoId: consumerRepository.repoId,
    }, consumerWorkId);
    const promotedItemId = memoryAddressKey({
      scope: { schemaVersion: 1, kind: 'workspace', id: fx.workspaceId },
      id: promotedMemoryId!,
    });
    const requirementCandidateItemId = memoryAddressKey({
      scope: { schemaVersion: 1, kind: 'workspace', id: fx.workspaceId },
      id: requirementCandidateId!,
    });
    expect(consumerContext?.snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'knowledge',
      itemId: promotedItemId,
    }));
    expect(consumerContext?.snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'knowledge',
      itemId: requirementCandidateItemId,
    }));
    const resolvedConsumerContext = prepareAssistantWorkContext({
      controllerHome: fx.controllerHome,
      repoId: consumerRepository.repoId,
      workId: consumerWorkId,
      query: 'forge.requirement-candidate repeated root cause',
      now: time(32),
    });
    expect(resolvedConsumerContext?.items).toContainEqual(expect.objectContaining({
      kind: 'knowledge',
      id: requirementCandidateItemId,
      text: expect.stringContaining('[memory:candidate-finding,requirement-candidate,advisory'),
    }));
  });

  test('ControllerRound context excludes unbound handoff noise but retains Work-bound and explicit user handoffs', () => {
    const fx = fixture('handoff-context-scope', { knowledge: false });
    const round = claimInitialRound(fx, 1);
    const baselineFingerprint = readControllerRoundSemanticStateFingerprint(fx.store, fx.workId);

    createHandoffItem(fx.store, {
      id: 'HND-UNBOUND-NOISE', repoId: fx.repository.repoId,
      title: 'old repository-level attention', severity: 'needs_review', reason: 'legacy unrelated attention',
      summary: 'This repository-level handoff is not part of the current Work lineage.',
      currentState: { repoId: fx.repository.repoId, statusSummary: 'unrelated repository attention' },
      evidenceRefs: [], recommendedDecision: 'review elsewhere', recommendedPrompt: 'review elsewhere', suggestedNextActions: [],
    });
    expect(readControllerRoundSemanticStateFingerprint(fx.store, fx.workId)).toBe(baselineFingerprint);
    expect(readControllerRoundContextSnapshot(fx.store, round.relay).handoffs.map((handoff) => handoff.id)).not.toContain('HND-UNBOUND-NOISE');

    createHandoffItem(fx.store, {
      id: 'HND-CURRENT-WORK', repoId: fx.repository.repoId, workId: fx.workId,
      title: 'current Work attention', severity: 'needs_review', reason: 'current Work needs a bounded decision',
      summary: 'This handoff belongs to the current Work.',
      currentState: { repoId: fx.repository.repoId, workId: fx.workId, statusSummary: 'current Work attention' },
      evidenceRefs: [], recommendedDecision: 'review current Work', recommendedPrompt: 'review current Work', suggestedNextActions: [],
    });
    expect(readControllerRoundSemanticStateFingerprint(fx.store, fx.workId)).not.toBe(baselineFingerprint);
    expect(readControllerRoundContextSnapshot(fx.store, round.relay).handoffs.map((handoff) => handoff.id)).toContain('HND-CURRENT-WORK');

    createHandoffItem(fx.store, {
      id: 'HND-EXPLICIT-USER', repoId: fx.repository.repoId,
      title: 'explicit user decision', severity: 'needs_review', reason: 'current round explicitly waits for this user decision',
      summary: 'Unbound handoff is relevant only because the current round explicitly references it.',
      currentState: { repoId: fx.repository.repoId, statusSummary: 'waiting for explicit user decision' },
      evidenceRefs: [], recommendedDecision: 'decide', recommendedPrompt: 'decide and resume', suggestedNextActions: [],
    });
    const waiting = submitControllerRoundDisposition(fx.store, {
      workId: fx.workId, identity: relayIdentity(round.owner), disposition: 'wait_for_user',
      relayScopeId: round.relay.relayScopeId, handoffId: 'HND-EXPLICIT-USER',
    });
    const waitingHandoffs = readControllerRoundContextSnapshot(fx.store, waiting).handoffs.map((handoff) => handoff.id);
    expect(waitingHandoffs).toContain('HND-CURRENT-WORK');
    expect(waitingHandoffs).toContain('HND-EXPLICIT-USER');
    expect(waitingHandoffs).not.toContain('HND-UNBOUND-NOISE');
  });

});
