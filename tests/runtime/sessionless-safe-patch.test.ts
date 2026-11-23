import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { callRepositoryTool } from '../../src/runtime/control-plane/facade/repository-tool-dispatch';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
      beforeSha256: hash(fx.initial),
    },
  });
  expect(next.payload.session).toBeUndefined();
  expect(next.payload.reviewEvidence.afterSha256).toBe(hash('export const n = 2;\nexport const label = 1;\n'));
  expect(fx.sessions()).toHaveLength(count);
  expect(existsSync(join(fx.repoRoot, '.ai/harness/backups/fs-transaction'))).toBe(false);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
});

test('two writers on the same file get stale evidence and preserve both edits after re-read', async () => {
  const fx = fixture();
  const count = fx.sessions().length;
  const oldHash = hash(fx.initial);
  const writerA = await apply(fx, {
    type: 'replace', path: 'source.ts', expected_sha256: oldHash,
    replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
  });
  expect(writerA.payload.status).toBe('applied');
  const staleB = await apply(fx, {
    type: 'replace', path: 'source.ts', expected_sha256: oldHash,
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
    type: 'replace', path: 'source.ts', expected_sha256: staleB.payload.failures[0].currentSha256,
    replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
  });
  expect(writerB.payload.status).toBe('applied');
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 2;\n');
  expect(fx.sessions()).toHaveLength(count);
});

test('sessionless Safe Patch refuses symlink targets and multi-file batches without source mutation', async () => {
  const fx = fixture();
  symlinkSync('source.ts', join(fx.repoRoot, 'alias.ts'));
  const linked = await apply(fx, {
    type: 'write', path: 'alias.ts', expected_sha256: hash(fx.initial),
    content: 'export const danger = 1;\n',
  });
  expect(linked.isError).toBe(true);
  expect(linked.payload.status).toBe('failed');
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  const unsupported = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    sessionless: true,
    operations: [
      { type: 'replace', path: 'source.ts', replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }] },
      { type: 'replace', path: 'source.ts', replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }] },
    ],
  });
  expect(unsupported?.isError).toBe(true);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(fx.sessions()).toHaveLength(0);
});
