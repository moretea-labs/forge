import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildGitHubWorkflowDispatchArgs,
  buildGitHubWorkflowListArgs,
  buildGitHubWorkflowRunListArgs,
} from '../../src/cli/github/github';
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
      expect(manifest.capabilities.find((capability) => capability.capabilityId === 'actions-ci')?.actions).toEqual([
        'list_workflows', 'list_workflow_runs', 'dispatch_workflow',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
