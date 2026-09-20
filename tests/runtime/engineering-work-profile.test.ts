import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildEngineeringContextReceipt,
  engineeringWorkProfileForRisk,
  evaluateEngineeringAdmission,
} from '../../packages/kernel/work/domain/engineering-profile';
import { assertImplementationReviewPreDeliveryBoundary, evaluateImplementationReviewGate, workRequiresImplementationReview } from '../../packages/kernel/work/domain/implementation-review';
import { loadProjectEngineeringContract } from '../../src/runtime/context/project-engineering-contract';
import { trustedEngineeringEvidence } from '../helpers/engineering-evidence';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function highEvidence(sourceRevision = 'revision-a') {
  return trustedEngineeringEvidence(sourceRevision);
}

describe('EngineeringWorkProfile and ProjectEngineeringContract', () => {
  test('keeps low risk lightweight while making high and critical admission evidence explicit', () => {
    expect(engineeringWorkProfileForRisk('low')).toMatchObject({ riskClass: 'low', admissionEnforcement: 'observe' });
    expect(engineeringWorkProfileForRisk('medium')).toMatchObject({ riskClass: 'normal', admissionEnforcement: 'observe' });
    expect(engineeringWorkProfileForRisk('high')).toMatchObject({ riskClass: 'high', admissionEnforcement: 'enforce' });
    expect(engineeringWorkProfileForRisk('destructive')).toMatchObject({ riskClass: 'critical', admissionEnforcement: 'enforce' });
  });

  test('skips a separate implementation review only for low-risk candidates', () => {
    expect(workRequiresImplementationReview('repository_change', ['src/index.ts'], 'low')).toBe(false);
    expect(workRequiresImplementationReview('repository_change', ['src/index.ts'], 'normal')).toBe(true);
    expect(workRequiresImplementationReview('repository_change', ['src/index.ts'], 'high')).toBe(true);
    expect(workRequiresImplementationReview('repository_change', ['src/index.ts'], 'critical')).toBe(true);
    expect(workRequiresImplementationReview('repository_change', ['src/index.ts'])).toBe(true);
    expect(workRequiresImplementationReview('local_effect', ['src/index.ts'], 'low')).toBe(true);
  });

  test('carries low engineering risk through the canonical physical review boundary', () => {
    const candidate = {
      sourceRevision: 'revision-low',
      workspaceFingerprint: 'workspace-low',
      verificationWorkspaceFingerprint: 'verification-low',
      changedPaths: ['src/index.ts'],
      verificationEvidence: [],
      architectureEvidence: [],
    };
    expect(evaluateImplementationReviewGate({ workKind: 'repository_change', riskClass: 'low', candidate })).toMatchObject({ required: false, approved: true });
    expect(evaluateImplementationReviewGate({ workKind: 'repository_change', riskClass: 'normal', candidate })).toMatchObject({ required: true, approved: false, code: 'WORK_IMPLEMENTATION_REVIEW_REQUIRED' });
    expect(() => assertImplementationReviewPreDeliveryBoundary({
      repoId: 'repo-low', workId: 'work-low', workKind: 'repository_change', riskClass: 'low', candidate,
      requiredCheckIds: [], verificationRecords: [],
    })).not.toThrow();
  });

  test('records normal evidence gaps without blocking but fails high-risk mutation closed', () => {
    const normal = buildEngineeringContextReceipt({
      risk: 'medium', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, recordedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(normal.missingAdmissionEvidence).toEqual(['project_contract', 'context_closure', 'product_dod']);
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('medium'), receipt: normal, mutation: true })).toEqual({ allowed: true });

    const high = buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, recordedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt: high, mutation: true })).toMatchObject({
      allowed: false,
      code: 'ENGINEERING_ADMISSION_EVIDENCE_REQUIRED',
      missing: ['project_contract', 'context_closure', 'product_dod', 'design_decision', 'independent_critique'],
    });

    const ready = buildEngineeringContextReceipt({
      risk: 'high', sourceIdentity: { kind: 'revision', revision: 'revision-a' }, evidence: highEvidence(), recordedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(evaluateEngineeringAdmission({ profile: engineeringWorkProfileForRisk('high'), receipt: ready, mutation: true })).toEqual({ allowed: true });
  });

  test('rejects stale project-contract evidence instead of accepting cross-revision governance', () => {
    expect(() => buildEngineeringContextReceipt({
      risk: 'high',
      sourceIdentity: { kind: 'revision', revision: 'revision-b' },
      evidence: highEvidence('revision-a'),
      recordedAt: '2026-09-03T00:00:00.000Z',
    })).toThrow('ENGINEERING_PROJECT_CONTRACT_SOURCE_DRIFT');
  });

  test('loads one bounded source-controlled project contract and emits an exact revision digest receipt', () => {
    const root = temp('project-engineering-contract-');
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(join(root, '.forge', 'project-engineering.json'), JSON.stringify({
      schemaVersion: 1,
      contractId: 'project-a-engineering',
      contractVersion: '2026-09-03',
      projectId: 'project-a',
      authority: {
        product: ['docs/product.md'],
        architecture: ['docs/architecture.md'],
        source: ['src/**'],
      },
      quality: {
        ux: ['Primary save flow stays responsive.'],
        performance: ['No new synchronous network work on the interaction path.'],
        nonRegression: ['Existing saved data remains readable.'],
      },
      checks: [{ id: 'check:type', purpose: 'Type contract' }],
      journeys: [{ id: 'journey:save', purpose: 'Save one record', requiredFor: ['high'] }],
      platforms: ['ios'],
      tooling: [{ id: 'sourcekit-lsp', requiredFor: ['high'] }],
      skillRefs: ['ios-engineering'],
      exceptions: [{ id: 'legacy-db', scope: 'storage/v1', rationale: 'Migration remains intentionally compatible.' }],
    }, null, 2));
    const loaded = loadProjectEngineeringContract({
      repoRoot: root,
      sourceRevision: 'revision-a',
      now: () => '2026-09-03T00:00:00.000Z',
    });
    expect(loaded.status).toBe('ready');
    if (loaded.status !== 'ready') throw new Error('fixture contract missing');
    expect(loaded.contract).toMatchObject({ projectId: 'project-a', skillRefs: ['ios-engineering'] });
    expect(loaded.receipt).toMatchObject({ sourceRevision: 'revision-a', contractPath: '.forge/project-engineering.json', projectId: 'project-a' });
    expect(loaded.receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
