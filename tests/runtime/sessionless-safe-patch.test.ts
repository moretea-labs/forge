import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { callRepositoryTool } from '../../src/runtime/control-plane/facade/repository-tool-dispatch';
import { applyConsoleSafePatch } from '../../src/cli/local-bridge/facade-api';
import { executeFast } from '../../src/runtime/execution/thin-harness';

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

test('canonical MCP Safe Patch defaults ordinary single-file edits to sessionless CAS (#713)', async () => {
  const fx = fixture();
  const oldSessionCount = fx.sessions().length;
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
    }],
  });
  if (!response || response.isError) throw new Error(JSON.stringify(response?.structuredContent ?? response));
  const payload = response.structuredContent as Record<string, any>;
  expect(payload).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    reviewEvidence: { source: 'atomic_patch', beforeSha256: hash(fx.initial) },
  });
  expect(payload.session).toBeUndefined();
  expect(fx.sessions()).toHaveLength(oldSessionCount);
});

test('explicit stale SHA stays stale even when caller requests fingerprint refresh (#713)', async () => {
  const fx = fixture();
  const stale = hash(fx.initial);
  writeFileSync(join(fx.repoRoot, 'source.ts'), 'export const n = 3;\nexport const label = 1;\n');
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    refresh_fingerprints: true,
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: stale,
      replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
    }],
  });
  expect(response?.isError).toBe(true);
  const payload = response?.structuredContent as Record<string, any>;
  expect(payload).toMatchObject({
    status: 'failed',
    sessionless: true,
    failures: [{ code: 'STALE_FILE_SHA', expectedSha256: stale }],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 3;\nexport const label = 1;\n');
  expect(fx.sessions()).toHaveLength(0);
});

test('explicit sessionless=false retains resumable legacy EditSession for compatibility (#713)', async () => {
  const fx = fixture();
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    sessionless: false,
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
    }],
  });
  if (!response || response.isError) throw new Error(JSON.stringify(response?.structuredContent ?? response));
  const payload = response.structuredContent as Record<string, any>;
  expect(payload.status).toBe('applied');
  expect(payload.session.sessionId).toMatch(/^EDIT-/);
  expect(payload.createdSession).toBe(true);
  expect(fx.sessions()).toHaveLength(1);
});

test('Local Bridge Console defaults single-file edits to CAS; explicit legacy remains resumable (#713)', () => {
  const fx = fixture();
  const ctx = { repository: fx.repository, controllerHome: fx.controllerHome };
  const atomic = applyConsoleSafePatch(ctx, {
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
    }],
  });
  expect(atomic).toMatchObject({
    status: 'applied', sessionless: true, createdSession: false, receipt: { beforeSha256: hash(fx.initial) },
  });
  expect(fx.sessions()).toHaveLength(0);

  const stale = applyConsoleSafePatch(ctx, {
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
    }],
  });
  expect(stale).toMatchObject({
    status: 'failed', sessionless: true,
    failures: [{ code: 'STALE_FILE_SHA', expectedSha256: hash(fx.initial) }],
  });
  expect(fx.sessions()).toHaveLength(0);

  const legacy = applyConsoleSafePatch(ctx, {
    sessionless: false,
    operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash('export const n = 2;\nexport const label = 1;\n'),
      replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
    }],
  });
  expect((legacy as any).session?.sessionId).toMatch(/^EDIT-/);
  expect(fx.sessions()).toHaveLength(1);
});

test('Fast Executor uses CAS without EditSession or Workspace Savepoint and returns stale evidence (#713)', async () => {
  const fx = fixture();
  const ctx = { controllerHome: fx.controllerHome, repository: fx.repository };
  const before = fx.sessions().length;
  const first = await executeFast(ctx, {
    operation: 'repository_safe_patch_apply',
    requestId: 'fast-sessionless-first',
    input: { operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
    }] },
  });
  expect(first.ok).toBe(true);
  expect((first.result as any).applied).toMatchObject({
    sessionless: true, createdSession: false, status: 'applied',
  });
  expect(fx.sessions()).toHaveLength(before);
  expect(existsSync(join(fx.repoRoot, '.ai/harness/backups/fs-transaction'))).toBe(false);

  const stale = await executeFast(ctx, {
    operation: 'repository_safe_patch_apply',
    requestId: 'fast-sessionless-stale',
    input: { operations: [{
      type: 'replace',
      path: 'source.ts',
      expected_sha256: hash(fx.initial),
      replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
    }] },
  });
  expect(stale.ok).toBe(false);
  expect((stale.result as any).applied.failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'STALE_FILE_SHA', expectedSha256: hash(fx.initial) }),
  ]));
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 1;\n');
  expect(fx.sessions()).toHaveLength(before);
});
