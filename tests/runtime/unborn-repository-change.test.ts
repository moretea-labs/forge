import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { continueGoalWorkloop, finalizeGoalWorkloop, routeWorkStart } from '../../src/runtime/control-plane/facade/goal-workloop';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { changedPathsFromUnbornBase } from '../../src/runtime/control-plane/execution/work-task-receipt';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

describe('repository-change Work with an unborn Git baseline', () => {
  test('persists explicit unborn authority and recognizes the first root commit without an artificial later delta', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-unborn-work-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'forge-unborn-work-state-'));
    roots.push(repoRoot, stateRoot);
    git(repoRoot, ['init', '-b', 'main']);
    expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot }).status).not.toBe(0);

    const workStore = { root: join(stateRoot, 'work') };
    const initialContext = {
      workStore,
      handoffStore: { root: join(stateRoot, 'handoff') },
      repoId: 'repo-unborn',
      checkoutId: 'checkout-unborn',
      sourceBaseState: 'unborn' as const,
      workspaceChangedPaths: [] as string[],
      availableChecks: [] as { id: string }[],
    };
    const started = routeWorkStart(initialContext, {
      objective: 'Create the initial application files in a fresh repository.',
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, risk: 'local_repo_write' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    const admittedWork = getWorkContract(workStore, workId!)!;
    expect(admittedWork).toMatchObject({
      repositoryBaseState: 'unborn',
      workKind: 'repository_change',
      phase: 'implementation',
    });
    expect('baseRevision' in admittedWork).toBe(false);

    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    for (const [path, content] of [
      ['src/app.ts', 'export const app = true;\n'],
      ['src/downstream.ts', 'export const downstream = true;\n'],
      ['src/chaos.ts', 'export const chaos = true;\n'],
      ['src/server.ts', 'export const server = true;\n'],
      ['package.json', '{"name":"unborn-fixture"}\n'],
      ['README.md', '# fixture\n'],
    ] as const) writeFileSync(join(repoRoot, path), content);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'root implementation']);
    const rootRevision = git(repoRoot, ['rev-parse', 'HEAD']);
    const changedPaths = changedPathsFromUnbornBase(repoRoot, rootRevision);
    expect(changedPaths).toEqual(['README.md', 'package.json', 'src/app.ts', 'src/chaos.ts', 'src/downstream.ts', 'src/server.ts']);

    const currentContext = {
      ...initialContext,
      sourceRevision: rootRevision,
      sourceBaseState: 'revision' as const,
      workspaceChangedPaths: changedPaths,
      workBoundProcessEvidenceIds: ['proc-root-implementation'],
    };
    const continued = continueGoalWorkloop(currentContext, { workId: workId! });
    expect(continued.status).toBe('ok');
    expect(continued.summary).not.toContain('no current net source changes');
    expect(getWorkContract(workStore, workId!)).toMatchObject({ phase: 'delivery', status: 'running' });

    const semanticFinalize = finalizeGoalWorkloop(currentContext, { workId: workId! });
    expect(semanticFinalize.status).toBe('blocked');
    expect(semanticFinalize.summary).toContain('exact delivery and cleanup completion receipt is required');
    expect(semanticFinalize.summary).not.toContain('no current net source changes');
  });

  test('uses the full target tree as net change from an unborn baseline across successor commits', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-unborn-tree-'));
    roots.push(repoRoot);
    git(repoRoot, ['init', '-b', 'main']);
    writeFileSync(join(repoRoot, 'first.txt'), 'first\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'root']);
    writeFileSync(join(repoRoot, 'second.txt'), 'second\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'second']);
    expect(changedPathsFromUnbornBase(repoRoot, git(repoRoot, ['rev-parse', 'HEAD']))).toEqual(['first.txt', 'second.txt']);
  });

  test('does not infer unborn authority for a legacy Work that merely lacks a base revision', () => {
    const workStore = { root: join(mkdtempSync(join(tmpdir(), 'forge-unborn-legacy-state-')), 'work') };
    roots.push(workStore.root.replace(/\/work$/, ''));
    const context = {
      workStore,
      handoffStore: { root: join(workStore.root, '..', 'handoff') },
      repoId: 'repo-legacy-missing-base',
      checkoutId: 'checkout-legacy',
      workspaceChangedPaths: [] as string[],
      availableChecks: [] as { id: string }[],
    };
    const started = routeWorkStart(context, {
      objective: 'Legacy-style repository change without authoritative source identity.',
      modeInput: { scopeClear: true, mutation: true, requiresRecovery: true, risk: 'local_repo_write' },
    });
    const workId = (started.data as { work?: { workId?: string } }).work?.workId;
    expect(workId).toBeTruthy();
    const legacyWork = getWorkContract(workStore, workId!)!;
    expect('baseRevision' in legacyWork).toBe(false);
    expect('repositoryBaseState' in legacyWork).toBe(false);
    const continued = continueGoalWorkloop(context, { workId: workId! });
    expect(continued.status).toBe('blocked');
    expect(continued.summary).toContain('no current net source changes');
  });
});
