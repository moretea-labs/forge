import {
  closeIssueWithGitHubPlugin,
  getGitHubPluginStatus,
  githubPluginConfigPath,
  loadGitHubPluginConfig,
  publishIssueWithGitHubPlugin,
  refreshIssueWithGitHubPlugin,
  saveGitHubPluginConfig,
} from '../../cli/github/plugin';
import {
  dispatchGitHubWorkflow,
  listGitHubWorkflowRuns,
  listGitHubWorkflows,
} from '../../cli/github/github';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';

const GITHUB_PLUGIN_ID = 'github';

function now(): string {
  return new Date().toISOString();
}

function githubPermissions(ready: boolean, projectConfigured: boolean): AssistantPluginPermissionScope[] {
  return [
    {
      scope: 'github:issues:write',
      mode: 'write',
      description: 'Create, refresh, and close linked GitHub issues.',
      granted: ready,
      required: true,
    },
    {
      scope: 'github:projects:write',
      mode: 'write',
      description: 'Add linked issues to a configured GitHub Project.',
      granted: ready && projectConfigured,
      required: projectConfigured,
    },
    {
      scope: 'github:actions:read',
      mode: 'read',
      description: 'List GitHub Actions workflows and recent workflow runs.',
      granted: ready,
      required: false,
    },
    {
      scope: 'github:actions:write',
      mode: 'write',
      description: 'Dispatch an explicitly named workflow_dispatch workflow.',
      granted: ready,
      required: false,
    },
    {
      scope: 'controller:issues:write',
      mode: 'write',
      description: 'Persist linked GitHub metadata back into controller issue state.',
      granted: true,
      required: true,
    },
  ];
}

function githubCapabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'issue-sync',
      title: 'Issue Sync',
      description: 'Mirror controller issues and task metadata into GitHub issues.',
      scopes: ['github:issues:write', 'controller:issues:write'],
      actions: ['configure', 'publish_issue', 'refresh_issue', 'close_issue'],
    },
    {
      capabilityId: 'project-sync',
      title: 'Project Sync',
      description: 'Attach published issues to a configured GitHub Project when project settings exist.',
      scopes: ['github:projects:write'],
      actions: ['configure', 'publish_issue'],
    },
    {
      capabilityId: 'actions-ci',
      title: 'GitHub Actions CI',
      description: 'List workflow definitions and runs, and dispatch an explicitly named workflow_dispatch workflow.',
      scopes: ['github:actions:read', 'github:actions:write'],
      actions: ['list_workflows', 'list_workflow_runs', 'dispatch_workflow'],
    },
  ];
}

function githubActions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure',
      title: 'Configure GitHub plugin',
      description: 'Enable or update the authoritative GitHub plugin configuration.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['controller:issues:write'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          repository: { type: 'string' },
          clear_repository: { type: 'boolean' },
          sync_mode: { type: 'string', enum: ['manual', 'checkpoint'] },
          include_tasks: { type: 'boolean' },
          project_owner: { type: 'string' },
          project_number: { type: 'number' },
          clear_project: { type: 'boolean' },
          status_field: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'publish_issue',
      title: 'Publish controller issue',
      description: 'Create or update the linked GitHub issue for one controller issue.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['github:issues:write', 'github:projects:write', 'controller:issues:write'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          issue_id: { type: 'string' },
        },
        required: ['issue_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'refresh_issue',
      title: 'Refresh linked GitHub issue',
      description: 'Refresh linked GitHub issue metadata back into controller issue state.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['github:issues:write', 'controller:issues:write'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          issue_id: { type: 'string' },
        },
        required: ['issue_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_workflows',
      title: 'List GitHub Actions workflows',
      description: 'List workflow definitions for the configured GitHub repository.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['github:actions:read'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 100 },
          include_disabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_workflow_runs',
      title: 'List GitHub Actions runs',
      description: 'List recent GitHub Actions workflow runs with optional workflow, branch, and status filters.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['github:actions:read'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          branch: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
          include_disabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'dispatch_workflow',
      title: 'Dispatch GitHub Actions workflow',
      description: 'Create a workflow_dispatch event for one explicitly named workflow.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['github:actions:write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          ref: { type: 'string' },
          inputs: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        },
        required: ['workflow'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'close_issue',
      title: 'Close linked GitHub issue',
      description: 'Close the linked GitHub issue after controller acceptance.',
      readOnly: false,
      risk: 'destructive',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'close-github-issue',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: true,
      scopes: ['github:issues:write', 'controller:issues:write'],
      resourceClaims: [
        { resource: 'remote', mode: 'exclusive' },
        { resource: 'repo-state', mode: 'write' },
      ],
      argumentsSchema: {
        type: 'object',
        properties: {
          issue_id: { type: 'string' },
        },
        required: ['issue_id'],
        additionalProperties: false,
      },
    },
  ];
}

export function buildGitHubPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const config = loadGitHubPluginConfig(repoRoot ?? process.cwd());
  const status = getGitHubPluginStatus(repoRoot ?? process.cwd());
  const projectConfigured = Boolean(config.projectOwner && config.projectNumber);
  const lifecycleState = !config.enabled
    ? 'disabled'
    : status.ready
      ? 'enabled'
      : status.errors.length > 0
        ? 'error'
        : 'degraded';
  const healthState = !config.enabled
    ? 'disabled'
    : status.ready
      ? 'ready'
      : status.errors.length > 0
        ? 'error'
        : 'degraded';
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: GITHUB_PLUGIN_ID,
    provider: 'github',
    displayName: 'GitHub Issue and Project Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: ['repository-registry:github', `repo-local:${githubPluginConfigPath()}`],
    },
    enabled: config.enabled,
    lifecycle: {
      state: lifecycleState,
      reason: !config.enabled
        ? 'GitHub plugin is disabled.'
        : status.ready
          ? 'GitHub CLI authentication and repository mapping are ready.'
          : status.errors[0] ?? status.warnings[0],
    },
    health: {
      state: healthState,
      checkedAt: now(),
      ready: status.ready,
      probed: status.probed,
      errors: [...status.errors],
      warnings: [...status.warnings],
      details: {
        repository: status.repository ?? config.repository,
        authenticated: status.authenticated,
        available: status.available,
        capabilities: status.capabilities,
      },
    },
    permissions: githubPermissions(status.ready, projectConfigured),
    capabilities: githubCapabilities(),
    actions: githubActions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeGitHubPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveGitHubPluginConfig(input.repoRoot, {
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        repository: args.clear_repository === true ? '' : typeof args.repository === 'string' ? args.repository : undefined,
        syncMode: args.sync_mode === 'checkpoint' ? 'checkpoint' : args.sync_mode === 'manual' ? 'manual' : undefined,
        includeTasks: typeof args.include_tasks === 'boolean' ? args.include_tasks : undefined,
        projectOwner: args.clear_project === true ? '' : typeof args.project_owner === 'string' ? args.project_owner : undefined,
        projectNumber: args.clear_project === true ? null : typeof args.project_number === 'number' ? args.project_number : undefined,
        statusField: typeof args.status_field === 'string' ? args.status_field : undefined,
      });
      return { config, status: getGitHubPluginStatus(input.repoRoot) };
    }
    case 'publish_issue':
      return { issue: publishIssueWithGitHubPlugin(input.repoRoot, String(input.args.issue_id ?? '').trim()) };
    case 'refresh_issue':
      return refreshIssueWithGitHubPlugin(input.repoRoot, String(input.args.issue_id ?? '').trim()) as Record<string, unknown>;
    case 'list_workflows': {
      const config = loadGitHubPluginConfig(input.repoRoot);
      return {
        workflows: listGitHubWorkflows(input.repoRoot, config.repository, {
          limit: typeof input.args.limit === 'number' ? input.args.limit : undefined,
          includeDisabled: input.args.include_disabled === true,
        }),
      };
    }
    case 'list_workflow_runs': {
      const config = loadGitHubPluginConfig(input.repoRoot);
      return {
        runs: listGitHubWorkflowRuns(input.repoRoot, config.repository, {
          workflow: typeof input.args.workflow === 'string' ? input.args.workflow : undefined,
          branch: typeof input.args.branch === 'string' ? input.args.branch : undefined,
          status: typeof input.args.status === 'string' ? input.args.status : undefined,
          limit: typeof input.args.limit === 'number' ? input.args.limit : undefined,
          includeDisabled: input.args.include_disabled === true,
        }),
      };
    }
    case 'dispatch_workflow': {
      const config = loadGitHubPluginConfig(input.repoRoot);
      return dispatchGitHubWorkflow(input.repoRoot, config.repository, {
        workflow: String(input.args.workflow ?? ''),
        ref: typeof input.args.ref === 'string' ? input.args.ref : undefined,
        inputs: input.args.inputs && typeof input.args.inputs === 'object' && !Array.isArray(input.args.inputs)
          ? input.args.inputs as Record<string, string | number | boolean>
          : undefined,
      });
    }
    case 'close_issue':
      return { issue: closeIssueWithGitHubPlugin(input.repoRoot, String(input.args.issue_id ?? '').trim()) };
    default:
      throw new Error(`PLUGIN_ACTION_NOT_SUPPORTED: github/${input.actionId}`);
  }
}

export const githubPluginAdapter = {
  pluginId: GITHUB_PLUGIN_ID,
  buildManifest: buildGitHubPluginManifest,
  executeAction: executeGitHubPluginAction,
};
