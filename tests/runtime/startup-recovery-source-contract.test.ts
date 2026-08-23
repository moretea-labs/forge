import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('startup recovery source contract', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/runtime/control-plane/startup-recovery.ts'), 'utf8');

  test('Managed Process recovery is a visible repository recovery phase', () => {
    expect(source).toContain("phase: 'registry' | 'processes'");
    expect(source).toContain("result.processes = run('processes', () => recoverManagedProcesses(controllerHome, repository.repoId));");
    expect(source).not.toContain('/* per-repo best-effort */');
    expect(source).not.toContain('/* process runtime optional in early fixtures */');
  });

  test('startup projection recovery is unconditional rather than dirty-marker gated', () => {
    expect(source).toContain("result.projectionRebuilt = run('projection', () => {");
    expect(source).toContain('rebuildRepositoryProjection(controllerHome, repository.repoId);');
    expect(source).not.toContain('projectionNeedsRebuild');
    expect(source).not.toContain('readRepositoryProjectionDirty');
  });
});
