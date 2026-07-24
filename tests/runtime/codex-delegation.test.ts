import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexContextPack,
  delegateToCodexCerebellum,
} from '../../src/runtime/control-plane/facade/codex-delegation';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-codex-deleg-'));
  roots.push(root);
  const workStore = { root: join(root, 'work') };
  const handoffStore = { root: join(root, 'handoff') };
  const work = createWorkContract(workStore, {
    workId: 'work_codex_1',
    repoId: 'repo_test',
    mode: 'goal_workloop',
    objective: 'Implement bounded facade workloop',
    acceptanceCriteria: ['typecheck passes'],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: ['src/runtime/control-plane/facade/**'],
    forbiddenPaths: ['.env'],
    checks: ['package:check:type'],
    driver: { preferred: 'external_controller', allowWorker: false, allowDirectEdit: false },
    worktreePolicy: { required: true },
    evidencePolicy: { defaultDetailLevel: 'summary', allowRawOptIn: true, maxEvidenceRefs: 20 },
    approvalPolicy: { required: false, reasons: [], confirmed: false },
    recoveryPolicy: { allowSelfHealing: false, maxInfrastructureRetries: 0, handoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
  });
  return {
    work,
    workStore,
    handoffStore,
    ctx: {
      repoId: 'repo_test',
      workStore,
      handoffStore,
    },
  };
}

describe('codex cerebellum delegation', () => {
  test('builds bounded context pack without secrets or finalize rights', () => {
    const pack = buildCodexContextPack({
      repoId: 'repo_test',
      workId: 'work_1',
      objective: 'Patch facade routing',
      acceptanceCriteria: ['tests pass'],
      allowedPaths: ['src/runtime/**'],
      forbiddenPaths: ['_ops/secrets'],
      relevantFilesSummary: ['src/runtime/control-plane/facade/types.ts'],
    });
    expect(pack.expectedOutputFormat.mustProduce).toContain('evidence_artifact');
    expect(pack.expectedOutputFormat.mustNot).toContain('finalize_work_contract');
    expect(pack.forbiddenPaths).toContain('_ops/secrets');
    expect(pack.target).toBe('codex');
  });

  test('delegate is deprecated and read-only for grok', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      target: 'grok',
    });
    expect(result.status).toBe('blocked');
    expect(result.status).toBe('blocked');
    expect((result.data as { target: string; deprecated: boolean; canFinalize: boolean }).target).toBe('grok');
    expect((result.data as { deprecated: boolean }).deprecated).toBe(true);
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(0);
    expect(getWorkContract(ctx.workStore, work.workId)?.status).toBe('open');
  });

  test('delegate ignores availability and does not mutate work', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: false,
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { deprecated: boolean }).deprecated).toBe(true);
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(0);
    expect(getWorkContract(ctx.workStore, work.workId)?.status).toBe('open');
  });

  test('delegate ignores worker output and cannot finalize', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: true,
      workerOutput: {
        uncertain: true,
        summary: 'Possible two valid approaches',
        patchProposal: 'optional patch A or B',
        evidenceSummary: 'Worker left an ambiguous recommendation',
      },
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { canFinalize: boolean; workerOutputIgnored: boolean }).canFinalize).toBe(false);
    expect((result.data as { workerOutputIgnored: boolean }).workerOutputIgnored).toBe(true);
    expect(getWorkContract(ctx.workStore, work.workId)?.status).toBe('open');
    expect(listHandoffItems(ctx.handoffStore).length).toBe(0);
  });

  test('delegate keeps successful-looking output outside the Kernel', () => {
    const { ctx, work } = fixture();
    const result = delegateToCodexCerebellum(ctx, {
      workId: work.workId,
      objective: work.objective,
      codexAvailable: true,
      workerOutput: {
        summary: 'Patch ready for review',
        patchProposal: 'diff --git a/src/foo.ts',
        evidenceSummary: 'Bounded patch proposal',
      },
    });

    expect(result.status).toBe('blocked');
    expect((result.data as { canFinalize: boolean }).canFinalize).toBe(false);
    expect((result.data as { workerOutputIgnored: boolean }).workerOutputIgnored).toBe(true);
    expect(result.suggestedNextActions.map((action) => action.operation)).toEqual(['controller_claim', 'launcher_start']);
    expect(getWorkContract(ctx.workStore, work.workId)?.workerRef).toBeUndefined();
    expect(listHandoffItems(ctx.handoffStore).length).toBe(0);
  });
});
