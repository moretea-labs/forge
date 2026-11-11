import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WorkflowPublicationReceipt } from '../../packages/workflow-runtime/api/index';
import { memoryAddressKey } from '../../packages/kernel/cognition/api/index';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { getToolPolicy } from '../../src/cli/controller/tool-policy';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { writeWorkflowRunCheckpoint } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { schedulePublicationOutcomeCollection } from '../../src/runtime/root/assistant-learning-loop';
import { parseControllerLearningSignalDrafts } from '../../src/runtime/context/automatic-learning';
import { cognitionReadPort } from '../../src/runtime/control-plane/persistence/cognition-store';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { writeProjectIdentity, writeProjectPlacement, writeWorkspaceIdentity } from '../../src/runtime/control-plane/workspace/workspace-store';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { settleCognitionAfterTool } from '../../adapters/mcp/runtime-gateway/cognition-settlement';
import { seedHistoricalWorkContract } from '../helpers/historical-work-contract';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Context composition reads wall time; anchor the scenario once so retained
// 30-day experiences do not expire merely because the calendar advances.
const scenarioStartedAt = Date.now();
function time(minute: number): string {
  return new Date(scenarioStartedAt + minute * 60_000).toISOString();
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
  seedHistoricalWorkContract(store, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-learning-loop' },
    objective: '小红书 推广 真实指标 经验 下一轮使用，并根据执行证据持续改进。',
    acceptanceCriteria: ['Two learning loops close on durable evidence.'],
    constraints: { workspaceMode: 'current' },
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    dispatchState: 'running',
  });
  return {
    controllerHome, repoRoot, repository, store, workId, workspaceId, forgeInstanceId: instance.instanceId,
    setNow(value: string) { now = value; },
  };
}

type Fx = ReturnType<typeof fixture>;

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
      policy: getToolPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'full',
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
      scopePolicy: 'unified_relevance_with_narrow_scope_prior',
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
      String(item.memoryId).includes(workspaceMemoryId))).toBe(true);
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

    // Normal recall must expose real usage feedback alongside provenance;
    // a high lexical score must not hide that a memory was rejected or stale.
    const refreshedRecall = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'search',
      query: 'Local System capability',
      max_files: 2,
      max_snippets: 2,
    });
    const refreshedItem = (refreshedRecall?.structuredContent as Record<string, any>)
      .data.learningRecall.items.find((item: any) => String(item.memoryId).includes(memoryId));
    expect(refreshedItem?.recentUsage?.usedCount).toBe(1);
    expect(refreshedItem?.provenance?.sourceKind).toBe('controller');

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
      policy: getToolPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'full',
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
          concepts: ['forge.cognition', 'cognition.learning', 'thin-forge', 'lifecycle-decoupling'],
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
          concepts: ['forge.cognition', 'cognition.learning', 'thin-forge', 'lifecycle-decoupling'],
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
    expect(stored.every(memory => memory.provenance.sourceKind === 'controller')).toBe(true);

    const ordinaryArgs = {
      repo_id: fx.repository.repoId,
      cognition_settlement: {
        learning_signals: [{
          scope_kind: 'project', kind: 'principle', valence: 'positive',
          summary: 'Ordinary task outcomes settle reusable learning through the shared MCP envelope.',
          concepts: ['forge.cognition', 'ordinary-project'], facets: ['architecture'],
          admission_source: 'controller_observation', portability: 'local', salience: 0.9, confidence: 0.9, utility: 0.9,
        }],
      },
    };
    const ordinaryOutcome = settleCognitionAfterTool(ctx, 'repository_git_status', ordinaryArgs, {
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
    });
    expect((ordinaryOutcome?.structuredContent as Record<string, any>).cognitionSettlement).toMatchObject({
      recorded: true,
      storedMemoryIds: [expect.any(String)],
    });

    const legacyWorkLearning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      work_id: fx.workId,
      learning_signals: [{
        scope_kind: 'project', kind: 'legacy-work-router', valence: 'neutral',
        summary: 'A legacy Work identifier must not route lifecycle-free learning.',
        concepts: ['legacy.work.router'], facets: [], admission_source: 'controller_observation',
        portability: 'local', salience: 0.5, confidence: 0.5, utility: 0.5,
      }],
    });
    expect(legacyWorkLearning?.isError).toBe(true);
    expect((legacyWorkLearning?.structuredContent as Record<string, any>).summary).toContain('COGNITION_WORK_SCOPE_RETIRED');

    const primarySuccessWithSettlementFailure = settleCognitionAfterTool(ctx, 'repository_git_status', {
      repo_id: fx.repository.repoId,
      cognition_settlement: {
        learning_signals: [{
          scope_kind: 'work', kind: 'invalid-without-work', valence: 'neutral',
          summary: 'This intentionally unreachable scope exercises non-blocking settlement failure.',
          concepts: ['settlement.failure'], facets: [],
          admission_source: 'controller_observation', portability: 'local', salience: 0.5, confidence: 0.5, utility: 0.5,
        }],
      },
    }, {
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
    });
    expect(primarySuccessWithSettlementFailure?.isError).not.toBe(true);
    expect(primarySuccessWithSettlementFailure?.structuredContent).toMatchObject({
      ok: true,
      cognitionSettlement: { recorded: false, error: { code: 'COGNITION_CONTROLLER_LEARNING_SCOPE_INVALID' } },
      warnings: [expect.stringContaining('COGNITION_SETTLEMENT_FAILED')],
    });

    const naturalRecall = await callRuntimeTool(ctx, 'rh_context', {
      repo_id: fx.repository.repoId,
      operation: 'list',
      query: 'forge cognition',
    });
    expect(naturalRecall?.isError).not.toBe(true);
    const naturalPayload = naturalRecall?.structuredContent as Record<string, any>;
    expect(naturalPayload.data.learningRecall.items.some((item: any) => item.concepts.includes('forge.cognition'))).toBe(true);

    const requirementId = 'REQ-direct-learning-reachable';
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Reachable requirement learning',
      outcomeStatement: 'Explicit Requirement identity makes its advisory learning scope reachable without Work.',
    });
    const requirementLearning = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_record',
      requirement_id: requirementId,
      learning_signals: [{
        scope_kind: 'requirement', kind: 'product-model', valence: 'positive',
        summary: 'Requirement learning remains advisory and uses the explicit Requirement authority directly.',
        concepts: ['requirement.reachable'], facets: ['product'], admission_source: 'controller_observation',
        portability: 'local', salience: 0.8, confidence: 0.8, utility: 0.8,
      }],
    });
    expect(requirementLearning?.isError).not.toBe(true);
    const requirementMemories = cognitionReadPort(fx.controllerHome).exactByConcept(
      [{ schemaVersion: 1, kind: 'requirement', id: requirementId }], ['requirement.reachable'], 4,
    );
    expect(requirementMemories[0]?.provenance.sourceKind).toBe('controller');
    const requirementFeedback = await callRuntimeTool(ctx, 'rh_work', {
      repo_id: fx.repository.repoId,
      operation: 'learning_feedback',
      requirement_id: requirementId,
      learning_feedback: [{
        memory_address: memoryAddressKey({ scope: requirementMemories[0]!.scope, id: requirementMemories[0]!.id }),
        decision: 'used',
        reason: 'The Requirement-scoped memory directly informed the subsequent requirement decision.',
      }],
    });
    expect(requirementFeedback?.isError).not.toBe(true);
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
      policy: getToolPolicy('controller', { repoRoot: fx.repoRoot }),
      toolset: 'full',
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
