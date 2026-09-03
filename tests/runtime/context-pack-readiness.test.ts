import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildControllerContextPack } from '../../src/cli/controller/context-pack';
import { getMcpPolicy } from '../../src/cli/mcp/policy';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test('does not treat exact-known lexical hit caps as omitted evidence when the file is fully materialized', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-exact-known-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  const lines = Array.from({ length: 80 }, (_, index) => `export const ENTRY_MARKER_${index} = 'ENTRY_MARKER';`);
  writeFileSync(join(root, 'src/exact.ts'), `${lines.join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect ENTRY_MARKER in the exact known implementation file.',
    searchTerms: ['ENTRY_MARKER'],
    knownPaths: ['src/exact.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 4,
  });

  expect(pack.search.truncated).toBe(true);
  expect(pack.search.evidenceTruncated).toBe(false);
  expect(pack.coverage.exactKnownPaths).toEqual({ requested: ['src/exact.ts'], materialized: ['src/exact.ts'], missing: [] });
  expect(pack.coverage.materialization.completeFiles).toBeGreaterThan(0);
  expect(pack.readiness.retrieval).toMatchObject({ searchTruncated: false, omittedCandidateCount: 0, policyDeniedCandidateCount: 0, likelyRelatedNotInspectedCount: 0 });
  expect(pack.readiness.unresolvedReasonCodes).not.toContain('retrieval_truncated');
  expect(pack.readiness.status).toBe('ready');
  expect(pack.readiness.readyForHighConfidenceMutation).toBe(true);
});
