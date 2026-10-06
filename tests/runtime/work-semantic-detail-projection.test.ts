import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendVerificationRecord,
  appendWorkEvidence,
  createWorkSemanticContext,
  updateWorkContract,
} from '../../packages/kernel/work/api/index';
import { SEMANTIC_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { callRhWorkSemanticOperation } from '../../adapters/mcp/runtime-gateway/work-semantic-operations';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('rh_work get detail projects bounded canonical Work execution evidence without changing semantic state', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-semantic-detail-'));
  roots.push(controllerHome);
  const store = { controllerHome, scopeKey: SEMANTIC_SCOPE_KEY };
  const workId = 'work-semantic-detail-projection';

  createWorkSemanticContext(store, {
    workId,
    objective: 'Project canonical execution evidence into a read-only client view.',
    requestedBy: 'chatgpt',
  });
  updateWorkContract(store, workId, {
    checks: ['check:desktop'],
  });
  appendVerificationRecord(store, workId, {
    checkId: 'check:desktop',
    outcome: 'valid_pass',
    summary: 'Desktop check passed.',
    recordedAt: '2026-10-06T04:00:00.000Z',
    sourceRevision: 'abc123',
    evidenceRef: {
      title: 'verification:valid_pass',
      summary: 'Desktop check passed.',
      detailLevel: 'summary',
    },
  });
  appendWorkEvidence(store, workId, {
    title: 'desktop-build',
    summary: 'Production build completed.',
    detailLevel: 'summary',
  });

  const response = await callRhWorkSemanticOperation(store, 'get', {
    work_id: workId,
    detail_level: 'detail',
  });
  const payload = response?.structuredContent as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  const work = data.work as Record<string, unknown>;
  const executionEvidence = data.executionEvidence as Record<string, unknown>;
  const verifications = executionEvidence.verifications as Array<Record<string, unknown>>;

  expect(work).toMatchObject({ workId, state: 'open' });
  expect(executionEvidence).toMatchObject({
    dispatchState: 'not_dispatched',
    evidenceState: 'none',
    phase: 'implementation',
    workKind: 'investigation',
    checks: ['check:desktop'],
  });
  expect(verifications).toHaveLength(1);
  expect(verifications[0]).toMatchObject({
    checkId: 'check:desktop',
    outcome: 'valid_pass',
    sourceRevision: 'abc123',
  });
  expect(executionEvidence.evidenceRefs).toEqual([
    { title: 'desktop-build', summary: 'Production build completed.', detailLevel: 'summary' },
  ]);
  expect(JSON.stringify(executionEvidence)).not.toContain('artifactPath');
});
