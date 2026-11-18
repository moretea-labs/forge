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
  buildGitHubProjectIssueDetailArgs,
  parseGitHubProjectIssueDetail,
  buildGitHubProjectIssueTimelineArgs,
  parseGitHubProjectIssueTimeline,
} from '../../src/runtime/plugins/github-client';
import { buildGitHubPluginManifest, executeGitHubPluginAction } from '../../src/runtime/plugins/github-adapter';

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
      expect(actions.read_project_issue).toMatchObject({
        readOnly: true, risk: 'readonly', confirmation: 'none', idempotent: true,
        scopes: ['github:issues:read'],
        argumentsSchema: { required: ['issue_url'] },
      });
      expect(manifest.capabilities.find((capability) => capability.capabilityId === 'actions-ci')?.actions).toEqual([
        'list_workflows', 'list_workflow_runs', 'dispatch_workflow',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GitHub issue plugin mutation boundary', () => {
  test('rejects missing issue identity before any remote sync or controller write', async () => {
    for (const actionId of ['publish_issue', 'refresh_issue', 'close_issue']) {
      await expect(executeGitHubPluginAction({
        controllerHome: '/nonexistent-controller-home',
        repoId: 'test-repo',
        repoRoot: '/nonexistent-repository',
        pluginId: 'github',
        actionId,
        requestId: `empty-issue-${actionId}`,
        origin: { surface: 'system' },
        args: { issue_id: '  ' },
      })).rejects.toThrow('GITHUB_PLUGIN_ISSUE_ID_REQUIRED');
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

  test('returns every Project repository by default and preserves bounded item metadata', () => {
    const payload = {
      totalCount: 4,
      items: [
        { id: 'a', title: 'Zen', status: 'In Progress', assignees: ['greysonOuyang'], fieldValues: [{ name: 'Priority', value: 'P1' }], content: { type: 'Issue', number: 644, repository: 'moretea-labs/forge', url: 'https://github.com/moretea-labs/forge/issues/644', body: 'Acceptance details', labels: [{ name: 'P1' }] } },
        { id: 'b', title: 'Other repo', status: 'Done', assignees: [], content: { type: 'Issue', number: 9, repository: 'someone/else', url: 'https://github.com/someone/else/issues/9', body: 'Other project task', labels: [{ name: 'P2' }] } },
        { id: 'c', title: 'Draft', status: 'Backlog' },
        { id: 'd', title: 'No status', content: { type: 'Issue', number: 15, repository: 'moretea-labs/forge' } },
      ],
    };
    const all = parseGitHubProjectItems(payload, undefined, 4);
    expect(all.items).toEqual([
      { id: 'a', title: 'Zen', status: 'In Progress', contentType: 'Issue', assignees: ['greysonOuyang'], labels: ['P1'], bodyLength: 18, bodyPreview: 'Acceptance details', projectFields: { Priority: 'P1' }, priority: 'P1', number: 644,
        repository: 'moretea-labs/forge', url: 'https://github.com/moretea-labs/forge/issues/644', isDraft: false },
      { id: 'b', title: 'Other repo', status: 'Done', contentType: 'Issue', assignees: [], labels: ['P2'], bodyLength: 18, bodyPreview: 'Other project task', number: 9,
        repository: 'someone/else', url: 'https://github.com/someone/else/issues/9', isDraft: false },
      { id: 'c', title: 'Draft', status: 'Backlog', contentType: 'DraftIssue', assignees: [], labels: [], isDraft: true },
      { id: 'd', title: 'No status', status: 'Unassigned', contentType: 'Issue', assignees: [], labels: [], number: 15, repository: 'moretea-labs/forge', isDraft: false },
    ]);
    expect(all.truncated).toBe(false);
    const forgeOnly = parseGitHubProjectItems(payload, 'moretea-labs/forge', 4);
    expect(forgeOnly.items.map((item) => item.id)).toEqual(['a', 'c', 'd']);
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

describe('GitHub Project Issue detail for migration', () => {
  const url = 'https://github.com/moretea-labs/forge/issues/648';

  test('resolves only exact Issue URLs and keeps repository identity across projects', () => {
    expect(buildGitHubProjectIssueDetailArgs(url)).toEqual([
      'issue', 'view', '648', '--repo', 'moretea-labs/forge', '--json',
      'number,title,body,url,state,stateReason,assignees,labels,createdAt,updatedAt,closedAt,comments',
    ]);
    expect(buildGitHubProjectIssueDetailArgs('https://github.com/moretea-labs/personal-knowledge-assistant/issues/37')[4]).toBe('moretea-labs/personal-knowledge-assistant');
    for (const invalid of [
      'https://github.com/moretea-labs/forge/pull/648',
      'https://github.com/moretea-labs/forge/issues/648?state=closed',
      'https://github.com/moretea-labs/forge/issues/0',
      'https://example.com/moretea-labs/forge/issues/648',
      'https://github.com/moretea-labs/forge/issues/648\n--foo',
    ]) expect(() => buildGitHubProjectIssueDetailArgs(invalid)).toThrow(/GITHUB_PROJECT_ISSUE_URL_INVALID/);
  });

  test('preserves full body, assignees, labels, comment bodies, timestamps and provenance', () => {
    const body = 'A requirement that must not be truncated. '.repeat(60);
    const raw = {
      number: 648, title: 'Migration', body, url, state: 'OPEN', stateReason: null,
      createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', closedAt: null,
      assignees: [{ login: 'greysonOuyang' }], labels: [{ name: 'P0' }],
      comments: [{ body: 'Exact history text', createdAt: '2026-11-13T00:00:00Z',
        url: url + '#issuecomment-1', author: { login: 'reviewer' } }],
    };
    const detail = parseGitHubProjectIssueDetail(raw, url);
    expect(detail).toMatchObject({
      repository: 'moretea-labs/forge', number: 648, title: 'Migration', body,
      state: 'OPEN', assignees: ['greysonOuyang'], labels: ['P0'],
      commentsReturned: 1, historyCoverage: 'comments_snapshot_only',
      comments: [{ body: 'Exact history text', createdAt: '2026-11-13T00:00:00Z',
        author: 'reviewer', url: url + '#issuecomment-1' }],
    });
    expect(detail.body.length).toBeGreaterThan(500);
    expect(() => parseGitHubProjectIssueDetail({ ...raw, number: 649 }, url)).toThrow(/SHAPE_INVALID/);
    expect(() => parseGitHubProjectIssueDetail({ ...raw, comments: [{}] }, url)).toThrow(/COMMENT_INVALID/);
  });
});

describe('GitHub Project Issue paginated timeline', () => {
  const url = 'https://github.com/moretea-labs/forge/issues/648';

  test('uses the source Issue identity and paginates the existing REST timeline', () => {
    expect(buildGitHubProjectIssueTimelineArgs(url)).toEqual([
      'api', '-H', 'Accept: application/vnd.github+json',
      'repos/moretea-labs/forge/issues/648/timeline?per_page=100',
      '--paginate', '--jq', '.[] | @json',
    ]);
    expect(buildGitHubProjectIssueTimelineArgs('https://github.com/moretea-labs/personal-knowledge-assistant/issues/37')[3])
      .toBe('repos/moretea-labs/personal-knowledge-assistant/issues/37/timeline?per_page=100');
  });

  test('preserves each event including unknown properties without dropping page boundaries', () => {
    const first = { event: 'renamed', created_at: '2026-11-01T00:00:00Z',
      rename: { from: 'old title', to: 'new title' }, id: 1 };
    const second = { event: 'cross-referenced', created_at: '2026-11-02T00:00:00Z',
      source: { issue: { number: 8 } }, id: null };
    const result = parseGitHubProjectIssueTimeline(JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n');
    expect(result).toEqual([first, second]);
    expect(parseGitHubProjectIssueTimeline('')).toEqual([]);
    expect(() => parseGitHubProjectIssueTimeline('{"event":"assigned"}\n'))
      .toThrow('GITHUB_PROJECT_ISSUE_TIMELINE_EVENT_INVALID');
    expect(() => parseGitHubProjectIssueTimeline('not JSON\n')).toThrow('gh issue timeline returned invalid JSON');
  });
});
