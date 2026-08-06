import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listAgentJobs, listPendingIntegrationRuns } from '../../cli/agent-jobs/job-manager';
import { listIssues } from '../../cli/controller/issue-store';
import { listEditSessions } from '../../cli/editing/edit-session';
import { listLocalBridgeJobs } from '../../cli/local-bridge/job-store';
import { validateRepository } from '../../cli/repositories/registry';
import { readForgeRuntimeStatus } from '../control-plane/runtime-status-client';
import { listActiveExecutionJobs } from '../execution/jobs/store';
import type { ExecutionJob } from '../execution/jobs/types';
import { listActiveLeases } from '../resources/leases/store';

export interface ReleaseGateResult {
  releaseReady: boolean;
  checkedAt: string;
  revision: string;
  blockers: Array<{ code: string; message: string; entityId?: string }>;
  warnings: Array<{ code: string; message: string }>;
  checks: Record<string, boolean>;
  manifest: {
    repoId: string;
    revision: string;
    verifiedTaskIds: string[];
    evidenceJobIds: string[];
    packageName?: string;
    packageVersion?: string;
  };
}

function git(repoRoot: string, args: string[]): { ok: boolean; output: string; error: string } {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024 });
  return {
    ok: result.status === 0 && !result.error,
    output: typeof result.stdout === 'string' ? result.stdout.trim() : '',
    error: [typeof result.stderr === 'string' ? result.stderr.trim() : '', result.error instanceof Error ? result.error.message : ''].filter(Boolean).join('\n'),
  };
}

function packageMetadata(repoRoot: string): { valid: boolean; name?: string; version?: string } {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return { valid: true };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown; bin?: unknown };
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;
    const version = typeof parsed.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(parsed.version) ? parsed.version : undefined;
    return { valid: Boolean(name && version && parsed.bin), name, version };
  } catch {
    return { valid: false };
  }
}

export function evaluateReleaseGate(controllerHome: string, repoRoot: string, job: ExecutionJob): ReleaseGateResult {
  const blockers: ReleaseGateResult['blockers'] = [];
  const warnings: ReleaseGateResult['warnings'] = [];
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  const revision = head.output || 'unversioned';
  const status = git(repoRoot, ['status', '--porcelain=v1']);
  const activeJobs = listActiveExecutionJobs(controllerHome, job.repoId).filter((entry) => entry.jobId !== job.jobId);
  const allAgentJobs = listAgentJobs(repoRoot, 5000);
  const agentJobs = allAgentJobs.filter((entry) => ['queued', 'starting', 'running', 'waiting_for_user'].includes(entry.status));
  const pendingIntegrations = listPendingIntegrationRuns(repoRoot, 5000);
  const localJobs = listLocalBridgeJobs(repoRoot, 5000).filter((entry) => ['approved', 'running', 'dispatched'].includes(entry.status));
  const editSessions = listEditSessions(repoRoot, 500).filter((entry) => !['finalized', 'rolled_back'].includes(entry.status));
  const leases = listActiveLeases(controllerHome, job.repoId).filter((entry) => entry.ownerJobId !== job.jobId);
  const repositoryValidation = validateRepository(job.repoId, controllerHome);
  const daemon = readForgeRuntimeStatus(controllerHome);
  const pkg = packageMetadata(repoRoot);
  const issues = listIssues(repoRoot, { includeEphemeral: false });
  const releaseRelevantIssues = issues.filter((issue) => ['planned', 'launch_blocked', 'in_progress', 'review'].includes(issue.status));
  const unfinishedTasks = releaseRelevantIssues.flatMap((issue) => issue.tasks
    .filter((task) => !['done', 'cancelled', 'superseded'].includes(task.status))
    .map((task) => ({ issueId: issue.id, taskId: task.id, status: task.status })));
  const completedTasks = issues.flatMap((issue) => issue.tasks
    .filter((task) => ['verified', 'done'].includes(task.status))
    .map((task) => ({ issueId: issue.id, task })));
  const staleVerificationTasks = revision === 'unversioned' ? [] : completedTasks.filter(({ task }) => {
    const boundRevision = task.verification?.integratedRevision;
    return Boolean(boundRevision && boundRevision !== revision);
  });
  const missingVerificationTasks = completedTasks.filter(({ task }) => task.checks.length > 0 && !task.verification);

  if (!head.ok) blockers.push({ code: 'REVISION_UNAVAILABLE', message: head.error || 'Unable to resolve repository HEAD.' });
  if (!status.ok) blockers.push({ code: 'GIT_STATUS_FAILED', message: status.error || 'Unable to read repository status.' });
  else if (status.output) blockers.push({ code: 'WORKSPACE_DIRTY', message: 'Repository workspace is not clean.' });
  if (activeJobs.length) blockers.push({ code: 'ACTIVE_EXECUTION_JOBS', message: `${activeJobs.length} execution jobs are still active.` });
  if (agentJobs.length) blockers.push({ code: 'ACTIVE_AGENT_RUNS', message: `${agentJobs.length} agent runs are still active.` });
  if (pendingIntegrations.length) blockers.push({ code: 'PENDING_INTEGRATION', message: `${pendingIntegrations.length} successful worktree runs are not integrated.`, entityId: pendingIntegrations[0]?.runId });
  if (localJobs.length) blockers.push({ code: 'ACTIVE_LEGACY_JOBS', message: `${localJobs.length} compatibility Local Jobs are still active.` });
  if (editSessions.length) blockers.push({ code: 'DIRTY_EDIT_SESSIONS', message: `${editSessions.length} Edit Sessions are not finalized or rolled back.`, entityId: editSessions[0]?.sessionId });
  if (leases.length) blockers.push({ code: 'ACTIVE_RESOURCE_LEASES', message: `${leases.length} resource leases are still held.` });
  if (unfinishedTasks.length) blockers.push({ code: 'REQUIRED_TASKS_INCOMPLETE', message: `${unfinishedTasks.length} tasks in active Issues are not terminal.`, entityId: unfinishedTasks[0]?.taskId });
  if (staleVerificationTasks.length) blockers.push({ code: 'VERIFICATION_REVISION_STALE', message: `${staleVerificationTasks.length} completed tasks are verified against a different revision.`, entityId: staleVerificationTasks[0]?.task.id });
  if (missingVerificationTasks.length) blockers.push({ code: 'VERIFICATION_EVIDENCE_MISSING', message: `${missingVerificationTasks.length} completed tasks require persisted verification evidence.`, entityId: missingVerificationTasks[0]?.task.id });
  if (!repositoryValidation.ok) blockers.push({ code: 'REPOSITORY_IDENTITY_INVALID', message: repositoryValidation.errors.join('; ') || 'Repository validation failed.' });
  if (repositoryValidation.registryCanonicalRemote && repositoryValidation.canonicalRemote && repositoryValidation.registryCanonicalRemote !== repositoryValidation.canonicalRemote) {
    blockers.push({ code: 'REGISTRY_REMOTE_DRIFT', message: 'Registry remote differs from Git origin.' });
  }
  if (repositoryValidation.githubMappingMatches === false) blockers.push({ code: 'GITHUB_MAPPING_DRIFT', message: 'GitHub mapping differs from Git origin.' });
  for (const warning of repositoryValidation.warnings) warnings.push({ code: 'REPOSITORY_WARNING', message: warning });
  if (daemon.status !== 'ready') blockers.push({ code: 'FORGE_RUNTIME_NOT_READY', message: `Forge Runtime is ${daemon.status}.` });
  if (!pkg.valid) blockers.push({ code: 'PACKAGE_METADATA_INVALID', message: 'package.json must contain a valid name, semantic version, and bin export.' });

  const checks = {
    revisionResolved: head.ok && revision !== 'unversioned',
    workspaceClean: status.ok && !status.output,
    noActiveExecutionJobs: activeJobs.length === 0,
    noActiveAgentRuns: agentJobs.length === 0,
    noPendingIntegration: pendingIntegrations.length === 0,
    noActiveLegacyJobs: localJobs.length === 0,
    noDirtyEditSessions: editSessions.length === 0,
    noOtherLeases: leases.length === 0,
    allRequiredTasksComplete: unfinishedTasks.length === 0,
    exactRevisionEvidence: staleVerificationTasks.length === 0 && missingVerificationTasks.length === 0,
    repositoryIdentityValid: repositoryValidation.ok,
    registryRemoteMatches: !(repositoryValidation.registryCanonicalRemote && repositoryValidation.canonicalRemote && repositoryValidation.registryCanonicalRemote !== repositoryValidation.canonicalRemote),
    githubMappingMatches: repositoryValidation.githubMappingMatches !== false,
    controllerDaemonReady: daemon.status === 'ready',
    packageMetadataValid: pkg.valid,
  };
  return {
    releaseReady: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    revision,
    blockers,
    warnings,
    checks,
    manifest: {
      repoId: job.repoId,
      revision,
      verifiedTaskIds: completedTasks.filter(({ task }) => task.verification).map(({ task }) => task.id),
      evidenceJobIds: [job.jobId],
      packageName: pkg.name,
      packageVersion: pkg.version,
    },
  };
}
