import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { loadTestManifest, runTestSelection } from '../../src/testing/test-governance';

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
  test('keeps a source assertion failure distinct from infrastructure failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-source-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-port-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-signal-'));
    const ready = join(dir, 'ready');
    const testFile = join(dir, 'signal.test.ts');
    writeFileSync(
      testFile,
      'import { test } from "bun:test";\n' +
        'import { writeFileSync } from "fs";\n' +
        `writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
        'test("wait", async () => { await new Promise(() => {}); });\n',
    );
    const runner = spawn(process.execPath, [TEST_FILE_RUNNER, testFile], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
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
    const repo = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-mutation-'));
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
    try {
      const status = await runTestSelection(repo, manifest, {
        gate: 'infrastructure',
        changedPaths: [],
        modules: ['runner'],
        files: [testPath],
        reason: 'mutation fixture',
      }, { useCache: false });
      expect(status).toBe(1);
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('mutated\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test('retries infrastructure once but never retries a source assertion', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-retry-'));
    mkdirSync(join(repo, 'tests'), { recursive: true });
    const infraPath = 'tests/infra-retry.test.ts';
    const sourcePath = 'tests/source-no-retry.test.ts';
    const infraMarker = join(repo, 'infra-attempt');
    const sourceMarker = join(repo, 'source-attempt');
    writeFileSync(join(repo, infraPath),
      'import { expect, test } from "bun:test";\n' +
      'import { appendFileSync, existsSync } from "fs";\n' +
      `const marker=${JSON.stringify(infraMarker)}; const first=!existsSync(marker); appendFileSync(marker, "x");\n` +
      'test("infra retry", () => { if (first) { console.error("EADDRINUSE"); throw new Error("port fixture"); } expect(true).toBe(true); });\n');
    writeFileSync(join(repo, sourcePath),
      'import { expect, test } from "bun:test";\n' +
      'import { appendFileSync } from "fs";\n' +
      `appendFileSync(${JSON.stringify(sourceMarker)}, "x");\n` +
      'test("source failure", () => { expect(false).toBe(true); });\n');
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
      const infraStatus = await runTestSelection(repo, manifest, {
        gate: 'integration', changedPaths: [], modules: ['runner'], files: [infraPath], reason: 'retry fixture',
      }, { useCache: false, tempConcurrency: 1 });
      expect(infraStatus).toBe(0);
      expect(readFileSync(infraMarker, 'utf8')).toBe('xx');

      const sourceStatus = await runTestSelection(repo, manifest, {
        gate: 'integration', changedPaths: [], modules: ['runner'], files: [sourcePath], reason: 'source fixture',
      }, { useCache: false, tempConcurrency: 1 });
      expect(sourceStatus).toBe(1);
      expect(readFileSync(sourceMarker, 'utf8')).toBe('x');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test('enforces a file wall timeout and reports infrastructure failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-timeout-'));
    const testFile = join(dir, 'hangs.test.ts');
    writeFileSync(
      testFile,
      'import { test } from "bun:test";\n' +
        'test("never completes", async () => { await new Promise(() => {}); });\n',
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
    const dir = mkdtempSync(join(tmpdir(), 'repo-harness-test-runner-residual-'));
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
