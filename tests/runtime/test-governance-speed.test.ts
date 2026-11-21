import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTestManifest,
  selectTests,
  testContentDigest,
  testInputDigest,
  testInputPaths,
  workspaceMutationDigest,
} from '../../src/testing/test-governance';
import { gateDefinitionDigest, stepsFor } from '../../scripts/run-governed-gate';
import {
  committedSourceCandidate,
  materializeCommittedSourceCandidate,
  materializeCommittedTypeScriptCandidate,
} from '../../src/testing/source-quality-candidate';

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

  test('candidate cache identity is based on final content, not intermediate Git mutation events', () => {
    const repo = temporaryRepository();
    try {
      const initial = testContentDigest(repo);
      writeFileSync(join(repo, 'src/unrelated.ts'), 'export const unrelated = 2;\n');
      expect(testContentDigest(repo)).not.toBe(initial);
      writeFileSync(join(repo, 'src/unrelated.ts'), 'export const unrelated = 1;\n');
      expect(testContentDigest(repo)).toBe(initial);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('governed gate does not rescan whole Git delta after each step, but checks final candidate before caching', () => {
    const source = readFileSync(join(ROOT, 'scripts/run-governed-gate.ts'), 'utf8');
    expect(source).not.toContain('workspaceMutationDigest');
    expect(source).toContain('if (testContentDigest(ROOT) !== contentDigest)');
    expect(source.indexOf('if (testContentDigest(ROOT) !== contentDigest)')).toBeLessThan(
      source.indexOf('atomicJson(cachePath, {'),
    );
  });

  test('checks committed blobs despite concurrent dirty files, but rejects committed bad formatting', () => {
    const repo = temporaryRepository();
    let snapshot: string | undefined;
    try {
      writeFileSync(join(repo, 'biome.json'), JSON.stringify({ formatter: { lineWidth: 120 } }) + '\n');
      git(repo, 'add', 'biome.json');
      git(repo, 'commit', '-qm', 'pin source quality config');
      const base = git(repo, 'rev-parse', 'HEAD');

      writeFileSync(join(repo, 'src/unrelated.ts'), 'export const unrelated = 2;\n');
      git(repo, 'add', 'src/unrelated.ts');
      git(repo, 'commit', '-qm', 'valid candidate');
      const candidate = committedSourceCandidate(repo, base);
      expect(candidate.paths).toEqual(['src/unrelated.ts']);

      writeFileSync(join(repo, 'src/unrelated.ts'), 'export  const unrelated=3;\n');
      writeFileSync(join(repo, 'src/other.ts'), 'export  const other=1;\n');
      expect(committedSourceCandidate(repo, base)).toEqual(candidate);
      snapshot = materializeCommittedSourceCandidate(repo, candidate.revision, candidate.paths);
      expect(readFileSync(join(snapshot, 'src/unrelated.ts'), 'utf8')).toBe('export const unrelated = 2;\n');
      expect(existsSync(join(snapshot, 'src/other.ts'))).toBe(false);
      expect(existsSync(join(snapshot, '.git'))).toBe(false);
      expect(
        spawnSync(join(ROOT, 'node_modules/.bin/biome'), ['ci', '--vcs-enabled=false', 'src/unrelated.ts'], {
          cwd: snapshot,
          stdio: 'pipe',
        }).status,
      ).toBe(0);
      rmSync(snapshot, { recursive: true, force: true });
      snapshot = undefined;

      git(repo, 'add', 'src/unrelated.ts');
      git(repo, 'commit', '-qm', 'bad candidate');
      const bad = committedSourceCandidate(repo, base);
      snapshot = materializeCommittedSourceCandidate(repo, bad.revision, bad.paths);
      expect(
        spawnSync(join(ROOT, 'node_modules/.bin/biome'), ['ci', '--vcs-enabled=false', 'src/unrelated.ts'], {
          cwd: snapshot,
          stdio: 'pipe',
        }).status,
      ).not.toBe(0);
      expect(() => committedSourceCandidate(repo, 'unknown-base-ref')).toThrow();
    } finally {
      if (snapshot) rmSync(snapshot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('pinned TypeScript candidate ignores unrelated Writer dirty and rejects committed type errors', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-committed-type-test-'));
    let snapshot: string | undefined;
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'tests@example.com');
      git(repo, 'config', 'user.name', 'Tests');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(
        join(repo, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [] },
          include: ['src/*.ts'],
        }),
      );
      writeFileSync(join(repo, 'src/value.ts'), 'export const value: number = 1;\n');
      git(repo, 'add', 'tsconfig.json', 'src/value.ts');
      git(repo, 'commit', '-qm', 'good TypeScript candidate');
      symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');

      // Uncommitted tracked and untracked TypeScript errors must not corrupt the
      // verified committed source. No Git worktree or branch is created.
      writeFileSync(join(repo, 'src/value.ts'), 'export const value: number = "wrong";\n');
      writeFileSync(join(repo, 'src/untracked.ts'), 'export const extra: number = "wrong";\n');
      snapshot = materializeCommittedTypeScriptCandidate(repo, 'HEAD');
      expect(existsSync(join(snapshot, '.git'))).toBe(false);
      expect(existsSync(join(snapshot, 'src/untracked.ts'))).toBe(false);
      expect(readFileSync(join(snapshot, 'src/value.ts'), 'utf8')).toBe('export const value: number = 1;\n');
      expect(
        spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit'], { cwd: snapshot, stdio: 'pipe' }).status,
      ).toBe(0);
      rmSync(snapshot, { recursive: true, force: true });
      snapshot = undefined;

      git(repo, 'add', 'src/value.ts');
      git(repo, 'commit', '-qm', 'bad TypeScript candidate');
      snapshot = materializeCommittedTypeScriptCandidate(repo, 'HEAD');
      expect(
        spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit'], { cwd: snapshot, stdio: 'pipe' }).status,
      ).not.toBe(0);
      expect(() => materializeCommittedTypeScriptCandidate(repo, 'not-a-git-ref')).toThrow();
    } finally {
      if (snapshot) rmSync(snapshot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('models task, main, and release as one reusable nested gate DAG', () => {
    expect(stepsFor('task')[0]).toEqual({
      label: 'typecheck',
      command: 'bun',
      args: ['scripts/check-candidate-type.ts'],
      timeoutMs: 10 * 60_000,
    });
    expect(
      stepsFor('task').some(
        (step) =>
          !('gate' in step) &&
          step.label === 'context pack readiness regression' &&
          step.command === 'bun' &&
          step.args.join(' ') === 'test tests/runtime/context-pack-readiness.test.ts',
      ),
    ).toBe(true);
    expect(stepsFor('task').some((step) => !('gate' in step) && step.label === 'affected tests')).toBe(true);
    expect(stepsFor('main').some((step) => !('gate' in step) && step.label === 'frozen MCP tool contract')).toBe(true);
    expect(stepsFor('main').some((step) => !('gate' in step) && step.label === 'quality harness benchmark')).toBe(true);
    expect(stepsFor('main')).toContainEqual({
      label: 'Recovery rollback and known-good authority',
      command: 'bun',
      args: [
        'test',
        'tests/runtime/standalone-recovery.test.ts',
        '--test-name-pattern',
        'restores only the attested previous whole-Runtime release while Runtime is stopped|independent CPU rejection does not own ReleaseSession rollback or known-good|long soak and absent Supervisor proof do not veto mechanical known-good',
      ],
      timeoutMs: 5 * 60_000,
    });
    expect(stepsFor('main').some((step) => 'gate' in step && step.gate === 'task')).toBe(true);
    expect(stepsFor('release').some((step) => 'gate' in step && step.gate === 'main')).toBe(true);
    expect(gateDefinitionDigest('release')).not.toBe(gateDefinitionDigest('main'));
  });
});
