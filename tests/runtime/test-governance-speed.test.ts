import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTestManifest,
  selectTests,
  testInputDigest,
  testInputPaths,
  workspaceMutationDigest,
} from '../../src/testing/test-governance';
import { gateDefinitionDigest, stepsFor } from '../../scripts/run-governed-gate';

const ROOT = join(import.meta.dir, '../..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function temporaryRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'forge-test-input-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'tests@example.com');
  git(repo, 'config', 'user.name', 'Tests');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'tsconfig.json'), '{}\n');
  writeFileSync(join(repo, 'tests/test-manifest.v1.json'), '{}\n');
  writeFileSync(join(repo, 'tests/sample.test.ts'), "import { value } from '../src/value';\nexpect(value).toBe(1);\n");
  writeFileSync(join(repo, 'src/value.ts'), "export { nested as value } from './nested';\n");
  writeFileSync(join(repo, 'src/nested.ts'), 'export const nested = 1;\n');
  writeFileSync(join(repo, 'src/unrelated.ts'), 'export const unrelated = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  return repo;
}

describe('execution-speed test governance', () => {
  test('ignores hidden and ephemeral test artifacts without broadening affected selection', () => {
    const manifest = loadTestManifest(ROOT);
    const selection = selectTests(manifest, 'affected', [
      'tests/runtime/.desktop-rollout-search.txt',
      'tests/runtime/debug.log',
    ]);
    expect(selection.changedPaths).toEqual([]);
    expect(selection.reason).toContain('core smoke');
    expect(selection.files.every((file) => manifest.tests[file]?.smoke)).toBe(true);
  });

  test('keys a test to recursive local inputs instead of unrelated repository content', () => {
    const repo = temporaryRepository();
    try {
      const inputs = testInputPaths(repo, 'tests/sample.test.ts');
      expect(inputs).toContain('src/value.ts');
      expect(inputs).toContain('src/nested.ts');
      expect(inputs).not.toContain('src/unrelated.ts');
      const initial = testInputDigest(repo, 'tests/sample.test.ts');
      writeFileSync(join(repo, 'src/unrelated.ts'), 'export const unrelated = 2;\n');
      expect(testInputDigest(repo, 'tests/sample.test.ts')).toBe(initial);
      writeFileSync(join(repo, 'src/nested.ts'), 'export const nested = 2;\n');
      expect(testInputDigest(repo, 'tests/sample.test.ts')).not.toBe(initial);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('detects candidate pollution from actual deltas without hashing the clean tracked tree', () => {
    const repo = temporaryRepository();
    try {
      const clean = workspaceMutationDigest(repo);
      git(repo, 'commit', '--allow-empty', '-qm', 'identity-only');
      expect(workspaceMutationDigest(repo)).toBe(clean);
      writeFileSync(join(repo, 'src/nested.ts'), 'export const nested = 3;\n');
      expect(workspaceMutationDigest(repo)).not.toBe(clean);
      const dirty = workspaceMutationDigest(repo);
      writeFileSync(join(repo, 'src/nested.ts'), 'export const nested = 4;\n');
      expect(workspaceMutationDigest(repo)).not.toBe(dirty);
      writeFileSync(join(repo, 'untracked.ts'), 'new\n');
      expect(workspaceMutationDigest(repo)).not.toBe(dirty);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('models task, main, and release as one reusable nested gate DAG', () => {
    expect(stepsFor('task').some((step) => !('gate' in step) && step.label === 'controller UI bundle')).toBe(true);
    expect(stepsFor('main').some((step) => 'gate' in step && step.gate === 'task')).toBe(true);
    expect(stepsFor('release').some((step) => 'gate' in step && step.gate === 'main')).toBe(true);
    expect(gateDefinitionDigest('release')).not.toBe(gateDefinitionDigest('main'));
  });
});
