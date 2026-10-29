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


/**
 * A read-only, exactly scoped GitHub PR observation. The original Supervisor
 * remains the only event and provider-Send writer; this function never acts on
 * reviews, Work, Git branches, or the provider.
 */
export interface GithubReviewWatchObservation {
  open: boolean;
  headSha: string;
  notices: Array<{
    reviewedHeadSha: string;
    currentHeadSha: string;
    reviewId: string;
    source: 'github_review' | 'github_ci';
    outcome: 'ACCEPT' | 'REVISE' | 'BLOCK' | 'COMMENTED' | 'CI_FAILED' | 'CI_PASSED';
  }>;
}

function exactGithubRepositoryFromRemote(remote: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1];
}

export function classifyGithubReviewNotices(
  reviews: readonly unknown[],
  checks: readonly unknown[],
  currentHeadSha: string,
): GithubReviewWatchObservation['notices'] {
  const notices: GithubReviewWatchObservation['notices'] = [];
  for (const value of reviews) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const review = value as Record<string, unknown>;
    const id = review.id;
    const commitId = review.commit_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)
      || typeof commitId !== 'string' || !/^[0-9a-f]{40}$/i.test(commitId)) continue;
    const outcome = review.state === 'APPROVED' ? 'ACCEPT'
      : review.state === 'CHANGES_REQUESTED' ? 'REVISE'
      : review.state === 'DISMISSED' ? 'BLOCK'
      // COMMENTED is a wake-up signal only; it is never approval or a verdict.
      : review.state === 'COMMENTED' ? 'COMMENTED'
      : undefined;
    if (outcome) notices.push({
      reviewedHeadSha: commitId.toLowerCase(), currentHeadSha: currentHeadSha.toLowerCase(),
      reviewId: 'github-review:' + id, source: 'github_review', outcome,
    });
  }
  for (const value of checks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const check = value as Record<string, unknown>;
    const id = check.id;
    const headSha = check.head_sha;
    if (check.status !== 'completed' || typeof id !== 'number' || !Number.isSafeInteger(id)
      || typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) continue;
    const outcome = check.conclusion === 'success' ? 'CI_PASSED'
      : ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required'].includes(String(check.conclusion))
        ? 'CI_FAILED' : undefined;
    if (outcome) notices.push({
      reviewedHeadSha: headSha.toLowerCase(), currentHeadSha: currentHeadSha.toLowerCase(),
      reviewId: 'github-check:' + id, source: 'github_ci', outcome,
    });
  }
  return notices;
}

export async function observeGithubReviewWatch(input: {
  repoRoot: string; githubRepository: string; prNumber: number;
}): Promise<GithubReviewWatchObservation> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.githubRepository)
    || !Number.isInteger(input.prNumber) || input.prNumber < 1 || input.prNumber > 1_000_000) {
    throw new Error('WORKFLOW_SUPERVISOR_GITHUB_REVIEW_TARGET_INVALID');
  }
  const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
    cwd: input.repoRoot, encoding: 'utf8', timeout: 5_000,
  });
  if (exactGithubRepositoryFromRemote(remote.stdout)?.toLowerCase() !== input.githubRepository.toLowerCase()) {
    throw new Error('WORKFLOW_SUPERVISOR_GITHUB_REVIEW_REMOTE_MISMATCH');
  }
  const gh = resolveGithubIssueWatchExecutable({});
  const read = async (path: string): Promise<any> => {
    const result = await execFileAsync(gh, ['api', '-H', 'Accept: application/vnd.github+json', path], {
      cwd: input.repoRoot, encoding: 'utf8', timeout: 12_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(String(result.stdout));
  };
  const base = 'repos/' + input.githubRepository;
  const pull = await read(base + '/pulls/' + input.prNumber);
  const currentHeadSha = pull?.head?.sha;
  if (typeof currentHeadSha !== 'string' || !/^[0-9a-f]{40}$/i.test(currentHeadSha)) {
    throw new Error('WORKFLOW_SUPERVISOR_GITHUB_REVIEW_HEAD_UNVERIFIED');
  }
  if (pull.state !== 'open') return { open: false, headSha: currentHeadSha, notices: [] };
  const reviews = await read(base + '/pulls/' + input.prNumber + '/reviews?per_page=100');
  const checks = await read(base + '/commits/' + currentHeadSha + '/check-runs?per_page=100');
  if (!Array.isArray(reviews) || !Array.isArray(checks?.check_runs)) {
    throw new Error('WORKFLOW_SUPERVISOR_GITHUB_REVIEW_RESPONSE_INVALID');
  }
  const notices = classifyGithubReviewNotices(reviews, checks.check_runs, currentHeadSha);
  return { open: true, headSha: currentHeadSha.toLowerCase(), notices };
}
