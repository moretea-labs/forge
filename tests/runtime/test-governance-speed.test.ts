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

  test('test-runner checks mutation per child, not between unrelated test runs', () => {
    const source = readFileSync(join(ROOT, 'src/testing/test-governance.ts'), 'utf8');
    expect(source).toContain('const testWorkspaceBefore = workspaceMutationDigest(testRoot);');
    expect(source).toContain('workspaceMutationDigest(testRoot) !== testWorkspaceBefore');
    expect(source).toContain('testInputDigest(testRoot, file) !== inputDigest');
    expect(source).not.toContain('const baselineWorkspace = workspaceMutationDigest(repoRoot)');
    expect(source).not.toContain('workspaceMutationDigest(repoRoot) !== baselineWorkspace');
  });

  test('source quality uses strict Swift 6 toolchain formatter on Linux (#714)', () => {
    const source = readFileSync(join(ROOT, 'scripts/check-source-quality.mjs'), 'utf8');
    expect(source).toContain("onMac ? 'xcrun' : 'swift'");
    expect(source).toContain("onMac ? ['swift-format'] : ['format']");
    expect(source).toContain("'lint',");
    expect(source).toContain("'--strict',");
  });

  test('Rust source quality parses 2021 async in sparse candidate and rejects malformed Rust', () => {
    const script = readFileSync(join(ROOT, 'scripts/check-source-quality.mjs'), 'utf8');
    expect(script).toContain("'--edition', '2021'");
    expect(script).toContain("'--config', 'skip_children=true'");
    expect(script).toContain('const strictRustFiles = rustFiles.filter');
    expect(script).toContain("'--emit', 'stdout'");

    const dir = mkdtempSync(join(tmpdir(), 'forge-rust-source-quality-'));
    try {
      const file = join(dir, 'main.rs');
      const parseArgs = ['--edition', '2021', '--config', 'skip_children=true', '--emit', 'stdout', '--quiet', file];
      // A committed candidate can contain only the edited main.rs; old sibling
      // modules must not be required to validate its syntax.
      writeFileSync(file, 'mod not_in_candidate;\nasync fn run() { let _value = 1; }\n');
      const good = spawnSync('rustfmt', parseArgs, { encoding: 'utf8' });
      expect(good.status).toBe(0);

      writeFileSync(file, 'mod not_in_candidate;\nasync fn run( {\n');
      const bad = spawnSync('rustfmt', parseArgs, { encoding: 'utf8' });
      expect(bad.status).not.toBe(0);

      // New/other Rust source still gets the strict formatting check.
      writeFileSync(file, 'fn example(){let _value=1;}\n');
      const strict = spawnSync('rustfmt', ['--edition', '2021', '--config', 'skip_children=true', '--check', file], {
        encoding: 'utf8',
      });
      expect(strict.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('main Gate cache identity changes with actual baseline, candidate and source mode (#714)', () => {
    const keys = ['TEST_BASE_REF', 'FORGE_CHECK_CANDIDATE_SHA', 'FORGE_CHECK_SOURCE_QUALITY_MODE'] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    const head = git(ROOT, 'rev-parse', 'HEAD');
    const parent = git(ROOT, 'rev-parse', 'HEAD~1');
    try {
      for (const key of keys) delete process.env[key];
      const defaultKey = gateDefinitionDigest('main');
      process.env.TEST_BASE_REF = parent;
      const olderBase = gateDefinitionDigest('main');
      process.env.TEST_BASE_REF = head;
      const currentBase = gateDefinitionDigest('main');
      expect(olderBase).not.toBe(defaultKey);
      expect(currentBase).not.toBe(olderBase);

      process.env.FORGE_CHECK_SOURCE_QUALITY_MODE = 'committed';
      const committedMode = gateDefinitionDigest('main');
      expect(committedMode).not.toBe(currentBase);

      process.env.FORGE_CHECK_CANDIDATE_SHA = parent;
      const priorCandidate = gateDefinitionDigest('main');
      process.env.FORGE_CHECK_CANDIDATE_SHA = head;
      expect(gateDefinitionDigest('main')).not.toBe(priorCandidate);

      process.env.TEST_BASE_REF = 'bad-nonexistent-gate-cache-ref';
      expect(() => gateDefinitionDigest('main')).toThrow(/GATE_CACHE_REF_UNRESOLVED: TEST_BASE_REF/);
      process.env.TEST_BASE_REF = '0'.repeat(40);
      expect(() => gateDefinitionDigest('main')).not.toThrow();
      const gate = readFileSync(join(ROOT, 'scripts/run-governed-gate.ts'), 'utf8');
      expect(gate).toContain('if (gateDefinitionDigest(gate) !== definitionDigest)');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
