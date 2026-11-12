import { runProcess } from '../../effects/process-runner';
import { repositoryChildProcessEnvironment } from '../shared/process-environment';

export interface GitHubRepositoryInfo {
  nameWithOwner: string;
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  repository?: GitHubRepositoryInfo;
  agentTaskSupported: boolean;
  errors: string[];
}


export interface GitHubWorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GitHubWorkflowRunInfo {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  status: string;
  conclusion?: string;
  event: string;
  headBranch: string;
  headSha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubWorkflowRunQuery {
  workflow?: string;
  branch?: string;
  status?: string;
  limit?: number;
  includeDisabled?: boolean;
}

export interface GitHubWorkflowDispatchInput {
  workflow: string;
  ref?: string;
  inputs?: Record<string, string | number | boolean>;
}

export function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; } catch (error) { throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseRepo(value: string): { owner: string; repo: string } {
  const normalized = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^git@github\.com:/, '');
  const [owner, repo, ...rest] = normalized.split('/');
  if (!owner || !repo || rest.length) throw new Error(`invalid GitHub repository: ${value}`);
  return { owner, repo };
}

function repositoryName(value: string): string {
  const parsed = parseRepo(value);
  return `${parsed.owner}/${parsed.repo}`;
}

function boundedWorkflowLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('GITHUB_WORKFLOW_LIMIT_INVALID: limit must be an integer between 1 and 100');
  return value;
}

function boundedSingleLine(value: unknown, label: string, maxLength = 256): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim();
  if (normalized.length > maxLength || /[\r\n\0]/.test(normalized)) throw new Error(`${label} must be a bounded single-line value`);
  return normalized;
}

export function buildGitHubWorkflowListArgs(repository: string, input: { limit?: number; includeDisabled?: boolean } = {}): string[] {
  const args = ['workflow', 'list', '--repo', repositoryName(repository), '--json', 'id,name,path,state', '--limit', String(boundedWorkflowLimit(input.limit, 50))];
  if (input.includeDisabled === true) args.push('--all');
  return args;
}

export function buildGitHubWorkflowRunListArgs(repository: string, input: GitHubWorkflowRunQuery = {}): string[] {
  const args = [
    'run', 'list', '--repo', repositoryName(repository),
    '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt',
    '--limit', String(boundedWorkflowLimit(input.limit, 20)),
  ];
  const workflow = boundedSingleLine(input.workflow, 'workflow');
  const branch = boundedSingleLine(input.branch, 'branch');
  const status = boundedSingleLine(input.status, 'status');
  if (workflow) args.push('--workflow', workflow);
  if (branch) args.push('--branch', branch);
  if (status) args.push('--status', status);
  if (input.includeDisabled === true) args.push('--all');
  return args;
}

export function buildGitHubWorkflowDispatchArgs(repository: string, input: GitHubWorkflowDispatchInput): string[] {
  const workflow = boundedSingleLine(input.workflow, 'workflow');
  if (!workflow) throw new Error('GITHUB_WORKFLOW_REQUIRED: workflow is required');
  const args = ['workflow', 'run', workflow, '--repo', repositoryName(repository)];
  const ref = boundedSingleLine(input.ref, 'ref');
  if (ref) args.push('--ref', ref);
  const entries = Object.entries(input.inputs ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 20) throw new Error('GITHUB_WORKFLOW_INPUTS_INVALID: at most 20 inputs are allowed');
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new Error(`GITHUB_WORKFLOW_INPUT_KEY_INVALID: ${key}`);
    const value = boundedSingleLine(rawValue, `workflow input ${key}`, 8192);
    if (value === undefined) throw new Error(`GITHUB_WORKFLOW_INPUT_VALUE_INVALID: ${key}`);
    args.push('--raw-field', `${key}=${value}`);
  }
  return args;
}

export function gh(repoRoot: string, args: string[], input?: string, maxOutputBytes = 512 * 1024) {
  return runProcess('gh', args, {
    cwd: repoRoot,
    timeoutMs: 120_000,
    maxOutputBytes,
    input,
    env: repositoryChildProcessEnvironment(),
  });
}

export function resolveGitHubRepository(repoRoot: string, explicitRepo?: string): GitHubRepositoryInfo {
  const args = ['repo', 'view'];
  if (explicitRepo?.trim()) args.push(explicitRepo.trim());
  args.push('--json', 'nameWithOwner,url,defaultBranchRef');
  const result = gh(repoRoot, args);
  if (!result.ok) throw new Error(`failed to resolve GitHub repository: ${result.error || result.stderr}`);
  const payload = parseJson<{ nameWithOwner: string; url: string; defaultBranchRef?: { name?: string } }>(result.stdout, 'gh repo view');
  const { owner, repo } = parseRepo(payload.nameWithOwner);
  return {
    nameWithOwner: `${owner}/${repo}`,
    owner,
    repo,
    url: payload.url,
    defaultBranch: payload.defaultBranchRef?.name || 'main',
  };
}


export interface GitHubProjectBoardItem {
  id: string;
  title: string;
  status: string;
  number?: number;
  url?: string;
  repository?: string;
  isDraft: boolean;
}

export function buildGitHubProjectItemListArgs(owner: string, projectNumber: number, limit = 100): string[] {
  const safeOwner = boundedSingleLine(owner, 'GitHub project owner', 80);
  if (!safeOwner || !/^[A-Za-z0-9-]{1,80}$/.test(safeOwner)) {
    throw new Error('GITHUB_PROJECT_OWNER_INVALID');
  }
  if (!Number.isInteger(projectNumber) || projectNumber < 1 || projectNumber > 1_000_000) {
    throw new Error('GITHUB_PROJECT_NUMBER_INVALID');
  }
  return ['project', 'item-list', String(projectNumber), '--owner', safeOwner,
    '--format', 'json', '--limit', String(boundedWorkflowLimit(limit, 100))];
}

export function parseGitHubProjectItems(
  payload: unknown,
  repository: string,
  limit = 100,
): { items: GitHubProjectBoardItem[]; truncated: boolean } {
  const target = repositoryName(repository).toLowerCase();
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  if (!Array.isArray(value.items)) throw new Error('GITHUB_PROJECT_ITEMS_SHAPE_INVALID');
  const raw = value.items.slice(0, limit);
  const items = raw.flatMap((candidate): GitHubProjectBoardItem[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    const content = row.content && typeof row.content === 'object' && !Array.isArray(row.content)
      ? row.content as Record<string, unknown> : {};
    const repositoryNameValue = typeof content.repository === 'string'
      ? content.repository
      : typeof content.repositoryNameWithOwner === 'string'
        ? content.repositoryNameWithOwner : undefined;
    if (repositoryNameValue && repositoryNameValue.toLowerCase() !== target) return [];
    const itemId = typeof row.id === 'string' ? row.id : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!itemId || !title) return [];
    const rawStatus = typeof row.status === 'string' ? row.status.trim() : '';
    const status = rawStatus || 'Unassigned';
    const number = typeof content.number === 'number' && Number.isSafeInteger(content.number) && content.number >= 1
      ? content.number : undefined;
    const url = typeof content.url === 'string' && /^https:\/\/github\.com\//.test(content.url) ? content.url : undefined;
    return [{
      id: itemId.slice(0, 200), title: title.slice(0, 240), status: status.slice(0, 80),
      ...(number ? { number } : {}),
      ...(url ? { url } : {}),
      ...(repositoryNameValue ? { repository: repositoryNameValue } : {}),
      isDraft: !number,
    }];
  });
  const count = typeof value.totalCount === 'number' ? value.totalCount : value.items.length;
  return { items, truncated: count > raw.length };
}

export function readGitHubProjectItems(
  repoRoot: string, repository: string, owner: string, projectNumber: number, limit = 100,
) {
  const result = gh(repoRoot, buildGitHubProjectItemListArgs(owner, projectNumber, limit));
  if (!result.ok) throw new Error('failed to read GitHub Project: ' + (result.error || result.stderr));
  const data = parseJson<unknown>(result.stdout, 'gh project item-list');
  return parseGitHubProjectItems(data, repository, limit);
}

export function listGitHubWorkflows(
  repoRoot: string,
  explicitRepo?: string,
  input: { limit?: number; includeDisabled?: boolean } = {},
): GitHubWorkflowInfo[] {
  const repository = explicitRepo?.trim() ? repositoryName(explicitRepo) : resolveGitHubRepository(repoRoot).nameWithOwner;
  const result = gh(repoRoot, buildGitHubWorkflowListArgs(repository, input));
  if (!result.ok) throw new Error(`failed to list GitHub workflows: ${result.error || result.stderr}`);
  return parseJson<GitHubWorkflowInfo[]>(result.stdout, 'gh workflow list');
}

export function listGitHubWorkflowRuns(
  repoRoot: string,
  explicitRepo?: string,
  input: GitHubWorkflowRunQuery = {},
): GitHubWorkflowRunInfo[] {
  const repository = explicitRepo?.trim() ? repositoryName(explicitRepo) : resolveGitHubRepository(repoRoot).nameWithOwner;
  const result = gh(repoRoot, buildGitHubWorkflowRunListArgs(repository, input));
  if (!result.ok) throw new Error(`failed to list GitHub workflow runs: ${result.error || result.stderr}`);
  return parseJson<GitHubWorkflowRunInfo[]>(result.stdout, 'gh run list');
}

export function dispatchGitHubWorkflow(
  repoRoot: string,
  explicitRepo: string | undefined,
  input: GitHubWorkflowDispatchInput,
): Record<string, unknown> {
  const repository = explicitRepo?.trim() ? repositoryName(explicitRepo) : resolveGitHubRepository(repoRoot).nameWithOwner;
  const result = gh(repoRoot, buildGitHubWorkflowDispatchArgs(repository, input), undefined, 128 * 1024);
  if (!result.ok) throw new Error(`failed to dispatch GitHub workflow: ${result.error || result.stderr}`);
  const output = result.stdout.trim();
  return {
    repository,
    workflow: input.workflow,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    inputs: input.inputs ?? {},
    ...(output ? { output } : {}),
    ...(/^https:\/\//i.test(output) ? { runUrl: output } : {}),
  };
}
