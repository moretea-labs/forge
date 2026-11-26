import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { callRepositoryTool } from '../../src/runtime/control-plane/facade/repository-tool-dispatch';
import { applyConsoleSafePatch } from '../../src/cli/local-bridge/facade-api';
import { executeFast } from '../../src/runtime/execution/thin-harness';
import { normalizeEditOperation } from '../../src/runtime/editing/edit-operation-contract';
import {
  recoverPendingAtomicPathMutationGroups,
  recoverPendingAtomicTextGroups,
  SAFE_PATCH_TRANSACTION_ROOT,
} from '../../src/effects/fs-transaction';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function waitForFiles(paths: string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${paths.join(', ')}`);
    await Bun.sleep(5);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-sessionless-patch-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const controllerHome = join(root, 'controller');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(controllerHome, { recursive: true });
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  const initial = 'export const n = 1;\nexport const label = 1;\n';
  writeFileSync(join(repoRoot, 'source.ts'), initial);
  git('add', 'source.ts');
  git('commit', '-qm', 'fixture');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  const sessionRoot = join(repoRoot, '.ai/harness/edit-sessions');
  const sessions = () =>
    existsSync(sessionRoot) ? readdirSync(sessionRoot).filter((entry) => entry.startsWith('EDIT-')) : [];
  return { repoRoot, controllerHome, repository, initial, sessions };
}

async function apply(
  fx: ReturnType<typeof fixture>,
  operation: Record<string, unknown>,
): Promise<{ isError?: boolean; payload: Record<string, any> }> {
  const result = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    sessionless: true,
    operations: [operation],
  });
  if (!result) throw new Error('repository Safe Patch returned no response');
  return { isError: result.isError, payload: result.structuredContent as Record<string, any> };
}

test('sessionless Safe Patch applies atomic CAS without creating edit-session or backup history', async () => {
  const fx = fixture();
  const count = fx.sessions().length;
  const next = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    expected_sha256: hash(fx.initial),
    replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
  });
  expect(next.isError).not.toBe(true);
  expect(next.payload).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    reviewEvidence: {
      source: 'atomic_patch',
      receipts: [{ beforeSha256: hash(fx.initial), path: 'source.ts' }],
    },
  });
  expect(next.payload.session).toBeUndefined();
  expect(next.payload.reviewEvidence.receipts[0]?.afterSha256).toBe(
    hash('export const n = 2;\nexport const label = 1;\n'),
  );
  expect(fx.sessions()).toHaveLength(count);
  expect(existsSync(join(fx.repoRoot, '.ai/harness/backups/fs-transaction'))).toBe(false);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
});

test('sessionless Safe Patch preserves executable mode on replacement (#716)', async () => {
  const fx = fixture();
  const executablePath = join(fx.repoRoot, 'script.sh');
  const before = '#!/bin/sh\necho before\n';
  writeFileSync(executablePath, before);
  chmodSync(executablePath, 0o755);

  const next = await apply(fx, {
    type: 'replace',
    path: 'script.sh',
    expected_sha256: hash(before),
    replacements: [{ old_text: 'echo before', new_text: 'echo after' }],
  });

  expect(next.isError).not.toBe(true);
  expect(readFileSync(executablePath, 'utf8')).toContain('echo after');
  expect(lstatSync(executablePath).mode & 0o111).toBe(0o111);
  expect(next.payload.session).toBeUndefined();
});

test('two writers on the same file get stale evidence and preserve both edits after re-read', async () => {
  const fx = fixture();
  const count = fx.sessions().length;
  const oldHash = hash(fx.initial);
  const writerA = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    expected_sha256: oldHash,
    replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
  });
  expect(writerA.payload.status).toBe('applied');
  const staleB = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    expected_sha256: oldHash,
    replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
  });
  expect(staleB.isError).toBe(true);
  expect(staleB.payload).toMatchObject({
    status: 'failed',
    failures: [{ code: 'STALE_FILE_SHA', expectedSha256: oldHash }],
  });
  expect(staleB.payload.failures[0].currentSha256).toBe(writerA.payload.receipt.afterSha256);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('label = 1');

  const writerB = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    expected_sha256: staleB.payload.failures[0].currentSha256,
    replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
  });
  expect(writerB.payload.status).toBe('applied');
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 2;\n');
  expect(fx.sessions()).toHaveLength(count);
});

test('independent exact replacements continue after source and HEAD change without a session (#716)', async () => {
  const fx = fixture();
  const a = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
  });
  expect(a.payload.status).toBe('applied');
  const commit = spawnSync('git', ['commit', '-am', 'independent edit'], { cwd: fx.repoRoot, encoding: 'utf8' });
  expect(commit.status).toBe(0);
  const b = await apply(fx, {
    type: 'replace',
    path: 'source.ts',
    replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
  });
  expect(b.payload.status).toBe('applied');
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 2;\n');
  expect(fx.sessions()).toHaveLength(0);
});

test('simultaneous processes preserve independent edits and reject same-target conflicts (#716 #724)', async () => {
  const fx = fixture();
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const padded = `${fx.initial}// ${'x'.repeat(2 * 1024 * 1024)}\n`;
  writeFileSync(sourcePath, padded);

  const readyA = join(fx.repoRoot, '.race-a-ready');
  const readyB = join(fx.repoRoot, '.race-b-ready');
  const go = join(fx.repoRoot, '.race-go');
  const workerSource = `
    import { existsSync, writeFileSync } from 'fs';
    const { applySessionlessSafePatch } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/runtime/repositories/safe-patch.ts')).href)});
    const repoRoot = process.env.RACE_REPO_ROOT;
    const ready = process.env.RACE_READY;
    const go = process.env.RACE_GO;
    const oldText = process.env.RACE_OLD;
    const newText = process.env.RACE_NEW;
    if (!repoRoot || !ready || !go || !oldText || !newText) throw new Error('missing race worker env');
    const now =...