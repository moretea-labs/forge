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
    const now = new Date().toISOString();
    const checkoutId = 'race-' + process.pid;
    const repository = {
      schemaVersion: 1,
      repoId: 'race-repo',
      displayName: 'race-repo',
      localRoot: repoRoot,
      canonicalRoot: repoRoot,
      activeCheckoutId: checkoutId,
      checkouts: [{
        checkoutId,
        localRoot: repoRoot,
        canonicalRoot: repoRoot,
        worktree: false,
        branch: 'main',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      }],
      repositoryType: 'local-git',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      configurationPath: repoRoot + '/.ai/repository.json',
      stateStorageStrategy: 'repository-local',
    };
    writeFileSync(ready, 'ready');
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(go)) Atomics.wait(waiter, 0, 0, 1);
    const result = applySessionlessSafePatch(repository, {
      operations: [{
        type: 'replace',
        path: 'source.ts',
        replacements: [{ old_text: oldText, new_text: newText }],
      }],
    });
    process.stdout.write(JSON.stringify(result));
  `;

  const spawnWriter = (ready: string, oldText: string, newText: string, goPath = go) =>
    Bun.spawn([process.execPath, '-e', workerSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RACE_REPO_ROOT: fx.repoRoot,
        RACE_READY: ready,
        RACE_GO: goPath,
        RACE_OLD: oldText,
        RACE_NEW: newText,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  const writerA = spawnWriter(readyA, 'n = 1', 'n = 2');
  const writerB = spawnWriter(readyB, 'label = 1', 'label = 2');
  await waitForFiles([readyA, readyB]);
  writeFileSync(go, 'go');

  const [exitA, exitB] = await Promise.all([writerA.exited, writerB.exited]);
  const [stdoutA, stdoutB, stderrA, stderrB] = await Promise.all([
    new Response(writerA.stdout).text(),
    new Response(writerB.stdout).text(),
    new Response(writerA.stderr).text(),
    new Response(writerB.stderr).text(),
  ]);
  if (exitA !== 0 || exitB !== 0) {
    throw new Error(`race worker failed: A(${exitA}) ${stderrA}; B(${exitB}) ${stderrB}`);
  }
  const resultA = JSON.parse(stdoutA) as { status: string; sessionless?: boolean };
  const resultB = JSON.parse(stdoutB) as { status: string; sessionless?: boolean };
  expect(resultA).toMatchObject({ status: 'applied', sessionless: true });
  expect(resultB).toMatchObject({ status: 'applied', sessionless: true });
  const final = readFileSync(sourcePath, 'utf8');
  expect(final).toContain('n = 2');
  expect(final).toContain('label = 2');

  writeFileSync(sourcePath, padded);
  const readyC = join(fx.repoRoot, '.race-c-ready');
  const readyD = join(fx.repoRoot, '.race-d-ready');
  const conflictGo = join(fx.repoRoot, '.race-conflict-go');
  const writerC = spawnWriter(readyC, 'n = 1', 'n = 3', conflictGo);
  const writerD = spawnWriter(readyD, 'n = 1', 'n = 4', conflictGo);
  await waitForFiles([readyC, readyD]);
  writeFileSync(conflictGo, 'go');

  const [exitC, exitD] = await Promise.all([writerC.exited, writerD.exited]);
  const [stdoutC, stdoutD, stderrC, stderrD] = await Promise.all([
    new Response(writerC.stdout).text(),
    new Response(writerD.stdout).text(),
    new Response(writerC.stderr).text(),
    new Response(writerD.stderr).text(),
  ]);
  if (exitC !== 0 || exitD !== 0) {
    throw new Error(`conflict race worker failed: C(${exitC}) ${stderrC}; D(${exitD}) ${stderrD}`);
  }
  const conflictResults = [JSON.parse(stdoutC), JSON.parse(stdoutD)] as Array<{
    status: string;
    failures?: Array<{ code?: string }>;
  }>;
  expect(conflictResults.filter((result) => result.status === 'applied')).toHaveLength(1);
  const conflict = conflictResults.find((result) => result.status === 'failed');
  expect(conflict?.failures?.[0]?.code).toBe('SEMANTIC_CONFLICT');
  const conflictFinal = readFileSync(sourcePath, 'utf8');
  expect(conflictFinal.includes('n = 3') || conflictFinal.includes('n = 4')).toBe(true);
  expect(conflictFinal).toContain('label = 1');
  expect(fx.sessions()).toHaveLength(0);
  expect(existsSync(`${sourcePath}.forge.lock`)).toBe(false);
});

test('unversioned exact patch rejects ambiguous or changed targets without writing (#716 #724)', async () => {
  const fx = fixture();
  const duplicate = fx.initial + 'export const duplicate = 1;\n';
  writeFileSync(join(fx.repoRoot, 'source.ts'), duplicate);
  for (const { operation, expectedCode } of [
    {
      operation: { type: 'replace', replacements: [{ old_text: '= 1', new_text: '= 2' }] },
      expectedCode: 'REPLACEMENT_TEXT_NOT_FOUND',
    },
    {
      operation: { type: 'insert_after', anchor: '= 1', content: ' /* ambiguous */' },
      expectedCode: 'ANCHOR_NOT_FOUND',
    },
    {
      operation: { type: 'replace', replacements: [{ old_text: 'n = 3', new_text: 'n = 4' }] },
      expectedCode: 'SEMANTIC_CONFLICT',
    },
    {
      operation: { type: 'insert_after', anchor: 'missing anchor', content: ' /* stale */' },
      expectedCode: 'SEMANTIC_CONFLICT',
    },
  ]) {
    const result = await apply(fx, { ...operation, path: 'source.ts' });
    expect(result.isError).toBe(true);
    expect(result.payload.failures[0]).toMatchObject({ code: expectedCode });
    expect(result.payload.failures[0].context).toBeDefined();
    expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(duplicate);
  }
  expect(fx.sessions()).toHaveLength(0);
});

test('exact local edits omit whole-file CAS while full-file mutations require it (#716)', () => {
  const local = normalizeEditOperation({
    type: 'replace',
    path: 'source.ts',
    replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
  });
  expect(local).not.toHaveProperty('expectedSha256');
  expect(() => normalizeEditOperation({ type: 'write', path: 'source.ts', content: 'replacement\n' })).toThrow(
    'write requires expected_sha256',
  );
  expect(() => normalizeEditOperation({ type: 'delete', path: 'source.ts' })).toThrow(
    'delete requires expected_sha256',
  );
  expect(() => normalizeEditOperation({ type: 'move', path: 'source.ts', to_path: 'moved.ts' })).toThrow(
    'move requires expected_sha256',
  );
  expect(() => normalizeEditOperation({ type: 'move', path: 'source.ts', expected_sha256: hash('source') })).toThrow(
    'move requires to_path',
  );
});

test('single-file create/delete defaults to sessionless strict atomic mutations (#716)', async () => {
  const fx = fixture();
  const path = 'created.ts';
  const content = 'export const created = true;\n';
  const created = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'create', path, content }],
  });
  expect(created?.isError).not.toBe(true);
  expect(created?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    receipt: { path, afterSha256: hash(content) },
  });
  expect(readFileSync(join(fx.repoRoot, path), 'utf8')).toBe(content);
  expect(fx.sessions()).toHaveLength(0);
  expect(existsSync(join(fx.repoRoot, '.ai/harness/backups/fs-transaction'))).toBe(false);

  const duplicate = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'create', path, content: 'do not overwrite\n' }],
  });
  expect(duplicate?.isError).toBe(true);
  expect(duplicate?.structuredContent).toMatchObject({
    status: 'failed',
    sessionless: true,
    failures: [{ code: 'CREATE_TARGET_EXISTS' }],
  });
  expect(readFileSync(join(fx.repoRoot, path), 'utf8')).toBe(content);

  const staleDelete = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'delete', path, expected_sha256: hash('stale') }],
  });
  expect(staleDelete?.isError).toBe(true);
  expect(staleDelete?.structuredContent).toMatchObject({
    status: 'failed',
    sessionless: true,
    failures: [{ code: 'STALE_FILE_SHA', currentSha256: hash(content) }],
  });
  expect(readFileSync(join(fx.repoRoot, path), 'utf8')).toBe(content);

  const deleted = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'delete', path, expected_sha256: hash(content) }],
  });
  expect(deleted?.isError).not.toBe(true);
  expect(deleted?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    receipt: { path, beforeSha256: hash(content) },
  });
  expect(existsSync(join(fx.repoRoot, path))).toBe(false);
  expect(fx.sessions()).toHaveLength(0);
});

test('move is a strict sessionless controlled mutation with source+destination CAS evidence (#716)', async () => {
  const fx = fixture();
  const sourcePath = 'move-source.ts';
  const targetPath = 'moved/move-target.ts';
  const content = 'export const moved = true;\n';
  writeFileSync(join(fx.repoRoot, sourcePath), content);

  const moved = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'move', path: sourcePath, to_path: targetPath, expected_sha256: hash(content) }],
  });
  expect(moved?.isError).not.toBe(true);
  expect(moved?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: [sourcePath, targetPath],
    receipt: { path: sourcePath, toPath: targetPath, beforeSha256: hash(content), afterSha256: hash(content) },
  });
  expect(existsSync(join(fx.repoRoot, sourcePath))).toBe(false);
  expect(readFileSync(join(fx.repoRoot, targetPath), 'utf8')).toBe(content);
  expect(fx.sessions()).toHaveLength(0);

  const staleSource = 'stale-move-source.ts';
  const staleTarget = 'stale-move-target.ts';
  writeFileSync(join(fx.repoRoot, staleSource), content);
  const stale = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'move', path: staleSource, to_path: staleTarget, expected_sha256: hash('stale') }],
  });
  expect(stale?.isError).toBe(true);
  expect(stale?.structuredContent).toMatchObject({
    status: 'failed',
    failures: [{ code: 'STALE_FILE_SHA', currentSha256: hash(content) }],
  });
  expect(readFileSync(join(fx.repoRoot, staleSource), 'utf8')).toBe(content);
  expect(existsSync(join(fx.repoRoot, staleTarget))).toBe(false);

  const occupiedSource = 'occupied-move-source.ts';
  const occupiedTarget = 'occupied-move-target.ts';
  const occupiedContent = 'keep destination\n';
  writeFileSync(join(fx.repoRoot, occupiedSource), content);
  writeFileSync(join(fx.repoRoot, occupiedTarget), occupiedContent);
  const occupied = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [{ type: 'move', path: occupiedSource, to_path: occupiedTarget, expected_sha256: hash(content) }],
  });
  expect(occupied?.isError).toBe(true);
  expect(occupied?.structuredContent).toMatchObject({
    status: 'failed',
    failures: [{ code: 'MOVE_TARGET_EXISTS' }],
  });
  expect(readFileSync(join(fx.repoRoot, occupiedSource), 'utf8')).toBe(content);
  expect(readFileSync(join(fx.repoRoot, occupiedTarget), 'utf8')).toBe(occupiedContent);
  expect(fx.sessions()).toHaveLength(0);
});

test('move participates in independent mixed mutation planning without EditSession (#716)', async () => {
  const fx = fixture();
  const sourcePath = 'mixed-move-source.ts';
  const targetPath = 'mixed-move-target.ts';
  const createPath = 'mixed-move-create.ts';
  const content = 'export const mixedMove = true;\n';
  writeFileSync(join(fx.repoRoot, sourcePath), content);
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      { type: 'move', path: sourcePath, to_path: targetPath, expected_sha256: hash(content) },
      { type: 'create', path: createPath, content: 'export const afterMove = true;\n' },
    ],
  });
  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    changedFiles: [sourcePath, targetPath, createPath],
    groups: [
      { groupId: 'operation:1', status: 'applied', paths: [sourcePath, targetPath] },
      { groupId: 'operation:2', status: 'applied', paths: [createPath] },
    ],
  });
  expect(existsSync(join(fx.repoRoot, sourcePath))).toBe(false);
  expect(readFileSync(join(fx.repoRoot, targetPath), 'utf8')).toBe(content);
  expect(readFileSync(join(fx.repoRoot, createPath), 'utf8')).toContain('afterMove = true');
  expect(fx.sessions()).toHaveLength(0);
});

test('sessionless Safe Patch refuses symlink targets without source mutation', async () => {
  const fx = fixture();
  symlinkSync('source.ts', join(fx.repoRoot, 'alias.ts'));
  const linked = await apply(fx, {
    type: 'write',
    path: 'alias.ts',
    expected_sha256: hash(fx.initial),
    content: 'export const danger = 1;\n',
  });
  expect(linked.isError).toBe(true);
  expect(linked.payload.status).toBe('failed');
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(fx.sessions()).toHaveLength(0);
});

test('mixed independent replace/create/delete mutations route sessionlessly before execution (#716)', async () => {
  const fx = fixture();
  const createdPath = 'created-mixed.ts';
  const createdContent = 'export const createdMixed = true;\n';
  const deletedPath = 'deleted-mixed.ts';
  const deletedContent = 'export const deletedMixed = true;\n';
  writeFileSync(join(fx.repoRoot, deletedPath), deletedContent);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      { type: 'replace', path: 'source.ts', replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }] },
      { type: 'create', path: createdPath, content: createdContent },
      { type: 'delete', path: deletedPath, expected_sha256: hash(deletedContent) },
    ],
  });
  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: ['source.ts', createdPath, deletedPath],
    groups: [
      { groupId: 'operation:1', status: 'applied', operationIndexes: [1] },
      { groupId: 'operation:2', status: 'applied', operationIndexes: [2] },
      { groupId: 'operation:3', status: 'applied', operationIndexes: [3] },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
  expect(readFileSync(join(fx.repoRoot, createdPath), 'utf8')).toBe(createdContent);
  expect(existsSync(join(fx.repoRoot, deletedPath))).toBe(false);
  expect(fx.sessions()).toHaveLength(0);
});

test('independent semantic groups continue after one local conflict (#716)', async () => {
  const fx = fixture();
  const createdPath = 'independent-after-conflict.ts';
  const createdContent = 'export const independent = true;\n';
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        replacements: [{ old_text: 'missing target', new_text: 'never written' }],
      },
      { type: 'create', path: createdPath, content: createdContent },
    ],
  });
  expect(response?.isError).toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'partial',
    sessionless: true,
    changedFiles: [createdPath],
    failures: [{ operationIndex: 1, code: 'SEMANTIC_CONFLICT' }],
    groups: [
      { groupId: 'operation:1', status: 'failed', changedFiles: [] },
      { groupId: 'operation:2', status: 'applied', changedFiles: [createdPath] },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(readFileSync(join(fx.repoRoot, createdPath), 'utf8')).toBe(createdContent);
  expect(fx.sessions()).toHaveLength(0);
});

test('same-file explicit semantic group lands dependent hunks in one CAS (#716)', async () => {
  const fx = fixture();
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'source-contract',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'source-contract',
        replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
      },
    ],
  });
  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    changedFiles: ['source.ts'],
    appliedChunks: [{ index: 1, operationCount: 2, paths: ['source.ts'] }],
    groups: [
      {
        groupId: 'source-contract',
        status: 'applied',
        operationIndexes: [1, 2],
        changedFiles: ['source.ts'],
      },
    ],
  });
  const source = readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8');
  expect(source).toContain('n = 2');
  expect(source).toContain('label = 2');
  expect(fx.sessions()).toHaveLength(0);
});

test('cross-file text semantic group commits all paths through one crash-recoverable transaction (#716)', async () => {
  const fx = fixture();
  const secondPath = 'second.ts';
  const secondBefore = 'export const second = 1;\n';
  writeFileSync(join(fx.repoRoot, secondPath), secondBefore);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'cross-file-text-contract',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'replace',
        path: secondPath,
        semantic_group: 'cross-file-text-contract',
        replacements: [{ old_text: 'second = 1', new_text: 'second = 2' }],
      },
    ],
  });

  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: ['source.ts', secondPath],
    groups: [
      {
        groupId: 'cross-file-text-contract',
        status: 'applied',
        operationIndexes: [1, 2],
        changedFiles: ['source.ts', secondPath],
      },
    ],
  });
  if (!response) throw new Error('repository Safe Patch returned no response');
  const structured = response.structuredContent as { receipts?: unknown[] };
  expect(structured.receipts).toHaveLength(2);
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
  expect(readFileSync(join(fx.repoRoot, secondPath), 'utf8')).toContain('second = 2');
  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  expect(existsSync(transactionRoot) ? readdirSync(transactionRoot) : []).toHaveLength(0);
  expect(fx.sessions()).toHaveLength(0);
});

test('cross-file text semantic group performs zero writes when any path fails preflight (#716)', async () => {
  const fx = fixture();
  const secondPath = 'second-preflight.ts';
  const secondBefore = 'export const second = 1;\n';
  writeFileSync(join(fx.repoRoot, secondPath), secondBefore);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'cross-file-preflight',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'replace',
        path: secondPath,
        semantic_group: 'cross-file-preflight',
        replacements: [{ old_text: 'missing second target', new_text: 'second = 2' }],
      },
    ],
  });

  expect(response?.isError).toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'failed',
    sessionless: true,
    changedFiles: [],
    failures: [{ operationIndex: 2, code: 'SEMANTIC_CONFLICT' }],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(readFileSync(join(fx.repoRoot, secondPath), 'utf8')).toBe(secondBefore);
  expect(fx.sessions()).toHaveLength(0);
});

test('cross-file transaction recovery rolls back a partial crash and reclaims a dead target lock (#716)', () => {
  const fx = fixture();
  const secondPath = 'second-recovery.ts';
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const secondAbsolute = join(fx.repoRoot, secondPath);
  const sourceBefore = fx.initial;
  const secondBefore = 'export const second = 1;\n';
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const secondAfter = secondBefore.replace('second = 1', 'second = 2');
  writeFileSync(secondAbsolute, secondBefore);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'crash-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.before'), secondBefore);
  writeFileSync(join(transactionPath, '002.after'), secondAfter);
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: 'crash-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            mode: 0o644,
          },
          {
            path: secondPath,
            beforeSha256: hash(secondBefore),
            afterSha256: hash(secondAfter),
            beforeSnapshot: '002.before',
            afterSnapshot: '002.after',
            mode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(sourcePath, sourceAfter);
  writeFileSync(sourcePath + '.forge.lock', '99999999\n');

  expect(recoverPendingAtomicTextGroups(fx.repoRoot, ['source.ts'])).toBe(1);
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceBefore);
  expect(readFileSync(secondAbsolute, 'utf8')).toBe(secondBefore);
  expect(existsSync(sourcePath + '.forge.lock')).toBe(false);
  expect(existsSync(transactionPath)).toBe(false);
  expect(fx.sessions()).toHaveLength(0);
});

test('cross-file recovery fails closed before rollback when any crashed path diverged (#716)', () => {
  const fx = fixture();
  const secondPath = 'second-recovery-conflict.ts';
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const secondAbsolute = join(fx.repoRoot, secondPath);
  const sourceBefore = fx.initial;
  const secondBefore = 'export const second = 1;\n';
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const secondAfter = secondBefore.replace('second = 1', 'second = 2');
  const secondDiverged = 'export const second = 99;\n';
  writeFileSync(secondAbsolute, secondBefore);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'crash-conflict-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.before'), secondBefore);
  writeFileSync(join(transactionPath, '002.after'), secondAfter);
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: 'crash-conflict-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            mode: 0o644,
          },
          {
            path: secondPath,
            beforeSha256: hash(secondBefore),
            afterSha256: hash(secondAfter),
            beforeSnapshot: '002.before',
            afterSnapshot: '002.after',
            mode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(sourcePath, sourceAfter);
  writeFileSync(secondAbsolute, secondDiverged);

  expect(() => recoverPendingAtomicTextGroups(fx.repoRoot, ['source.ts'])).toThrow(
    'SAFE_PATCH_TRANSACTION_RECOVERY_CONFLICT',
  );
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceAfter);
  expect(readFileSync(secondAbsolute, 'utf8')).toBe(secondDiverged);
  expect(existsSync(transactionPath)).toBe(true);
  expect(fx.sessions()).toHaveLength(0);
});

test('single-file Safe Patch recovers an overlapping crashed multi-file group before editing (#716)', async () => {
  const fx = fixture();
  const secondPath = 'second-single-recovery.ts';
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const secondAbsolute = join(fx.repoRoot, secondPath);
  const sourceBefore = fx.initial;
  const secondBefore = 'export const second = 1;\n';
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const secondAfter = secondBefore.replace('second = 1', 'second = 2');
  writeFileSync(secondAbsolute, secondBefore);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'single-crash-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.before'), secondBefore);
  writeFileSync(join(transactionPath, '002.after'), secondAfter);
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: 'single-crash-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            mode: 0o644,
          },
          {
            path: secondPath,
            beforeSha256: hash(secondBefore),
            afterSha256: hash(secondAfter),
            beforeSnapshot: '002.before',
            afterSnapshot: '002.after',
            mode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(sourcePath, sourceAfter);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 3' }],
      },
    ],
  });

  expect(response?.isError).not.toBe(true);
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceBefore.replace('n = 1', 'n = 3'));
  expect(readFileSync(secondAbsolute, 'utf8')).toBe(secondBefore);
  expect(existsSync(transactionPath)).toBe(false);
  expect(fx.sessions()).toHaveLength(0);
});

test('multi-file recovery validates every before snapshot before restoring any target (#716)', () => {
  const fx = fixture();
  const secondPath = 'second-corrupt-snapshot.ts';
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const secondAbsolute = join(fx.repoRoot, secondPath);
  const sourceBefore = fx.initial;
  const secondBefore = 'export const second = 1;\n';
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const secondAfter = secondBefore.replace('second = 1', 'second = 2');
  writeFileSync(secondAbsolute, secondAfter);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'corrupt-snapshot-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.before'), 'corrupt before image\n');
  writeFileSync(join(transactionPath, '002.after'), secondAfter);
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: 'corrupt-snapshot-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            mode: 0o644,
          },
          {
            path: secondPath,
            beforeSha256: hash(secondBefore),
            afterSha256: hash(secondAfter),
            beforeSnapshot: '002.before',
            afterSnapshot: '002.after',
            mode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(sourcePath, sourceAfter);

  expect(() => recoverPendingAtomicTextGroups(fx.repoRoot, ['source.ts'])).toThrow(
    'SAFE_PATCH_TRANSACTION_SNAPSHOT_INVALID: second-corrupt-snapshot.ts',
  );
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceAfter);
  expect(readFileSync(secondAbsolute, 'utf8')).toBe(secondAfter);
  expect(existsSync(transactionPath)).toBe(true);
  expect(fx.sessions()).toHaveLength(0);
});

test('recovery conflict is isolated to its semantic group while independent group still applies (#716)', async () => {
  const fx = fixture();
  const peerPath = 'transaction-peer.ts';
  const independentPath = 'independent-after-recovery-conflict.ts';
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const peerAbsolute = join(fx.repoRoot, peerPath);
  const independentAbsolute = join(fx.repoRoot, independentPath);
  const sourceBefore = fx.initial;
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const peerBefore = 'export const peer = 1;\n';
  const independentBefore = 'export const independent = 1;\n';
  const sourceDiverged = 'export const source = "changed outside transaction";\n';
  writeFileSync(peerAbsolute, peerBefore);
  writeFileSync(independentAbsolute, independentBefore);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'conflicted-group-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.before'), peerBefore);
  writeFileSync(join(transactionPath, '002.after'), peerBefore.replace('peer = 1', 'peer = 2'));
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-text-group',
        transactionId: 'conflicted-group-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            mode: 0o644,
          },
          {
            path: peerPath,
            beforeSha256: hash(peerBefore),
            afterSha256: hash(peerBefore.replace('peer = 1', 'peer = 2')),
            beforeSnapshot: '002.before',
            afterSnapshot: '002.after',
            mode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(sourcePath, sourceDiverged);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'conflicted-recovery-group',
        replacements: [{ old_text: 'changed outside transaction', new_text: 'n = 3' }],
      },
      {
        type: 'replace',
        path: independentPath,
        semantic_group: 'independent-group',
        replacements: [{ old_text: 'independent = 1', new_text: 'independent = 2' }],
      },
    ],
  });

  expect(response?.isError).toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'partial',
    changedFiles: [independentPath],
    groups: [
      { groupId: 'conflicted-recovery-group', status: 'failed', changedFiles: [] },
      { groupId: 'independent-group', status: 'applied', changedFiles: [independentPath] },
    ],
  });
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceDiverged);
  expect(readFileSync(independentAbsolute, 'utf8')).toBe(
    independentBefore.replace('independent = 1', 'independent = 2'),
  );
  expect(existsSync(transactionPath)).toBe(true);
  expect(fx.sessions()).toHaveLength(0);
});

test('cross-file edit and create in one semantic group commit atomically while an independent group also continues (#716)', async () => {
  const fx = fixture();
  const groupedCreate = 'grouped-create.ts';
  const independentCreate = 'independent-create.ts';
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'cross-file-contract',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'create',
        path: groupedCreate,
        semantic_group: 'cross-file-contract',
        content: 'export const grouped = true;\n',
      },
      {
        type: 'create',
        path: independentCreate,
        content: 'export const independent = true;\n',
      },
    ],
  });
  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    changedFiles: ['source.ts', groupedCreate, independentCreate],
    failures: [],
    groups: [
      {
        groupId: 'cross-file-contract',
        status: 'applied',
        operationIndexes: [1, 2],
        changedFiles: ['source.ts', groupedCreate],
      },
      {
        groupId: 'operation:3',
        status: 'applied',
        operationIndexes: [3],
        changedFiles: [independentCreate],
      },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
  expect(readFileSync(join(fx.repoRoot, groupedCreate), 'utf8')).toContain('grouped = true');
  expect(readFileSync(join(fx.repoRoot, independentCreate), 'utf8')).toContain('independent = true');
  expect(fx.sessions()).toHaveLength(0);
});

test('mixed edit create delete and move semantic group is all-or-none (#716)', async () => {
  const fx = fixture();
  const createdPath = 'mixed-created.ts';
  const deletedPath = 'mixed-deleted.ts';
  const moveSourcePath = 'mixed-move-source.ts';
  const moveTargetPath = 'mixed-move-target.ts';
  const deletedContent = 'export const deleted = true;\n';
  const moveContent = 'export const moved = true;\n';
  writeFileSync(join(fx.repoRoot, deletedPath), deletedContent);
  writeFileSync(join(fx.repoRoot, moveSourcePath), moveContent);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'mixed-contract',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'create',
        path: createdPath,
        semantic_group: 'mixed-contract',
        content: 'export const created = true;\n',
      },
      {
        type: 'delete',
        path: deletedPath,
        semantic_group: 'mixed-contract',
        expected_sha256: hash(deletedContent),
      },
      {
        type: 'move',
        path: moveSourcePath,
        to_path: moveTargetPath,
        semantic_group: 'mixed-contract',
        expected_sha256: hash(moveContent),
      },
    ],
  });

  expect(response?.isError).not.toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'applied',
    sessionless: true,
    failures: [],
    groups: [
      {
        groupId: 'mixed-contract',
        status: 'applied',
        operationIndexes: [1, 2, 3, 4],
        changedFiles: ['source.ts', createdPath, deletedPath, moveSourcePath, moveTargetPath],
      },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
  expect(readFileSync(join(fx.repoRoot, createdPath), 'utf8')).toContain('created = true');
  expect(existsSync(join(fx.repoRoot, deletedPath))).toBe(false);
  expect(existsSync(join(fx.repoRoot, moveSourcePath))).toBe(false);
  expect(readFileSync(join(fx.repoRoot, moveTargetPath), 'utf8')).toBe(moveContent);
  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  expect(existsSync(transactionRoot) ? readdirSync(transactionRoot) : []).toHaveLength(0);
  expect(fx.sessions()).toHaveLength(0);
});

test('mixed semantic group performs zero writes when a structural preflight fails (#716)', async () => {
  const fx = fixture();
  const existingCreatePath = 'already-exists.ts';
  const deletePath = 'delete-remains.ts';
  const existingContent = 'export const existing = true;\n';
  const deleteContent = 'export const keep = true;\n';
  writeFileSync(join(fx.repoRoot, existingCreatePath), existingContent);
  writeFileSync(join(fx.repoRoot, deletePath), deleteContent);

  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        semantic_group: 'mixed-preflight',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
      {
        type: 'create',
        path: existingCreatePath,
        semantic_group: 'mixed-preflight',
        content: 'should never land\n',
      },
      {
        type: 'delete',
        path: deletePath,
        semantic_group: 'mixed-preflight',
        expected_sha256: hash(deleteContent),
      },
    ],
  });

  expect(response?.isError).toBe(true);
  expect(response?.structuredContent).toMatchObject({
    status: 'failed',
    sessionless: true,
    changedFiles: [],
    failures: [{ operationIndex: 2, code: 'CREATE_TARGET_EXISTS' }],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(readFileSync(join(fx.repoRoot, existingCreatePath), 'utf8')).toBe(existingContent);
  expect(readFileSync(join(fx.repoRoot, deletePath), 'utf8')).toBe(deleteContent);
  expect(fx.sessions()).toHaveLength(0);
});

test('path-state transaction recovery restores edited/deleted paths and removes partially created path (#716)', () => {
  const fx = fixture();
  const sourcePath = join(fx.repoRoot, 'source.ts');
  const createdPath = 'crash-created.ts';
  const createdAbsolute = join(fx.repoRoot, createdPath);
  const deletedPath = 'crash-deleted.ts';
  const deletedAbsolute = join(fx.repoRoot, deletedPath);
  const sourceBefore = fx.initial;
  const sourceAfter = sourceBefore.replace('n = 1', 'n = 2');
  const createdAfter = 'export const created = true;\n';
  const deletedBefore = 'export const deleted = true;\n';
  writeFileSync(deletedAbsolute, deletedBefore);

  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'path-state-crash-fixture');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, '001.before'), sourceBefore);
  writeFileSync(join(transactionPath, '001.after'), sourceAfter);
  writeFileSync(join(transactionPath, '002.after'), createdAfter);
  writeFileSync(join(transactionPath, '003.before'), deletedBefore);
  writeFileSync(
    join(transactionPath, 'manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        kind: 'safe-patch-path-group',
        transactionId: 'path-state-crash-fixture',
        createdAt: new Date().toISOString(),
        status: 'committing',
        entries: [
          {
            path: 'source.ts',
            beforeExists: true,
            afterExists: true,
            beforeSha256: hash(sourceBefore),
            afterSha256: hash(sourceAfter),
            beforeSnapshot: '001.before',
            afterSnapshot: '001.after',
            beforeMode: 0o644,
            afterMode: 0o644,
          },
          {
            path: createdPath,
            beforeExists: false,
            afterExists: true,
            afterSha256: hash(createdAfter),
            afterSnapshot: '002.after',
            afterMode: 0o644,
          },
          {
            path: deletedPath,
            beforeExists: true,
            afterExists: false,
            beforeSha256: hash(deletedBefore),
            beforeSnapshot: '003.before',
            beforeMode: 0o644,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(sourcePath, sourceAfter);
  writeFileSync(createdAbsolute, createdAfter);
  rmSync(deletedAbsolute);

  expect(recoverPendingAtomicPathMutationGroups(fx.repoRoot, ['source.ts'])).toBe(1);
  expect(readFileSync(sourcePath, 'utf8')).toBe(sourceBefore);
  expect(existsSync(createdAbsolute)).toBe(false);
  expect(readFileSync(deletedAbsolute, 'utf8')).toBe(deletedBefore);
  expect(existsSync(transactionPath)).toBe(false);
  expect(fx.sessions()).toHaveLength(0);
});

test('corrupt transient path-state manifest fails closed instead of being skipped (#716)', () => {
  const fx = fixture();
  const transactionRoot = join(fx.repoRoot, SAFE_PATCH_TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, 'corrupt-path-state-manifest');
  mkdirSync(transactionPath, { recursive: true });
  writeFileSync(join(transactionPath, 'manifest.json'), '{not-json\n');

  expect(() => recoverPendingAtomicPathMutationGroups(fx.repoRoot, ['source.ts'])).toThrow(
    'SAFE_PATCH_TRANSACTION_INVALID',
  );
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe(fx.initial);
  expect(existsSync(transactionPath)).toBe(true);
  expect(fx.sessions()).toHaveLength(0);
});

test('canonical MCP Safe Patch defaults ordinary single-file edits to sessionless CAS (#713)', async () => {
  const fx = fixture();
  const oldSessionCount = fx.sessions().length;
  const response = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
    repo_id: fx.repository.repoId,
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
    ],
  });
  if (!response || response.isError) throw new Error(JSON.stringify(response?.structuredContent ?? response));
  const payload = response.structuredContent as Record<string, any>;
  expect(payload).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    reviewEvidence: {
      source: 'atomic_patch',
      receipts: [{ beforeSha256: hash(fx.initial), path: 'source.ts' }],
    },
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
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        expected_sha256: stale,
        replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
      },
    ],
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

test('Local Bridge Console uses CAS and preserves strict stale-SHA rejection (#716)', () => {
  const fx = fixture();
  const ctx = { repository: fx.repository, controllerHome: fx.controllerHome };
  const atomic = applyConsoleSafePatch(ctx, {
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
      },
    ],
  });
  expect(atomic).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    receipt: { beforeSha256: hash(fx.initial) },
  });
  expect(fx.sessions()).toHaveLength(0);

  const stale = applyConsoleSafePatch(ctx, {
    operations: [
      {
        type: 'replace',
        path: 'source.ts',
        expected_sha256: hash(fx.initial),
        replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
      },
    ],
  });
  expect(stale).toMatchObject({
    status: 'failed',
    sessionless: true,
    failures: [{ code: 'STALE_FILE_SHA', expectedSha256: hash(fx.initial) }],
  });
  expect(fx.sessions()).toHaveLength(0);

  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 1;\n');
  expect(fx.sessions()).toHaveLength(0);
});

test('Local Bridge Console routes multi-mutation batches through the shared sessionless planner (#716)', () => {
  const fx = fixture();
  const ctx = { repository: fx.repository, controllerHome: fx.controllerHome };
  const createdPath = 'console-created.ts';
  const atomic = applyConsoleSafePatch(ctx, {
    operations: [
      { type: 'replace', path: 'source.ts', replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }] },
      { type: 'create', path: createdPath, content: 'export const consoleCreated = true;\n' },
    ],
  });
  expect(atomic).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: ['source.ts', createdPath],
    groups: [
      { groupId: 'operation:1', status: 'applied' },
      { groupId: 'operation:2', status: 'applied' },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toContain('n = 2');
  expect(readFileSync(join(fx.repoRoot, createdPath), 'utf8')).toContain('consoleCreated = true');
  expect(fx.sessions()).toHaveLength(0);
});

test('Fast Executor routes multi-mutation batches through the shared sessionless planner (#716)', async () => {
  const fx = fixture();
  const ctx = { controllerHome: fx.controllerHome, repository: fx.repository };
  const createdPath = 'fast-created.ts';
  const result = await executeFast(ctx, {
    operation: 'repository_safe_patch_apply',
    requestId: 'fast-sessionless-multi',
    input: {
      operations: [
        { type: 'replace', path: 'source.ts', replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }] },
        { type: 'create', path: createdPath, content: 'export const fastCreated = true;\n' },
      ],
    },
  });
  expect(result.ok).toBe(true);
  expect((result.result as any).applied).toMatchObject({
    status: 'applied',
    sessionless: true,
    createdSession: false,
    changedFiles: ['source.ts', createdPath],
    groups: [
      { groupId: 'operation:1', status: 'applied' },
      { groupId: 'operation:2', status: 'applied' },
    ],
  });
  expect(readFileSync(join(fx.repoRoot, createdPath), 'utf8')).toContain('fastCreated = true');
  expect(fx.sessions()).toHaveLength(0);
});

test('Fast Executor uses CAS without EditSession or Workspace Savepoint and returns stale evidence (#713)', async () => {
  const fx = fixture();
  const ctx = { controllerHome: fx.controllerHome, repository: fx.repository };
  const before = fx.sessions().length;
  const first = await executeFast(ctx, {
    operation: 'repository_safe_patch_apply',
    requestId: 'fast-sessionless-first',
    input: {
      operations: [
        {
          type: 'replace',
          path: 'source.ts',
          replacements: [{ old_text: 'n = 1', new_text: 'n = 2' }],
        },
      ],
    },
  });
  expect(first.ok).toBe(true);
  expect((first.result as any).applied).toMatchObject({
    sessionless: true,
    createdSession: false,
    status: 'applied',
  });
  expect(fx.sessions()).toHaveLength(before);
  expect(existsSync(join(fx.repoRoot, '.ai/harness/backups/fs-transaction'))).toBe(false);

  const stale = await executeFast(ctx, {
    operation: 'repository_safe_patch_apply',
    requestId: 'fast-sessionless-stale',
    input: {
      operations: [
        {
          type: 'replace',
          path: 'source.ts',
          expected_sha256: hash(fx.initial),
          replacements: [{ old_text: 'label = 1', new_text: 'label = 2' }],
        },
      ],
    },
  });
  expect(stale.ok).toBe(false);
  expect((stale.result as any).applied.failures).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'STALE_FILE_SHA', expectedSha256: hash(fx.initial) })]),
  );
  expect(readFileSync(join(fx.repoRoot, 'source.ts'), 'utf8')).toBe('export const n = 2;\nexport const label = 1;\n');
  expect(fx.sessions()).toHaveLength(before);
});
