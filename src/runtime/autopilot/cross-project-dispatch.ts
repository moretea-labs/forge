import { cpus, freemem, loadavg, totalmem } from 'os';
import { listCanonicalGrants, readForgeInstanceIdentity } from '../../../packages/kernel/identity/api';
import type { RepositoryRecord } from '../../core/repository/types';
import {
  selectCrossProjectRequirementCandidates,
  type CrossProjectRequirementDispatchSelection,
} from '../control-plane/facade/cross-project-requirement-dispatch';
import { listProjectPlacements } from '../control-plane/workspace/workspace-store';
import { repositoryCheckoutLifecycle } from '../repositories/registry';
import { readAutopilotRun } from './store';
import { activeAutopilotLoopCount, isAutopilotLoopActive, resumeAutopilot, startAutopilot } from './service';

const AUTOPILOT_CAPABILITY = 'autopilot:execute';
const GIB = 1024 ** 3;

export interface AutopilotHostResourceSample {
  cpuCount: number;
  load1: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
}

export function sampleAutopilotHostResources(): AutopilotHostResourceSample {
  return {
    cpuCount: cpus().length,
    load1: loadavg()[0] ?? Number.NaN,
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
  };
}

/**
 * Reserve one CPU core and at least 2 GiB / 20% of RAM for the foreground
 * Runtime. Each additional model loop receives a conservative 1 GiB budget.
 * Unknown host metrics fail closed; there is no fixed global worker count.
 */
export function availableAutopilotDispatchSlots(input: {
  sample: AutopilotHostResourceSample;
  activeLoops: number;
}): number {
  const { cpuCount, load1, freeMemoryBytes, totalMemoryBytes } = input.sample;
  if (
    !Number.isInteger(cpuCount) ||
    cpuCount < 1 ||
    !Number.isFinite(load1) ||
    load1 < 0 ||
    !Number.isFinite(freeMemoryBytes) ||
    freeMemoryBytes < 0 ||
    !Number.isFinite(totalMemoryBytes) ||
    totalMemoryBytes <= 0 ||
    freeMemoryBytes > totalMemoryBytes ||
    !Number.isFinite(input.activeLoops) ||
    input.activeLoops < 0
  ) {
    return 0;
  }
  const cpuSlots = Math.floor(Math.max(0, cpuCount - load1 - 1));
  const memoryReserve = Math.max(2 * GIB, totalMemoryBytes * 0.2);
  const memorySlots = Math.floor(Math.max(0, freeMemoryBytes - memoryReserve) / GIB);
  return Math.max(0, Math.min(cpuSlots, memorySlots) - Math.trunc(input.activeLoops));
}

type CanonicalGrant = ReturnType<typeof listCanonicalGrants>[number];

export interface CrossProjectAutopilotDispatchDecision {
  requirementId: string;
  projectId: string;
  repoId?: string;
  outcome:
    | 'started'
    | 'resumed'
    | 'already_running'
    | 'not_authorized'
    | 'stale_authorization'
    | 'checkout_unavailable'
    | 'run_paused'
    | 'run_blocked'
    | 'run_terminal'
    | 'capacity'
    | 'dispatch_failed';
  detail?: string;
}

export interface CrossProjectAutopilotDispatchResult {
  selection: CrossProjectRequirementDispatchSelection;
  hostSlots: number;
  activeLoopsAtStart: number;
  startedRequirementIds: string[];
  resumedRequirementIds: string[];
  decisions: CrossProjectAutopilotDispatchDecision[];
}

export interface CrossProjectAutopilotDispatchDependencies {
  selectCandidates?: typeof selectCrossProjectRequirementCandidates;
  listGrants?: typeof listCanonicalGrants;
  listPlacements?: (controllerHome: string) => Array<{
    projectId: string;
    repositoryId: string;
    checkoutId?: string;
  }>;
  sampleHostResources?: () => AutopilotHostResourceSample;
  activeLoopCount?: () => number;
  isLoopActive?: typeof isAutopilotLoopActive;
  readRun?: typeof readAutopilotRun;
  start?: typeof startAutopilot;
  resume?: typeof resumeAutopilot;
}

function ownerScope(repoId: string, requirementId: string): string {
  return `forge-autopilot:${repoId}:${requirementId}`;
}

function activeRequirementGrants(grants: CanonicalGrant[], nowMs: number): Map<string, CanonicalGrant> {
  const result = new Map<string, CanonicalGrant>();
  for (const grant of [...grants].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const expiresAt = Date.parse(grant.expiresAt);
    if (
      !grant.ownerScope ||
      grant.revokedAt ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= nowMs ||
      !grant.capabilities.includes(AUTOPILOT_CAPABILITY)
    )
      continue;
    if (!result.has(grant.ownerScope)) result.set(grant.ownerScope, grant);
  }
  return result;
}

function placementSnapshot(controllerHome: string): Array<{
  projectId: string;
  repositoryId: string;
  checkoutId?: string;
}> {
  const instance = readForgeInstanceIdentity(controllerHome);
  if (!instance) return [];
  return listProjectPlacements(controllerHome, instance.instanceId).map(({ value }) => ({
    projectId: value.projectId,
    repositoryId: value.repositoryId,
    ...(value.checkoutId ? { checkoutId: value.checkoutId } : {}),
  }));
}

function grantRiskAllowsWorkspaceWrite(grant: CanonicalGrant): boolean {
  return (
    grant.riskCeiling === 'workspace_write' ||
    grant.riskCeiling === 'remote_write' ||
    grant.riskCeiling === 'destructive'
  );
}

type DispatchOutcome = CrossProjectAutopilotDispatchDecision['outcome'];
type ProjectPlacementSnapshot = ReturnType<typeof placementSnapshot>[number];

function decisionFor(
  candidate: CrossProjectRequirementDispatchSelection['ready'][number],
  repoId: string | undefined,
  outcome: DispatchOutcome,
  detail?: string,
): CrossProjectAutopilotDispatchDecision {
  return {
    requirementId: candidate.requirementId,
    projectId: candidate.projectId,
    ...(repoId ? { repoId } : {}),
    outcome,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
  };
}

function candidateRepositoryId(
  candidate: CrossProjectRequirementDispatchSelection['ready'][number],
  placement: ProjectPlacementSnapshot | undefined,
): string | undefined {
  if (candidate.repoId && placement && placement.repositoryId !== candidate.repoId) return undefined;
  return candidate.repoId ?? placement?.repositoryId;
}

function authorizedCandidateGrant(input: {
  candidate: CrossProjectRequirementDispatchSelection['ready'][number];
  repoId: string;
  placement?: ProjectPlacementSnapshot;
  grants: Map<string, CanonicalGrant>;
  repositories: Map<string, RepositoryRecord>;
}): { grant?: CanonicalGrant; outcome?: DispatchOutcome; detail?: string } {
  const { candidate, repoId, placement, grants, repositories } = input;
  const grant = grants.get(ownerScope(repoId, candidate.requirementId));
  if (!grant) {
    return {
      outcome: 'not_authorized',
      detail: 'No active autopilot:execute grant for this exact Requirement and Repository.',
    };
  }
  if (
    grant.target?.kind !== 'requirement' ||
    grant.target.id !== candidate.requirementId ||
    grant.target.repoId !== repoId ||
    !grantRiskAllowsWorkspaceWrite(grant)
  ) {
    return {
      outcome: 'stale_authorization',
      detail: 'Grant target or risk ceiling does not match this Requirement.',
    };
  }
  const checkoutId = String(grant.constraints?.checkoutId ?? '').trim();
  const repository = repositories.get(repoId);
  const checkout = repository?.checkouts.find(
    (entry) => entry.checkoutId === checkoutId && repositoryCheckoutLifecycle(entry) === 'active',
  );
  if (!repository || !checkout || (placement?.checkoutId && placement.checkoutId !== checkoutId)) {
    return {
      outcome: 'checkout_unavailable',
      detail: 'The exact grant checkout is not an active registered placement.',
    };
  }
  if (Number(grant.constraints?.requirementRevision) !== candidate.requirementRevision) {
    return {
      outcome: 'stale_authorization',
      detail: 'Requirement semantic revision changed after authorization; explicit reapproval is required.',
    };
  }
  return { grant };
}

function dispatchCandidateRun(input: {
  controllerHome: string;
  candidate: CrossProjectRequirementDispatchSelection['ready'][number];
  repoId: string;
  grant: CanonicalGrant;
  remainingSlots: number;
  readRun: typeof readAutopilotRun;
  isLoopActive: typeof isAutopilotLoopActive;
  start: typeof startAutopilot;
  resume: typeof resumeAutopilot;
}): { outcome: DispatchOutcome; detail?: string; started?: boolean; resumed?: boolean } {
  const { controllerHome, candidate, repoId, grant, remainingSlots, readRun, isLoopActive, start, resume } = input;
  const existing = readRun(controllerHome, repoId, candidate.requirementId);
  if (existing && existing.value.grantId !== grant.grantId) {
    return { outcome: 'stale_authorization', detail: 'Persisted AutopilotRun belongs to a superseded grant.' };
  }
  if (existing && existing.value.status !== 'running') {
    const status = existing.value.status;
    return {
      outcome: status === 'paused' ? 'run_paused' : status === 'blocked' ? 'run_blocked' : 'run_terminal',
      detail: status,
    };
  }
  if (existing && isLoopActive(controllerHome, repoId, candidate.requirementId)) {
    return { outcome: 'already_running' };
  }
  if (remainingSlots <= 0) {
    return { outcome: 'capacity', detail: 'Host CPU or memory headroom is exhausted.' };
  }
  try {
    if (existing) {
      resume({ controllerHome, repoId, requirementId: candidate.requirementId });
      return { outcome: 'resumed', resumed: true };
    }
    start({
      controllerHome,
      repoId,
      requirementId: candidate.requirementId,
      dispatchSource: 'global_scheduler',
    });
    return { outcome: 'started', started: true };
  } catch (error) {
    return {
      outcome: 'dispatch_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function dispatchOneCandidate(input: {
  controllerHome: string;
  candidate: CrossProjectRequirementDispatchSelection['ready'][number];
  placement?: ProjectPlacementSnapshot;
  grants: Map<string, CanonicalGrant>;
  repositories: Map<string, RepositoryRecord>;
  remainingSlots: number;
  readRun: typeof readAutopilotRun;
  isLoopActive: typeof isAutopilotLoopActive;
  start: typeof startAutopilot;
  resume: typeof resumeAutopilot;
}): { decision: CrossProjectAutopilotDispatchDecision; started?: boolean; resumed?: boolean } {
  const { candidate, placement, grants, repositories } = input;
  const repoId = candidateRepositoryId(candidate, placement);
  if (!repoId) {
    return {
      decision: decisionFor(
        candidate,
        undefined,
        'checkout_unavailable',
        'Requirement has no unambiguous local Project placement.',
      ),
    };
  }
  const authorization = authorizedCandidateGrant({ candidate, repoId, placement, grants, repositories });
  if (!authorization.grant) {
    return {
      decision: decisionFor(candidate, repoId, authorization.outcome ?? 'stale_authorization', authorization.detail),
    };
  }
  const run = dispatchCandidateRun({
    controllerHome: input.controllerHome,
    candidate,
    repoId,
    grant: authorization.grant,
    remainingSlots: input.remainingSlots,
    readRun: input.readRun,
    isLoopActive: input.isLoopActive,
    start: input.start,
    resume: input.resume,
  });
  return {
    decision: decisionFor(candidate, repoId, run.outcome, run.detail),
    ...(run.started ? { started: true } : {}),
    ...(run.resumed ? { resumed: true } : {}),
  };
}

export function dispatchAuthorizedCrossProjectRequirements(
  input: {
    controllerHome: string;
    repositories: RepositoryRecord[];
    nowMs?: number;
    limit?: number;
  },
  dependencies: CrossProjectAutopilotDispatchDependencies = {},
): CrossProjectAutopilotDispatchResult {
  const nowMs = input.nowMs ?? Date.now();
  const selectCandidates = dependencies.selectCandidates ?? selectCrossProjectRequirementCandidates;
  const listGrants = dependencies.listGrants ?? listCanonicalGrants;
  const listPlacements = dependencies.listPlacements ?? placementSnapshot;
  const sampleHostResources = dependencies.sampleHostResources ?? sampleAutopilotHostResources;
  const activeLoopCount = dependencies.activeLoopCount ?? activeAutopilotLoopCount;
  const isLoopActive = dependencies.isLoopActive ?? isAutopilotLoopActive;
  const readRun = dependencies.readRun ?? readAutopilotRun;
  const start = dependencies.start ?? startAutopilot;
  const resume = dependencies.resume ?? resumeAutopilot;
  const selection = selectCandidates({
    controllerHome: input.controllerHome,
    limit: input.limit,
    now: () => new Date(nowMs).toISOString(),
  });
  const grants = activeRequirementGrants(listGrants(input.controllerHome), nowMs);
  const activeLoopsAtStart = activeLoopCount();
  const hostSlots = availableAutopilotDispatchSlots({
    sample: sampleHostResources(),
    activeLoops: activeLoopsAtStart,
  });
  const placements = new Map(listPlacements(input.controllerHome).map((placement) => [placement.projectId, placement]));
  const repositories = new Map(
    input.repositories
      .filter((repository) => repository.enabled && !repository.removedAt)
      .map((repository) => [repository.repoId, repository] as const),
  );
  let remainingSlots = hostSlots;
  const startedRequirementIds: string[] = [];
  const resumedRequirementIds: string[] = [];
  const decisions: CrossProjectAutopilotDispatchDecision[] = [];

  for (const candidate of selection.ready) {
    const result = dispatchOneCandidate({
      controllerHome: input.controllerHome,
      candidate,
      placement: placements.get(candidate.projectId),
      grants,
      repositories,
      remainingSlots,
      readRun,
      isLoopActive,
      start,
      resume,
    });
    decisions.push(result.decision);
    if (result.started) {
      startedRequirementIds.push(candidate.requirementId);
      remainingSlots -= 1;
    }
    if (result.resumed) {
      resumedRequirementIds.push(candidate.requirementId);
      remainingSlots -= 1;
    }
  }

  return {
    selection,
    hostSlots,
    activeLoopsAtStart,
    startedRequirementIds,
    resumedRequirementIds,
    decisions,
  };
}
