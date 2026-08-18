import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveTrustedExecutable } from '../../shared/trusted-executable';

const execFileAsync = promisify(execFile);

export interface GithubIssueWatchIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updatedAt: string;
  url: string;
}

export interface GithubIssueWatchState {
  schemaVersion: 1;
  observedAt: string;
  signatures: Record<string, string>;
}

export interface GithubIssueWatchObservation {
  status: 'baseline' | 'unchanged' | 'changed';
  shouldWake: boolean;
  changedOpenIssues: GithubIssueWatchIssue[];
  issues: GithubIssueWatchIssue[];
  nextState: GithubIssueWatchState;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.trunc(value), max))
    : fallback;
}

function issueSignature(issue: GithubIssueWatchIssue): string {
  return `${issue.state}:${issue.updatedAt}`;
}

function normalizeIssue(value: unknown): GithubIssueWatchIssue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const number = typeof record.number === 'number' && Number.isFinite(record.number) ? Math.trunc(record.number) : undefined;
  const title = stringValue(record.title);
  const state = record.state === 'open' || record.state === 'closed' ? record.state : undefined;
  const updatedAt = stringValue(record.updatedAt);
  const url = stringValue(record.url);
  if (!number || !title || !state || !updatedAt || !url) return undefined;
  return { number, title, state, updatedAt, url };
}

export function normalizeGithubIssueWatchState(value: unknown): GithubIssueWatchState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const signaturesValue = record.signatures;
  if (!signaturesValue || typeof signaturesValue !== 'object' || Array.isArray(signaturesValue)) return undefined;
  const signatures = Object.fromEntries(Object.entries(signaturesValue as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return {
    schemaVersion: 1,
    observedAt: stringValue(record.observedAt) ?? new Date(0).toISOString(),
    signatures,
  };
}

export function classifyGithubIssueWatchObservation(
  issues: GithubIssueWatchIssue[],
  previousState: GithubIssueWatchState | undefined,
  options: { since?: string; wakeOnFirstObservation?: boolean; observedAt?: string } = {},
): GithubIssueWatchObservation {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const signatures = Object.fromEntries(issues.map((issue) => [String(issue.number), issueSignature(issue)]));
  const firstObservation = !previousState;
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  const changedOpenIssues = issues.filter((issue) => {
    if (issue.state !== 'open') return false;
    if (!firstObservation) return previousState.signatures[String(issue.number)] !== issueSignature(issue);
    if (options.wakeOnFirstObservation === true) return true;
    return Number.isFinite(sinceMs) && Date.parse(issue.updatedAt) > sinceMs;
  });
  return {
    status: firstObservation ? 'baseline' : changedOpenIssues.length > 0 ? 'changed' : 'unchanged',
    shouldWake: changedOpenIssues.length > 0,
    changedOpenIssues,
    issues,
    nextState: { schemaVersion: 1, observedAt, signatures },
  };
}

const DEFAULT_GH_EXECUTABLE_CANDIDATES = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
] as const;

export function resolveGithubIssueWatchExecutable(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  preferredPaths: readonly string[] = DEFAULT_GH_EXECUTABLE_CANDIDATES,
): string {
  const configured = stringValue(args.gh_executable) ?? stringValue(env.FORGE_GH_EXECUTABLE);
  const resolved = resolveTrustedExecutable({
    name: 'gh',
    configured,
    preferredPaths,
    env,
  });
  if (resolved.configuredInvalid) {
    throw new Error('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_INVALID: gh_executable/FORGE_GH_EXECUTABLE must be an absolute executable path.');
  }
  if (!resolved.executable) {
    throw new Error('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_NOT_FOUND: GitHub CLI was not found in trusted Homebrew/system locations or PATH.');
  }
  return resolved.executable;
}

export async function executeScheduledGithubIssueWatch(input: {
  repoRoot: string;
  args: Record<string, unknown>;
  observedAt?: string;
}): Promise<GithubIssueWatchObservation> {
  const repository = stringValue(input.args.github_repository);
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('SCHEDULE_GITHUB_ISSUE_WATCH_REPOSITORY_REQUIRED');
  }
  const limit = boundedNumber(input.args.issue_limit, 50, 10, 100);
  const timeoutMs = boundedNumber(input.args.timeout_ms, 15_000, 1_000, 60_000);
  try {
    const ghExecutable = resolveGithubIssueWatchExecutable(input.args);
    const result = await execFileAsync(ghExecutable, [
      'api',
      '-H', 'Accept: application/vnd.github+json',
      `repos/${repository}/issues?state=all&sort=updated&direction=desc&per_page=${limit}`,
      '--jq', 'map(select(.pull_request|not)) | map({number,title,state,updatedAt:.updated_at,url:.html_url})',
    ], {
      cwd: input.repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(result.stdout)) as unknown;
    if (!Array.isArray(parsed)) throw new Error('GitHub issue response was not an array.');
    const issues = parsed.map(normalizeIssue).filter((issue): issue is GithubIssueWatchIssue => Boolean(issue));
    const previousState = normalizeGithubIssueWatchState(input.args.issue_watch_state);
    return classifyGithubIssueWatchObservation(issues, previousState, {
      since: stringValue(input.args.issue_watch_since),
      wakeOnFirstObservation: input.args.wake_on_first_observation === true,
      observedAt: input.observedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_')) throw error;
    throw new Error(`SCHEDULE_GITHUB_ISSUE_WATCH_FAILED: ${message}`);
  }
}
