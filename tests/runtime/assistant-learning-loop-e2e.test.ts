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
import { cognitiveUsageFeedbackForContext, prepareAssistantWorkContext, recordControllerExperience, recordControllerOutcome } from '../../src/runtime/context/assistant-work-context';
import { parseControllerLearningSignalDrafts, persistAutomaticControllerRoundLearning } from '../../src/runtime/context/automatic-learning';
import { cognitionReadPort } from '../../src/runtime/control-plane/persistence/cognition-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { writeProjectIdentity, writeProjectPlacement, writeWorkspaceIdentity } from '../../src/runtime/control-plane/workspace/workspace-store';
import { callRhWorkControllerOperation } from '../../adapters/mcp/runtime-gateway/work-controller-operations';
import { buildFrozenSemanticCompatibilityCapability } from '../../adapters/mcp/frozen-client-semantic-compatibility';
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
    ...(item.itemId === usedItemId ? {} : { rejectionKind: 'irrelevant' as const }),
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
    expect(outcome.sourceRoundId).toBe(`work:${fx.workId}:r1`);
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
  test('keeps execution-quality evidence observable until the model authors a semantic learning signal', () => {
    const fx = fixture('model-owned-cognition', { knowledge: false });
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
    expect(signal?.evidenceRefs).toEqual(expect.arrayContaining(['receipt-auto-1', 'receipt-auto-2', 'receipt-auto-3']));
    const sourceRoundId = `${fourth.relay.relayScopeId}:${fourth.relay.roundCount}`;
    closeContinue(fx, fourth);

    const learning = persistAutomaticControllerRoundLearning({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      sourceRoundId,
      controllerSignals: [],
      now: time(41),
    });
    expect(learning).toEqual({
      storedMemoryIds: [],
      consolidatedMemoryIds: [],
      promotedMemoryIds: [],
      requirementCandidateIds: [],
      skipped: [],
    });
    const machineDerivedMemory = cognitionReadPort(fx.controllerHome).exactByConcept(
      [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      ['forge.execution-quality.repeated_verification'],
      8,
      time(41),
    );
    expect(machineDerivedMemory).toEqual([]);
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

    const result = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'repair',
      work_id: fx.workId,
      disposition: 'continue_immediately',
      controller_authority_id: round.relay.authorityId,
      relay_scope_id: round.relay.relayScopeId,
      capability_id: buildFrozenSemanticCompatibilityCapability({
        operation: 'controller_disposition',
        args: { learning_signals: [signal] },
      }),
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

    appendVerificationRecord(fx.store, fx.workId, verificationRecord(
      fx,
      'receipt-feedback-progress',
      new Date().toISOString(),
      'feedback-progress',
    ));
    closeContinue(fx, nextRound, { usedItemId: learnedItemId });

    fx.setNow(new Date().toISOString());
    const staleRound = claimReleasedRound(fx, nextRound.owner, 3);
    const staleUsage = staleRound.bundle?.snapshot.items.map(item => ({
      kind: item.kind,
      itemId: item.itemId,
      decision: 'rejected' as const,
      reason: item.itemId === learnedItemId ? 'New evidence supersedes this guidance.' : 'Not relevant to this round.',
      rejectionKind: item.itemId === learnedItemId ? 'stale' as const : 'irrelevant' as const,
    }));
    const staleDisposition = submitControllerRoundDisposition(fx.store, {
      workId: fx.workId,
      identity: relayIdentity(staleRound.owner),
      disposition: 'wait',
      relayScopeId: staleRound.relay.relayScopeId,
      ...(staleRound.bundle ? {
        assistantContextDigest: staleRound.bundle.snapshot.digest,
        assistantContextUsage: staleUsage!,
      } : {}),
    });
    expect(staleDisposition.status).toBe('waiting');

    const feedback = cognitiveUsageFeedbackForContext({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      scopes: [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      projectId: 'project-learning-loop',
    });
    const learnedFeedback = feedback.find(item => memoryAddressKey(item.address) === learnedItemId);
    expect(learnedFeedback).toMatchObject({ usedCount: 1, rejectedCount: 1, staleCount: 1, conflictCount: 0 });
    expect(cognitiveUsageFeedbackForContext({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      scopes: [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      projectId: 'project-learning-loop',
    })).toEqual(feedback);
  });

  test('closes portable product-design learning from Controller teaching through sibling recall, usage, and audit', async () => {
    const fx = fixture('portable-human-teaching', { knowledge: false });
    const sourceNow = new Date().toISOString();
    fx.setNow(sourceNow);
    const round = claimInitialRound(fx, 1);
    const sourceRoundId = `${round.relay.relayScopeId}:${round.relay.roundCount}`;
    const sourceCtx = {
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
      scope_kind: 'workspace',
      kind: 'principle',
      valence: 'positive',
      summary: 'Copy explains invisible rules, not interaction that should be self explanatory.',
      concepts: ['product.interaction.self-explanatory', 'copy.invisible-rules'],
      facets: ['product-design'],
      admission_source: 'explicit_human',
      portability: 'portable',
      salience: 0.98,
      confidence: 0.96,
      utility: 0.9,
    };
    const sourceDisposition = await callRhWorkControllerOperation(sourceCtx, fx.repository, 'controller_disposition', {
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
    expect(sourceDisposition).toBeTruthy();
    const sourcePayload = sourceDisposition!.structuredContent as Record<string, any>;
    expect(sourcePayload.status, JSON.stringify(sourcePayload)).toBe('ok');
    expect(sourcePayload.data.automaticLearning.storedMemoryIds).toHaveLength(1);
    const learnedId = sourcePayload.data.automaticLearning.storedMemoryIds[0] as string;
    const learnedItemId = memoryAddressKey({
      scope: { schemaVersion: 1, kind: 'workspace', id: fx.workspaceId },
      id: learnedId,
    });
    const workspaceMemory = cognitionReadPort(fx.controllerHome).readByIds(
      [{ schemaVersion: 1, kind: 'workspace', id: fx.workspaceId }], [learnedId],
    )[0];
    expect(workspaceMemory).toMatchObject({
      id: learnedId,
      scope: { kind: 'workspace', id: fx.workspaceId },
      provenance: { sourceWorkId: fx.workId, sourceRoundId },
    });
    expect(workspaceMemory?.facets).toContain('source.explicit_human');
    expect(workspaceMemory?.facets).toContain('portability.portable');
    releaseControllerSession(fx.store, fx.workId, round.owner.controllerId);

    const consumerRoot = mkdtempSync(join(tmpdir(), 'forge-product-principle-consumer-'));
    roots.push(consumerRoot);
    mkdirSync(join(consumerRoot, '.forge'), { recursive: true });
    writeFileSync(join(consumerRoot, 'README.md'), 'product design consumer\n');
    writeFileSync(join(consumerRoot, '.forge', 'project-engineering.json'), JSON.stringify({
      schemaVersion: 1,
      contractId: 'product-principle-consumer',
      contractVersion: '1',
      projectId: 'project-product-principle-consumer',
      authority: { product: ['README.md'], architecture: [], source: ['src/**'] },
      quality: { ux: [], performance: [], nonRegression: [] },
      checks: [], journeys: [], platforms: [], tooling: [], skillRefs: [], exceptions: [],
    }, null, 2));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: consumerRoot });
    execFileSync('git', ['config', 'user.email', 'learning-loop@example.test'], { cwd: consumerRoot });
    execFileSync('git', ['config', 'user.name', 'Learning Loop Test'], { cwd: consumerRoot });
    execFileSync('git', ['add', '.'], { cwd: consumerRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: consumerRoot });
    const consumerRepository = registerRepository({ path: consumerRoot, controllerHome: fx.controllerHome, displayName: 'product principle consumer' });
    writeProjectIdentity({ controllerHome: fx.controllerHome, value: {
      projectId: 'project-product-principle-consumer', workspaceId: fx.workspaceId, displayName: 'Product Principle Consumer',
    } });
    writeProjectPlacement({ controllerHome: fx.controllerHome, value: {
      projectId: 'project-product-principle-consumer', forgeInstanceId: fx.forgeInstanceId,
      repositoryId: consumerRepository.repoId, checkoutId: consumerRepository.activeCheckoutId,
    } });
    const consumerWorkId = 'work-product-principle-consumer';
    let consumerNow = new Date(Date.parse(sourceNow) + 60_000).toISOString();
    const consumerStore = { controllerHome: fx.controllerHome, repoId: consumerRepository.repoId, now: () => consumerNow };
    createWorkContract(consumerStore, {
      workId: consumerWorkId,
      repoId: consumerRepository.repoId,
      checkoutId: consumerRepository.activeCheckoutId,
      scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-product-principle-consumer' },
      objective: 'Design mobile settings so controls, visible state, and flow make operation understandable; reserve explanatory copy for invisible rules and consequences.',
      acceptanceCriteria: [],
      constraints: { workspaceMode: 'current', requireWorktree: false },
      allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'chatgpt', status: 'running',
    });
    const consumerIdentity = {
      controllerId: 'chatgpt-product-consumer', controllerType: 'chatgpt' as const,
      principalId: 'chatgpt-product-consumer', controllerInstanceId: 'runtime-product-consumer', sessionId: 'session-product-consumer',
    };
    const consumerDispatch = beginInitialControllerRoundDispatch(consumerStore, {
      workId: consumerWorkId, occurrenceId: 'occurrence-product-consumer', identity: consumerIdentity,
      maxRounds: 8, maxRepeatedState: 4, maxFailures: 3,
    });
    expect(consumerDispatch.status).toBe('dispatching');
    finishControllerRoundRelayDispatch(consumerStore, { workId: consumerWorkId, ok: true, providerDispatchReceiptId: 'dispatch-product-consumer' });
    const consumerOwner = claimControllerSession(consumerStore, { ...consumerIdentity, workId: consumerWorkId, leaseMs: 60_000 });
    const consumerBundle = prepareControllerAssistantContextBundle(consumerStore, consumerWorkId);
    const consumerRelay = acknowledgeControllerRoundClaim(consumerStore, {
      workId: consumerWorkId, session: consumerOwner, assistantContextSnapshot: consumerBundle?.snapshot,
    });
    expect(consumerRelay?.status).toBe('claimed');
    expect(consumerBundle?.snapshot.items).toContainEqual(expect.objectContaining({ kind: 'knowledge', itemId: learnedItemId }));
    const beforeUse = prepareAssistantWorkContext({
      controllerHome: fx.controllerHome, repoId: consumerRepository.repoId, workId: consumerWorkId,
      query: 'controls visible state flow self explanatory invisible rules', now: consumerNow,
    });
    const recalledBeforeUse = beforeUse?.items.find(item => item.id === learnedItemId);
    expect(recalledBeforeUse?.activation?.reasons.some(reason => reason.startsWith('lexical:') || reason.startsWith('exact:'))).toBe(true);
    const consumerDisposition = submitControllerRoundDisposition(consumerStore, {
      workId: consumerWorkId,
      identity: relayIdentity(consumerOwner),
      disposition: 'wait',
      relayScopeId: consumerRelay!.relayScopeId,
      ...(consumerBundle ? {
        assistantContextDigest: consumerBundle.snapshot.digest,
        assistantContextUsage: contextUsage(consumerBundle, learnedItemId),
      } : {}),
    });
    expect(consumerDisposition.status).toBe('waiting');
    consumerNow = new Date(Date.parse(sourceNow) + 120_000).toISOString();
    const afterUse = prepareAssistantWorkContext({
      controllerHome: fx.controllerHome, repoId: consumerRepository.repoId, workId: consumerWorkId,
      query: 'controls visible state flow self explanatory invisible rules', now: consumerNow,
    });
    expect(afterUse?.items.find(item => item.id === learnedItemId)?.activation?.reasons).toContain('usage:used:1;rejected:0');

    const auditCtx = {
      controllerHome: fx.controllerHome,
      repoRoot: consumerRoot,
      policy: getMcpPolicy('controller', { repoRoot: consumerRoot }),
      toolset: 'core',
      enableChatgptBrowser: false,
      explicitRepository: consumerRepository,
    } as unknown as MultiRepositoryMcpToolContext;
    const auditResult = await callRuntimeTool(auditCtx, 'rh_context', {
      repo_id: consumerRepository.repoId,
      operation: 'search',
      work_id: consumerWorkId,
      knowledge_query: 'controls visible state invisible rules',
      knowledge_memory_id: learnedId,
      knowledge_limit: 8,
      detail_level: 'detail',
    });
    expect(auditResult).toBeTruthy();
    const auditPayload = auditResult!.structuredContent as Record<string, any>;
    const audited = auditPayload.data.cognitionAudit.items.find((item: any) => item.memory.id === learnedId);
    expect(audited).toMatchObject({
      memory: { provenance: { sourceWorkId: fx.workId, sourceRoundId } },
      recentUsage: { usedCount: 1, rejectedCount: 0 },
    });
    expect(audited.activation.reasons).toContainEqual(expect.objectContaining({ signal: 'usage', detail: 'used:1;rejected:0' }));

    const generalized = parseControllerLearningSignalDrafts([{
      scope_kind: 'workspace', kind: 'product-architecture-pattern', valence: 'positive',
      summary: 'The model may generalize evidence-backed guidance to Workspace when it judges the lesson genuinely cross-project.', concepts: ['workspace.generalization'], facets: [],
      admission_source: 'controller_observation', portability: 'portable', salience: 0.8, confidence: 0.7, utility: 0.6,
    }]);
    expect(generalized[0]).toMatchObject({ scopeKind: 'workspace', kind: 'product-architecture-pattern', portability: 'portable' });
    expect(() => parseControllerLearningSignalDrafts([{
      scope_kind: 'workspace', kind: 'principle', valence: 'positive',
      summary: 'Workspace scope still requires explicit portable intent.', concepts: ['workspace.portability'], facets: [],
      admission_source: 'explicit_human', portability: 'local', salience: 0.8, confidence: 0.7, utility: 0.6,
    }])).toThrow('COGNITION_CONTROLLER_LEARNING_WORKSPACE_PORTABILITY_REQUIRED:0');
  });

  test('automatically associates paraphrased learning across rounds and consolidates after two corroborating sources', () => {
    const fx = fixture('automatic-association', { knowledge: false });
    const projectScope = { schemaVersion: 1 as const, kind: 'project' as const, id: 'project-learning-loop' };

    fx.setNow(time(10));
    const firstRound = claimInitialRound(fx, 1);
    const firstRoundId = `${firstRound.relay.relayScopeId}:${firstRound.relay.roundCount}`;
    closeContinue(fx, firstRound);
    const first = persistAutomaticControllerRoundLearning({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      sourceRoundId: firstRoundId,
      controllerSignals: [{
        scopeKind: 'project', kind: 'principle', valence: 'positive',
        summary: '交互本身应该说明如何使用，说明文案只解释用户看不见的规则。',
        concepts: ['product.interaction', 'copy.invisible-rules', 'ui.self-explanatory'],
        facets: ['product-design'], admissionSource: 'explicit_human', portability: 'local',
        salience: 0.95, confidence: 0.94, utility: 0.86, evidenceRefs: [], counterEvidenceRefs: [],
      }],
      now: time(12),
    });
    expect(first.storedMemoryIds).toHaveLength(1);
    expect(first.consolidatedMemoryIds).toEqual([]);

    fx.setNow(time(20));
    const secondRound = claimReleasedRound(fx, firstRound.owner, 2);
    const secondRoundId = `${secondRound.relay.relayScopeId}:${secondRound.relay.roundCount}`;
    closeContinue(fx, secondRound);
    const second = persistAutomaticControllerRoundLearning({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      workId: fx.workId,
      sourceRoundId: secondRoundId,
      controllerSignals: [{
        scopeKind: 'project', kind: 'principle', valence: 'positive',
        summary: '移动端应通过控件、状态和流程让操作自解释，不要用教程文字补偿模糊交互。',
        concepts: ['product.interaction', 'ui.visible-state', 'copy.invisible-rules'],
        facets: ['product-design'], admissionSource: 'controller_observation', portability: 'local',
        salience: 0.88, confidence: 0.82, utility: 0.8, evidenceRefs: [], counterEvidenceRefs: [],
      }],
      now: time(22),
    });
    expect(second.storedMemoryIds).toHaveLength(1);
    expect(second.consolidatedMemoryIds.length).toBeGreaterThan(0);

    const neighbors = cognitionReadPort(fx.controllerHome).neighbors([
      { scope: projectScope, id: second.storedMemoryIds[0]! },
    ], 32, time(22));
    const relation = neighbors.find(item => item.memory.id === first.storedMemoryIds[0]!)?.edge.relation;
    expect(relation).toBeDefined();
    expect(['supports', 'analogous_to']).toContain(relation!);
  });

  test('surfaces model-authored learning persistence failure after durable disposition without rolling back it', async () => {
    const fx = fixture('transport-learning-warning', { knowledge: false });
    const workId = 'work-transport-learning-warning-unbound';
    createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      scopeRef: { schemaVersion: 1, kind: 'work', id: workId },
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
      learning_signals: [{
        scope_kind: 'project',
        kind: 'principle',
        valence: 'neutral',
        summary: 'A model-authored lesson should fail diagnostically if its semantic Project scope becomes ambiguous after disposition.',
        concepts: ['cognition.model-authored', 'project-placement'],
        facets: ['architecture'],
        admission_source: 'controller_observation',
        portability: 'local',
        salience: 0.7,
        confidence: 0.65,
        utility: 0.6,
      }],
      ...(round.bundle ? {
        assistant_context_digest: round.bundle.snapshot.digest,
        assistant_context_usage: contextUsage(round.bundle),
      } : {}),
    });
    expect(result).toBeTruthy();
    const payload = result!.structuredContent as Record<string, any>;
    expect(payload.status).toBe('ok');
    expect(payload.warnings).toEqual([
      expect.stringContaining('Model-authored learning persistence failed after the Controller disposition was durably recorded: PROJECT_PLACEMENT_AMBIGUOUS'),
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

  test('consolidates repeated model-authored engineering learning without inventing Workspace or Requirement promotion', () => {
    const fx = fixture('project-learning-trust', { knowledge: false });
    let previousOwner: ControllerSession | undefined;
    let finalLearning: ReturnType<typeof persistAutomaticControllerRoundLearning> | undefined;

    for (let index = 1; index <= 3; index += 1) {
      fx.setNow(time(index * 10));
      const round = index === 1
        ? claimInitialRound(fx, index)
        : claimReleasedRound(fx, previousOwner!, index);
      const receiptId = `receipt-root-cause-${index}`;
      appendVerificationRecord(fx.store, fx.workId, verificationRecord(fx, receiptId, time(index * 10 + 1), `root-cause-${index}`));
      const sourceRoundId = `${round.relay.relayScopeId}:${round.relay.roundCount}`;
      closeContinue(fx, round);
      finalLearning = persistAutomaticControllerRoundLearning({
        controllerHome: fx.controllerHome,
        repoId: fx.repository.repoId,
        workId: fx.workId,
        sourceRoundId,
        controllerSignals: [{
          scopeKind: 'project',
          kind: 'principle',
          valence: 'neutral',
          summary: index === 1
            ? 'Related symptoms may share one architecture root cause; batch the correction instead of patching each symptom.'
            : 'When related symptoms share an architecture root cause, prefer one batched root correction over symptom patches.',
          concepts: ['architecture.root-cause', 'delivery.batch-correction', 'engineering.systemic-fix'],
          facets: ['engineering-principle'],
          admissionSource: 'controller_observation',
          portability: 'local',
          salience: 0.86,
          confidence: 0.78,
          utility: 0.82,
          evidenceRefs: [receiptId],
          counterEvidenceRefs: [],
        }],
        now: time(index * 10 + 2),
      });
      expect(finalLearning.promotedMemoryIds).toEqual([]);
      expect(finalLearning.requirementCandidateIds).toEqual([]);
      previousOwner = round.owner;
    }

    expect(finalLearning?.consolidatedMemoryIds.length).toBeGreaterThan(0);
    const projectMemories = cognitionReadPort(fx.controllerHome).exactByConcept(
      [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      ['architecture.root-cause'],
      16,
      time(32),
    );
    expect(projectMemories.length).toBeGreaterThanOrEqual(3);
    const workspaceMemories = cognitionReadPort(fx.controllerHome).exactByConcept(
      [{ schemaVersion: 1, kind: 'workspace', id: fx.workspaceId }],
      ['architecture.root-cause'],
      16,
      time(32),
    );
    expect(workspaceMemories).toEqual([]);
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


describe('direct model-authored learning without Work lifecycle', () => {
  test('records explicit correction with direct-read evidence and recalls it through ordinary capability context', async () => {
    const fx = fixture('direct-learning', { knowledge: false });
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      explicitRepository: fx.repository,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'chatgpt-direct-learning',
      sessionId: 'session-direct-learning',
      controllerInstanceId: 'instance-direct-learning',
      controllerType: 'chatgpt' as const,
      policy: getMcpPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'core',
      toolsetLocked: true,
    } as unknown as MultiRepositoryMcpToolContext;

    const observation = await callRuntimeTool(ctx, 'plugin_action_execute', {
      plugin_id: 'local_system',
      action_id: 'list_targets',
      request_id: 'direct-learning-observation',
      arguments: {},
    });
    expect(observation?.isError).not.toBe(true);
    const observationPayload = observation?.structuredContent as Record<string, any>;
    expect(observationPayload.direct).toBe(true);
    expect(observationPayload.durable).toBe(false);
    expect(observationPayload.observationReceiptId).toMatch(/^PLG-OBS-/);

    const learning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      learning_signals: [{
        scope_kind: 'project',
        kind: 'correction',
        valence: 'positive',
        summary: 'For local filesystem discovery, prefer the Local System capability over Personal Knowledge when the target is an authorized local file.',
        concepts: ['local-system', 'personal-knowledge', 'filesystem-routing'],
        facets: ['capability-routing', 'user-correction'],
        admission_source: 'explicit_human',
        portability: 'local',
        salience: 0.95,
        confidence: 0.96,
        utility: 0.93,
        evidence_refs: [observationPayload.observationReceiptId],
      }],
    });
    expect(learning?.isError).not.toBe(true);
    const learningPayload = learning?.structuredContent as Record<string, any>;
    expect(learningPayload.status).toBe('ok');
    expect(learningPayload.data.storedMemoryIds).toHaveLength(1);

    const memoryId = String(learningPayload.data.storedMemoryIds[0]);
    const workspaceLearning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      learning_signals: [{
        scope_kind: 'workspace',
        kind: 'principle',
        valence: 'positive',
        summary: 'Portable generic filesystem routing guidance may be useful when a Project has no local routing memory.',
        concepts: ['local-system', 'filesystem-routing', 'portable-fallback'],
        facets: ['capability-routing', 'portable-guidance'],
        admission_source: 'explicit_human',
        portability: 'portable',
        salience: 0.9,
        confidence: 0.9,
        utility: 0.9,
      }],
    });
    expect(workspaceLearning?.isError).not.toBe(true);
    const workspaceLearningPayload = workspaceLearning?.structuredContent as Record<string, any>;
    const workspaceMemoryId = String(workspaceLearningPayload.data.storedMemoryIds[0]);

    const learned = cognitionReadPort(fx.controllerHome).readByIds(
      [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      [memoryId],
    )[0];
    expect(learned?.provenance.sourceKind).toBe('controller');
    expect(learned?.provenance.sourceWorkId).toBeUndefined();
    expect(learned?.provenance.sourceRoundId).toBeUndefined();
    expect(learned?.provenance.evidenceRefs).toEqual([observationPayload.observationReceiptId]);

    const recalled = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'list',
      query: 'find an authorized local filesystem file with Local System rather than Personal Knowledge',
      detail_level: 'summary',
    });
    expect(recalled?.isError).not.toBe(true);
    const recalledPayload = recalled?.structuredContent as Record<string, any>;
    expect(recalledPayload.data.learningRecall).toMatchObject({
      scopePolicy: 'narrow_scopes_then_workspace_fallback',
      progressiveAttention: {
        workingSetBounded: true,
        moreCandidatesAvailable: expect.any(Boolean),
        inspectedCandidates: expect.any(Number),
        modelDecision: expect.any(String),
      },
    });
    expect(recalledPayload.data.learningRecall.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memoryId: expect.stringContaining(memoryId),
        text: expect.stringContaining('Local System'),
      }),
    ]));
    expect(recalledPayload.data.learningRecall.items.some((item: any) =>
      String(item.memoryId).includes(workspaceMemoryId))).toBe(false);
    const recalledItem = recalledPayload.data.learningRecall.items.find((item: any) =>
      String(item.memoryId).includes(memoryId));
    expect(recalledItem).toBeTruthy();

    const routineFollowup = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'search',
      query: 'continue inspecting the already chosen Local System route',
      include_learning_recall: false,
      max_files: 2,
      max_snippets: 2,
    });
    expect(routineFollowup?.isError).not.toBe(true);
    const routineFollowupPayload = routineFollowup?.structuredContent as Record<string, any>;
    expect(routineFollowupPayload.data.learningRecall).toBeUndefined();

    const feedback = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_feedback',
      learning_feedback: [{
        memory_address: recalledItem.memoryId,
        decision: 'used',
        reason: 'This routing memory directly selected the successful Local System capability.',
      }],
    });
    expect(feedback?.isError).not.toBe(true);
    const feedbackPayload = feedback?.structuredContent as Record<string, any>;
    expect(feedbackPayload.data.observationIds).toHaveLength(1);

    const audit = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'search',
      knowledge_memory_id: memoryId,
      knowledge_limit: 4,
    });
    expect(audit?.isError).not.toBe(true);
    const auditPayload = audit?.structuredContent as Record<string, any>;
    expect(auditPayload.data.cognitionAudit.items[0].recentUsage.usedCount).toBe(1);

    const duplicateFeedback = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_feedback',
      learning_feedback: [{
        memory_address: recalledItem.memoryId,
        decision: 'used',
        reason: 'This routing memory directly selected the successful Local System capability.',
      }],
    });
    expect(duplicateFeedback?.isError).not.toBe(true);
    const duplicateAudit = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'search',
      knowledge_memory_id: memoryId,
      knowledge_limit: 4,
    });
    const duplicateAuditPayload = duplicateAudit?.structuredContent as Record<string, any>;
    expect(duplicateAuditPayload.data.cognitionAudit.items[0].recentUsage.usedCount).toBe(1);
  });

  test('associates and consolidates related direct learning without inventing a ControllerRound', async () => {
    const fx = fixture('direct-learning-association', { knowledge: false });
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      explicitRepository: fx.repository,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'chatgpt-direct-learning',
      sessionId: 'session-direct-learning-association',
      controllerInstanceId: 'instance-direct-learning',
      controllerType: 'chatgpt' as const,
      policy: getMcpPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'core',
      toolsetLocked: true,
    } as unknown as MultiRepositoryMcpToolContext;

    const learning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      learning_signals: [
        {
          scope_kind: 'project',
          kind: 'principle',
          valence: 'positive',
          summary: 'Generic model learning should use Cognitive memory without requiring Work lifecycle authority.',
          concepts: ['cognition.learning', 'thin-forge', 'lifecycle-decoupling'],
          facets: ['architecture', 'learning'],
          admission_source: 'explicit_human',
          portability: 'local',
          salience: 0.9,
          confidence: 0.9,
          utility: 0.9,
        },
        {
          scope_kind: 'project',
          kind: 'principle',
          valence: 'positive',
          summary: 'Advisory memory provenance should remain independent from ControllerRound unless the learning actually came from a Work round.',
          concepts: ['cognition.learning', 'thin-forge', 'lifecycle-decoupling'],
          facets: ['architecture', 'learning'],
          admission_source: 'explicit_human',
          portability: 'local',
          salience: 0.9,
          confidence: 0.9,
          utility: 0.9,
        },
      ],
    });
    expect(learning?.isError).not.toBe(true);
    const payload = learning?.structuredContent as Record<string, any>;
    expect(payload.data.storedMemoryIds).toHaveLength(2);
    expect(payload.data.associatedEdgeCount).toBeGreaterThan(0);
    expect(payload.data.consolidatedMemoryIds.length).toBeGreaterThan(0);

    const fullEnvelope = parseControllerLearningSignalDrafts(Array.from({ length: 32 }, (_, index) => ({
      scope_kind: 'project', kind: `distilled-${index}`, valence: 'neutral',
      summary: `Reusable model-authored knowledge ${index}.`, concepts: [`knowledge.${index}`], facets: [],
      admission_source: 'controller_observation', portability: 'local', salience: 0.5, confidence: 0.5, utility: 0.5,
    })));
    expect(fullEnvelope).toHaveLength(32);
    expect(() => parseControllerLearningSignalDrafts([...Array.from({ length: 32 }, (_, index) => ({
      scope_kind: 'project', kind: `distilled-${index}`, valence: 'neutral',
      summary: `Reusable model-authored knowledge ${index}.`, concepts: [`knowledge.${index}`], facets: [],
      admission_source: 'controller_observation', portability: 'local', salience: 0.5, confidence: 0.5, utility: 0.5,
    })), {
      scope_kind: 'project', kind: 'overflow', valence: 'neutral', summary: 'Transport overflow only.', concepts: ['overflow'], facets: [],
      admission_source: 'controller_observation', portability: 'local', salience: 0.5, confidence: 0.5, utility: 0.5,
    }])).toThrow('COGNITION_CONTROLLER_LEARNING_SIGNALS_INVALID');

    const stored = cognitionReadPort(fx.controllerHome).readByIds(
      [{ schemaVersion: 1, kind: 'project', id: 'project-learning-loop' }],
      payload.data.storedMemoryIds,
    );
    expect(stored).toHaveLength(2);
    expect(stored.every(memory => !memory.provenance.sourceWorkId && !memory.provenance.sourceRoundId)).toBe(true);
  });

  test('rejects unavailable direct-learning evidence before writing any memory', async () => {
    const fx = fixture('direct-learning-evidence', { knowledge: false });
    const ctx = {
      controllerHome: fx.controllerHome,
      repoRoot: fx.repoRoot,
      explicitRepository: fx.repository,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      principalId: 'chatgpt-direct-learning',
      sessionId: 'session-direct-learning',
      controllerInstanceId: 'instance-direct-learning',
      controllerType: 'chatgpt' as const,
      policy: getMcpPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'core',
      toolsetLocked: true,
    } as unknown as MultiRepositoryMcpToolContext;

    const learning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      learning_signals: [{
        scope_kind: 'project',
        kind: 'procedure',
        valence: 'neutral',
        summary: 'This candidate must not persist because its claimed evidence does not exist.',
        concepts: ['missing-evidence'],
        admission_source: 'controller_observation',
        portability: 'local',
        salience: 0.5,
        confidence: 0.5,
        utility: 0.5,
        evidence_refs: ['PLG-OBS-missing'],
      }],
    });
    expect(learning?.isError).toBe(true);
    const payload = learning?.structuredContent as Record<string, any>;
    expect(payload.summary).toContain('COGNITION_DIRECT_LEARNING_EVIDENCE_UNAVAILABLE');
  });
});
