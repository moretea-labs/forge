import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../../src/runtime/repositories/registry';
import {
  getGitHubPluginStatus,
  loadGitHubPluginConfig,
  saveGitHubPluginConfig,
} from '../../src/runtime/plugins/github-config';
import {
  buildGitHubWorkflowDispatchArgs,
  buildGitHubWorkflowListArgs,
  buildGitHubWorkflowRunListArgs,
  buildGitHubProjectItemListArgs,
  parseGitHubProjectItems,
} from '../../src/runtime/plugins/github-client';
import { buildGitHubPluginManifest } from '../../src/runtime/plugins/github-adapter';

describe('GitHub Actions plugin surface', () => {
  test('builds bounded fixed GitHub CLI argv for workflow discovery and dispatch', () => {
    expect(buildGitHubWorkflowListArgs('moretea-labs/forge', { limit: 25, includeDisabled: true })).toEqual([
      'workflow', 'list', '--repo', 'moretea-labs/forge', '--json', 'id,name,path,state', '--limit', '25', '--all',
    ]);
    expect(buildGitHubWorkflowRunListArgs('moretea-labs/forge', {
      workflow: 'ci.yml', branch: 'main', status: 'success', limit: 10, includeDisabled: true,
    })).toEqual([
      'run', 'list', '--repo', 'moretea-labs/forge',
      '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt',
      '--limit', '10', '--workflow', 'ci.yml', '--branch', 'main', '--status', 'success', '--all',
    ]);
    expect(buildGitHubWorkflowDispatchArgs('moretea-labs/forge', {
      workflow: 'benchmark.yml', ref: 'main', inputs: { z: true, samples: 30 },
    })).toEqual([
      'workflow', 'run', 'benchmark.yml', '--repo', 'moretea-labs/forge', '--ref', 'main',
      '--raw-field', 'samples=30', '--raw-field', 'z=true',
    ]);
  });

  test('rejects unbounded or injection-shaped workflow arguments', () => {
    expect(() => buildGitHubWorkflowDispatchArgs('moretea-labs/forge', { workflow: 'bad\nworkflow' })).toThrow(/single-line/);
    expect(() => buildGitHubWorkflowDispatchArgs('moretea-labs/forge', { workflow: 'ci.yml', inputs: { 'bad key': 'x' } })).toThrow(/INPUT_KEY_INVALID/);
    expect(() => buildGitHubWorkflowListArgs('moretea-labs/forge', { limit: 101 })).toThrow(/LIMIT_INVALID/);
  });

  test('declares readonly discovery and authorized remote workflow dispatch through the existing GitHub plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-github-actions-manifest-'));
    try {
      const manifest = buildGitHubPluginManifest(0, undefined, root);
      const actions = Object.fromEntries(manifest.actions.map((action) => [action.actionId, action]));
      expect(actions.list_workflows).toMatchObject({ readOnly: true, risk: 'readonly', confirmation: 'none', idempotent: true });
      expect(actions.list_workflow_runs).toMatchObject({ readOnly: true, risk: 'readonly', confirmation: 'none', idempotent: true });
      expect(actions.dispatch_workflow).toMatchObject({ readOnly: false, risk: 'remote_write', confirmation: 'authorization', idempotent: false });
      expect(actions.dispatch_workflow.resourceClaims).toEqual([{ resource: 'remote', mode: 'exclusive' }]);
      expect(actions.list_project_items).toMatchObject({
        readOnly: true, risk: 'readonly', confirmation: 'none', idempotent: true,
        scopes: ['github:projects:read'],
      });
      expect(manifest.capabilities.find((capability) => capability.capabilityId === 'actions-ci')?.actions).toEqual([
        'list_workflows', 'list_workflow_runs', 'dispatch_workflow',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GitHub plugin configuration owner', () => {
  test('imports legacy repository config once and keeps subsequent config writes in Repository Registry', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'forge-github-plugin-config-'));
    const repoRoot = join(workspace, 'repo');
    const controllerHome = join(workspace, 'controller-home');
    const previousControllerHome = process.env.FORGE_CONTROLLER_HOME;
    try {
      mkdirSync(repoRoot, { recursive: true });
      const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      expect(initialized.status).toBe(0);
      process.env.FORGE_CONTROLLER_HOME = controllerHome;

      const legacyPath = join(repoRoot, '.forge', 'plugins', 'github.json');
      mkdirSync(join(repoRoot, '.forge', 'plugins'), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({
        enabled: true,
        repository: 'owner/repo',
        labels: ['bug'],
        syncMode: 'checkpoint',
        includeTasks: false,
        projectOwner: 'owner',
        projectNumber: 42,
        statusField: 'Status',
      }));
      const registered = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const canonicalRoot = registered.canonicalRoot;
      const imported = loadGitHubPluginConfig(canonicalRoot);
      expect(imported).toMatchObject({
        enabled: true,
        repository: 'owner/repo',
        labels: ['bug'],
        syncMode: 'checkpoint',
        includeTasks: false,
        projectOwner: 'owner',
        projectNumber: 42,
        statusField: 'Status',
      });
      expect(existsSync(legacyPath)).toBe(false);

      const saved = saveGitHubPluginConfig(canonicalRoot, { syncMode: 'manual', projectNumber: null });
      expect(saved).toMatchObject({
        enabled: true,
        repository: 'owner/repo',
        labels: ['bug'],
        syncMode: 'manual',
        includeTasks: false,
        projectOwner: 'owner',
        statusField: 'Status',
      });
      expect(loadGitHubPluginConfig(canonicalRoot)).toEqual(saved);
      expect(getGitHubPluginStatus(canonicalRoot)).toMatchObject({
        config: saved,
        probed: false,
        available: false,
        ready: false,
      });
    } finally {
      if (previousControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousControllerHome;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});


describe('GitHub Project items read-only projection', () => {
  test('bounded gh project CLI argv and strict owner', () => {
    expect(buildGitHubProjectItemListArgs('moretea-labs', 12, 30)).toEqual([
      'project', 'item-list', '12', '--owner', 'moretea-labs', '--format', 'json', '--limit', '30',
    ]);
    expect(() => buildGitHubProjectItemListArgs('bad\nowner', 12)).toThrow();
    expect(() => buildGitHubProjectItemListArgs('moretea-labs', -2)).toThrow();
    expect(() => buildGitHubProjectItemListArgs('moretea-labs', 3, 101)).toThrow();
  });

  test('keeps exact GitHub statuses and filters other repository items without synthesizing statuses', () => {
    const result = parseGitHubProjectItems({
      totalCount: 4,
      items: [
        { id: 'a', title: 'Zen', status: 'In Progress', content: { number: 644, repository: 'moretea-labs/forge', url: 'https://github.com/moretea-labs/forge/issues/644' } },
        { id: 'b', title: 'Other repo', status: 'Done', content: { number: 9, repository: 'someone/else' } },
        { id: 'c', title: 'Draft', status: 'Backlog' },
        { id: 'd', title: 'No status', content: { number: 15, repository: 'moretea-labs/forge' } },
      ],
    }, 'moretea-labs/forge', 4);
    expect(result.items).toEqual([
      { id: 'a', title: 'Zen', status: 'In Progress', number: 644,
        repository: 'moretea-labs/forge', url: 'https://github.com/moretea-labs/forge/issues/644', isDraft: false },
      { id: 'c', title: 'Draft', status: 'Backlog', isDraft: true },
      { id: 'd', title: 'No status', status: 'Unassigned', number: 15, repository: 'moretea-labs/forge', isDraft: false },
    ]);
    expect(result.truncated).toBe(false);
  });

  test('rejects untrusted/project shape and boundedly signals truncation', () => {
    expect(() => parseGitHubProjectItems({}, 'moretea-labs/forge')).toThrow(/SHAPE_INVALID/);
    const result = parseGitHubProjectItems({
      totalCount: 200,
      items: [{ id: 'id', title: 'Test', status: 'Todo', content: { number: 1, url: 'https://example.com/attack' } }],
    }, 'moretea-labs/forge', 1);
    expect(result.truncated).toBe(true);
    expect(result.items[0].url).toBeUndefined();
  });
});
