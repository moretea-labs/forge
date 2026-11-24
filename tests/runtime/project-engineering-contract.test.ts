import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProjectEngineeringContract } from '../../src/runtime/context/project-engineering-contract';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ProjectEngineeringContract', () => {
  test('loads one bounded source-controlled project contract and emits an exact revision digest receipt', () => {
    const root = temp('project-engineering-contract-');
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge', 'project-engineering.json'),
      JSON.stringify(
        {
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
          exceptions: [
            { id: 'legacy-db', scope: 'storage/v1', rationale: 'Migration remains intentionally compatible.' },
          ],
        },
        null,
        2,
      ),
    );
    const loaded = loadProjectEngineeringContract({
      repoRoot: root,
      sourceRevision: 'revision-a',
      now: () => '2026-09-03T00:00:00.000Z',
    });
    expect(loaded.status).toBe('ready');
    if (loaded.status !== 'ready') throw new Error('fixture contract missing');
    expect(loaded.contract).toMatchObject({ projectId: 'project-a', skillRefs: ['ios-engineering'] });
    expect(loaded.receipt).toMatchObject({
      sourceRevision: 'revision-a',
      contractPath: '.forge/project-engineering.json',
      projectId: 'project-a',
    });
    expect(loaded.receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
