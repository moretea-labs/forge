import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { loadTestManifest, runTestSelection, type TestRunReceipt } from '../../src/testing/test-governance';
import { consumeStructuredCheckResultPath } from '../../scripts/test-governance';
import { committedChangedPaths, materializeCommittedTestCandidate } from '../../src/testing/source-quality-candidate';

const ROOT = join(import.meta.dir, '../..');
const TEST_FILE_RUNNER = join(ROOT, 'scripts', 'run-bun-test-file.ts');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('test runner infrastructure', () => {
  test('consumes the parent structured-result path before spawning nested test processes', () => {
    const env: NodeJS.ProcessEnv = {
      FORGE_CHECK_STRUCTURED_RESULT_PATH: join(tmpdir(), 'forge-structured-result.json'),
    };
    const path = consumeStructuredCheckResultPath(env);
    expect(path).toBe(join(tmpdir(), 'forge-structured-result.json'));
    expect(env.FORGE_CHECK_STRUCTURED_RESULT_PATH).toBeUndefined();
  });
  test('keeps a source assertion failure distinct from infrastructure failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-test-runner-source-'));
    const testFile = join(dir, 'fails.test.ts');
    writeFileSync(
      testFile,
      'import { expect, test } from "bun:test";\n' +
        'test("fails in the test body", () => { expect(false).toBe(true); });\n',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [TEST_FILE_RUNNER, '--timeout', '60000', '--max-concurrency', '1', testFile],
        { cwd: ROOT, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TEST_SOURCE_ASSERTION_FAILED');
      expect(result.stderr).not.toContain('TEST_INFRA_FILE_WALL_TIMEOUT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('classifies a real fixed-port conflict as infrastructure', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const dir = mkdtempSync(join(tmpdir(), 'forge-test-runner-port-'));
    const testFile = join(dir, 'port-conflict.test.ts');
    writeFileSync(
      testFile,
      'import { test } from "bun:test";\n' +
        'import { createServer } from "net";\n' +
        `test("port conflict", async () => { const server = createServer(); server.listen(${address.port}, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve)); });\n`,
    );
    try {
      const result = spawnSync(process.execPath, [TEST_FILE_RUNNER, testFile], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TEST_INFRA_PORT_CONFLICT');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('forwards termination and exits with the conventional signal code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-test-runner-signal-'));
    const ready = join(dir, 'ready');
    const testFile = join(dir, 'signal.test.ts');
    writeFileSync(
      testFile,
      'import { test } from "bun:test";\n' +
        'import { writeFileSync } from "fs";\n' +
        `writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
        'test("wait", async () => { await new Promise(() => {}); });\n',
    );
    const runner = spawn(process.execPath, [TEST_FILE_RUNNER, testFile], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      runner.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => runner.once('close', resolve));
      expect(code).toBe(143);
    } finally {
      if (processExists(runner.pid ?? -1)) runner.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('rejects a passing test that mutates the tracked tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-test-runner-mutation-'));
    const testPath = 'tests/infrastructure/mutates-tree.test.ts';
    mkdirSync(join(repo, 'tests/infrastructure'), { recursive: true });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    writeFileSync(
      join(repo, testPath),
      'import { expect, test } from "bun:test";\n' +
        'import { writeFileSync } from "fs";\n' +
        'test("mutates", () => { writeFileSync("tracked.txt", "mutated\\n"); expect(true).toBe(true); });\n',
    );
    spawnSync('git', ['init', '-q'], { cwd: repo });
    spawnSync('git', ['add', '.'], { cwd: repo });
    const base = loadTestManifest(ROOT);
    const manifest = {
      ...base,
      tests: { [testPath]: { module: 'runner' as const, resource: 'process-tree' as const } },
    };
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-test-runner-controller-'));
    try {
      let receipt: TestRunReceipt | undefined;
      const status = await runTestSelection(
        repo,
        manifest,
        {
          gate: 'infrastructure',
          changedPaths: [],
          modules: ['runner'],
          files: [testPath],
          reason: 'mutation fixture',
        },
        {
          useCache: false,
          storageAuthority: { controllerHome, repoId: 'repo-test-runner-mutation' },
          onReceipt: (value) => {
            receipt = value;
          },
        },
      );
      expect(status).toBe(1);
      expect(receipt?.failureEvidence).toMatchObject({
        status: 'failed',
        failures: 1,
        failureClasses: ['infrastructure'],
        contaminated: true,
        failureDetails: [
          { file: testPath, failureClass: 'infrastructure', failureCode: 'TEST_INFRA_WORKTREE_MUTATION' },
        ],
      });
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('mutated\n');
      expect(existsSync(join(repo, '.ai', 'harness', 'checks'))).toBe(false);
      expect(
        existsSync(join(controllerHome, 'repositories', 'repo-test-runner-mutation', 'checks', 'tests', 'receipts')),
      ).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  }, 15_000);

  test('uses pinned Git candidate for independent tests without touching another Writer dirty, and catches test mutation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-test-runner-committed-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-test-runner-committed-controller-'));
    let isolated: string | undefined;
    try {
      mkdirSync(join(repo, 'tests'), { recursive: true });
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src/value.ts'), 'export const value = 1;\n');
      writeFileSync(
        join(repo, 'tests/reads.test.ts'),
        'import { test, expect } from "bun:test";\n' +
          'import { readFileSync } from "node:fs";\n' +
          'test("reads candidate", () => { expect(readFileSync("src/value.ts", "utf8")).toBe("export const value = 1;\\n"); });\n',
      );
      writeFileSync(
        join(repo, 'tests/mutates.test.ts'),
        'import { test, expect } from "bun:test";\n' +
          'import { writeFileSync } from "node:fs";\n' +
          'test("writes candidate", () => { writeFileSync("src/value.ts", "export const value = 9;\\n"); expect(true).toBe(true); });\n',
      );
      spawnSync('git', ['init', '-q'], { cwd: repo });
      spawnSync('git', ['add', '.'], { cwd: repo });
      spawnSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', 'commit', '-qm', 'candidate'],
        { cwd: repo },
      );
      symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
      // This is the other Writer's dirty change. It must remain untouched.
      writeFileSync(join(repo, 'src/value.ts'), 'export const value = 2;\n');
      writeFileSync(join(repo, 'src/untracked.ts'), 'untracked\n');
      isolated = materializeCommittedTestCandidate(repo, 'HEAD');
      expect(existsSync(join(isolated, '.git'))).toBe(true);
      expect(existsSync(join(isolated, 'src/untracked.ts'))).toBe(false);
      const original = loadTestManifest(ROOT);
      const manifest = {
        ...original,
        tests: {
          'tests/reads.test.ts': { module: 'runner' as const, resource: 'pure' as const },
          'tests/mutates.test.ts': { module: 'runner' as const, resource: 'pure' as const },
        },
      };
      let outcome: TestRunReceipt | undefined;
      const options = {
        useCache: false,
        pureConcurrency: 1,
        isolatedCandidateRoot: isolated,
        isolatedCandidateRevision: 'pinned-fixture',
        storageAuthority: { controllerHome, repoId: 'repo-committed-test' },
        onReceipt: (receipt: TestRunReceipt) => {
          outcome = receipt;
        },
      };
      const selection = (file: string) => ({
        gate: 'infrastructure' as const,
        changedPaths: [file],
        modules: ['runner' as const],
        files: [file],
        reason: 'pinned candidate regression',
      });
      expect(await runTestSelection(repo, manifest, selection('tests/reads.test.ts'), options)).toBe(0);
      expect(outcome?.failureEvidence).toMatchObject({ status: 'passed', contaminated: false });
      expect(readFileSync(join(repo, 'src/value.ts'), 'utf8')).toBe('export const value = 2;\n');

      expect(await runTestSelection(repo, manifest, selection('tests/mutates.test.ts'), options)).toBe(1);
      expect(outcome?.failureEvidence).toMatchObject({
        status: 'failed',
        contaminated: true,
        failureDetails: [
          {
            file: 'tests/mutates.test.ts',
            failureClass: 'infrastructure',
            failureCode: 'TEST_INFRA_WORKTREE_MUTATION',
          },
        ],
      });
      expect(readFileSync(join(repo, 'src/value.ts'), 'utf8')).toBe('export const value = 2;\n');
      expect(readFileSync(join(repo, 'src/untracked.ts'), 'utf8')).toBe('untracked\n');
    } finally {
      if (isolated) rmSync(isolated, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  }, 30000);

  test('selects committed deleted paths without absorbing another Writer dirty', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-test-selection-committed-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'removed.ts'), 'export const old = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: repo });
      spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', 'commit', '-qm', 'base'], {
        cwd: repo,
      });
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      rmSync(join(repo, 'removed.ts'));
      writeFileSync(join(repo, 'added.ts'), 'export const added = 1;\n');
      spawnSync('git', ['add', '-A'], { cwd: repo });
      spawnSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', 'commit', '-qm', 'candidate'],
        { cwd: repo },
      );
      writeFileSync(join(repo, 'uncommitted.ts'), 'export const dirty = 2;\n');
      writeFileSync(join(repo, 'added.ts'), 'export const dirty = 3;\n');
      expect(committedChangedPaths(repo, base, 'HEAD')).toEqual(['added.ts', 'removed.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('retries infrastructure once but never retries a source assertion', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-test-runner-retry-'));
    const markerDir = mkdtempSync(join(tmpdir(), 'forge-test-runner-retry-markers-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-test-runner-retry-controller-'));
    mkdirSync(join(repo, 'tests'), { recursive: true });
    const infraPath = 'tests/infra-retry.test.ts';
    const sourcePath = 'tests/source-no-retry.test.ts';
    const infraMarker = join(markerDir, 'infra-attempt');
    const sourceMarker = join(markerDir, 'source-attempt');
    writeFileSync(
      join(repo, infraPath),
      'import { expect, test } from "bun:test";\n' +
        'import { appendFileSync, existsSync } from "fs";\n' +
        `const marker=${JSON.stringify(infraMarker)}; const first=!existsSync(marker); appendFileSync(marker, "x");\n` +
        'test("infra retry", () => { if (first) { console.error("EADDRINUSE"); throw new Error("port fixture"); } expect(true).toBe(true); });\n',
    );
    writeFileSync(
      join(repo, sourcePath),
      'import { expect, test } from "bun:test";\n' +
        'import { appendFileSync } from "fs";\n' +
        `appendFileSync(${JSON.stringify(sourceMarker)}, "x");\n` +
        'test("source failure", () => { expect(false).toBe(true); });\n',
    );
    spawnSync('git', ['init', '-q'], { cwd: repo });
    spawnSync('git', ['add', '.'], { cwd: repo });
    const base = loadTestManifest(ROOT);
    const manifest = {
      ...base,
      tests: {
        [infraPath]: { module: 'runner' as const, resource: 'temp-isolated' as const },
        [sourcePath]: { module: 'runner' as const, resource: 'temp-isolated' as const },
      },
    };
    try {
      const infraStatus = await runTestSelection(
        repo,
        manifest,
        {
          gate: 'integration',
          changedPaths: [],
          modules: ['runner'],
          files: [infraPath],
          reason: 'retry fixture',
        },
        {
          useCache: false,
          tempConcurrency: 1,
          storageAuthority: { controllerHome, repoId: 'repo-test-runner-retry' },
        },
      );
      expect(infraStatus).toBe(0);
      expect(readFileSync(infraMarker, 'utf8')).toBe('xx');

      let sourceReceipt: TestRunReceipt | undefined;
      const sourceStatus = await runTestSelection(
        repo,
        manifest,
        {
          gate: 'integration',
          changedPaths: [],
          modules: ['runner'],
          files: [sourcePath],
          reason: 'source fixture',
        },
        {
          useCache: false,
          tempConcurrency: 1,
          storageAuthority: { controllerHome, repoId: 'repo-test-runner-retry' },
          onReceipt: (value) => {
            sourceReceipt = value;
          },
        },
      );
      expect(sourceStatus).toBe(1);
      expect(readFileSync(sourceMarker, 'utf8')).toBe('x');
      expect(sourceReceipt?.failureEvidence).toMatchObject({
        status: 'failed',
        failures: 1,
        failureClasses: ['source'],
        contaminated: false,
        failureDetails: [
          { file: sourcePath, failureClass: 'source', failureCode: 'TEST_SOURCE_ASSERTION_FAILED', attempts: 1 },
        ],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  }, 15_000);

  test('enforces a file wall timeout and reports infrastructure failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-test-runner-timeout-'));
    const testFile = join(dir, 'hangs.test.ts');
    writeFileSync(
      testFile,
      'import { test } from "bun:test";\n' + 'test("never completes", async () => { await new Promise(() => {}); });\n',
    );
    try {
      const result = spawnSync(
        process.execPath,
        [TEST_FILE_RUNNER, '--timeout', '60000', '--max-concurrency', '1', testFile],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, BUN_TEST_FILE_WALL_TIMEOUT_MS: '200' },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TEST_INFRA_FILE_WALL_TIMEOUT');
      expect(result.stderr).not.toContain('TEST_SOURCE_ASSERTION_FAILED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('reaps a descendant after the test file closes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-test-runner-residual-'));
    const pidFile = join(dir, 'child.pid');
    const testFile = join(dir, 'leaky.test.ts');
    try {
      writeFileSync(
        testFile,
        'import { expect, test } from "bun:test";\n' +
          'import { spawn } from "child_process";\n' +
          'import { writeFileSync } from "fs";\n' +
          'test("leaves a child for bounded cleanup", () => {\n' +
          `  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
          `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
          '  child.unref();\n' +
          '  expect(child.pid).toBeGreaterThan(0);\n' +
          '});\n',
      );

      const result = spawnSync(
        process.execPath,
        [TEST_FILE_RUNNER, '--timeout', '10000', '--max-concurrency', '1', testFile],
        { cwd: ROOT, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TEST_INFRA_RESIDUAL_PROCESS');
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(Number.isInteger(pid)).toBe(true);
      expect(processExists(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
