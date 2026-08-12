import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { controlPlaneDatabasePath, listControlPlaneRecords } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { getCandidateFinding, listCandidateFindings, recordCandidateFinding } from '../../src/runtime/workflow/findings/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-findings-'));
  roots.push(controllerHome);
  return { controllerHome, repoId: 'repo_forge' };
}

describe('Candidate Finding SQLite authority', () => {
  test('deduplicates semantic observations in the control-plane record without JSON projections', () => {
    const fx = fixture();
    const first = recordCandidateFinding(fx.controllerHome, {
      repoId: fx.repoId,
      semanticKey: 'perf.process-fixed-overhead',
      title: 'Process fixed overhead',
      requirementId: 'REQ-EXECUTION-SPEED',
      kind: 'performance',
      sourceRepoId: 'repo_consumer',
      evidence: { source: 'benchmark', reference: 'run-1' },
      requestId: 'finding-1',
    });
    const second = recordCandidateFinding(fx.controllerHome, {
      repoId: fx.repoId,
      semanticKey: 'perf.process-fixed-overhead',
      title: 'Process fixed overhead',
      evidence: { source: 'benchmark', reference: 'run-2' },
      requestId: 'finding-2',
    });
    expect(second.findingId).toBe(first.findingId);
    expect(second.observationCount).toBe(2);
    expect(second.evidence).toHaveLength(2);
    expect(second).toMatchObject({ requirementId: 'REQ-EXECUTION-SPEED', kind: 'performance', sourceRepoId: 'repo_consumer' });
    expect(listControlPlaneRecords(fx.controllerHome, { namespace: 'candidate_finding', scope: fx.repoId })).toHaveLength(1);
    expect(listCandidateFindings(fx.controllerHome, fx.repoId)).toEqual([second]);
    expect(controlPlaneDatabasePath(fx.controllerHome)).toContain('control-plane.sqlite');
  });

  test('imports a legacy JSON record once then reads SQLite as authority', () => {
    const fx = fixture();
    const legacy = {
      schemaVersion: 1, revision: 1, findingId: 'FIND-legacy', repoId: fx.repoId,
      semanticKey: 'runtime.process-wait-transport-budget', title: 'Legacy wait mismatch', severity: 'high', status: 'candidate',
      observationCount: 1, evidence: [], firstSeenAt: '2026-08-12T00:00:00.000Z', lastSeenAt: '2026-08-12T00:00:00.000Z',
    };
    const records = join(fx.controllerHome, 'repositories', fx.repoId, 'candidate-findings', 'records');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'FIND-legacy.json'), JSON.stringify(legacy));
    expect(getCandidateFinding(fx.controllerHome, fx.repoId, 'FIND-legacy')).toMatchObject(legacy);
    expect(listControlPlaneRecords(fx.controllerHome, { namespace: 'candidate_finding', scope: fx.repoId })).toHaveLength(1);
    expect(getCandidateFinding(fx.controllerHome, fx.repoId, 'FIND-legacy')).toMatchObject(legacy);
  });
});
