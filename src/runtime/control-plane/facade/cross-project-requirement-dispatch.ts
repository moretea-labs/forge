import type { ProjectIdentity } from '../../../../packages/kernel/identity/api/index';
import {
  REQUIREMENT_PRIORITIES,
  listRequirements,
  readRequirement,
  type Requirement,
  type RequirementPriority,
  type RequirementState,
} from '../persistence/requirement-store';
import { listControlPlaneRecords } from '../persistence/sqlite-store';
import { PROJECT_SEMANTIC_NAMESPACE } from '../workspace/workspace-store';

const PRIORITY_RANK: Record<RequirementPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export type RequirementDispatchReadiness = 'ready' | 'blocked' | 'waiting_for_user' | 'done' | 'cancelled' | 'unknown';

export interface RequirementDispatchCandidate {
  projectId: string;
  workspaceId: string;
  requirementId: string;
  title: string;
  persistedState: RequirementState;
  readiness: RequirementDispatchReadiness;
  effectivePriority: RequirementPriority;
  prioritySource: 'requirement' | 'project_default' | 'system_default';
  blockingRequirementIds: string[];
  waitReason?: string;
  updatedAt: string;
}

export interface CrossProjectRequirementDispatchSelection {
  schemaVersion: 1;
  generatedAt: string;
  candidates: RequirementDispatchCandidate[];
  ready: RequirementDispatchCandidate[];
  counts: Record<RequirementDispatchReadiness, number>;
}

function normalizePriority(value: unknown): RequirementPriority | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return (REQUIREMENT_PRIORITIES as readonly string[]).includes(normalized)
    ? (normalized as RequirementPriority)
    : undefined;
}

function effectivePriority(input: { requirement: Requirement; project: ProjectIdentity }): {
  priority: RequirementPriority;
  source: RequirementDispatchCandidate['prioritySource'];
} {
  const fromRequirement = normalizePriority(input.requirement.priority);
  if (fromRequirement) return { priority: fromRequirement, source: 'requirement' };
  const fromProject = normalizePriority(input.project.defaultRequirementPriority);
  if (fromProject) return { priority: fromProject, source: 'project_default' };
  return { priority: 'normal', source: 'system_default' };
}

function blockingDependencyIds(controllerHome: string, dependencyIds: readonly string[]): string[] {
  return dependencyIds.filter((dependencyId) => {
    const dependency = readRequirement({ controllerHome }, dependencyId)?.value;
    return dependency?.state !== 'done';
  });
}

function classifyRequirement(input: {
  controllerHome: string;
  project: ProjectIdentity;
  requirement: Requirement;
}): RequirementDispatchCandidate {
  const { priority, source } = effectivePriority({
    requirement: input.requirement,
    project: input.project,
  });
  const dependencies = [...(input.requirement.dependsOnRequirementIds ?? [])];
  const blockingRequirementIds = blockingDependencyIds(input.controllerHome, dependencies);
  let readiness: RequirementDispatchReadiness = 'unknown';
  let waitReason: string | undefined;
  if (input.requirement.state === 'done') readiness = 'done';
  else if (input.requirement.state === 'cancelled') readiness = 'cancelled';
  else if (input.requirement.state === 'waiting_for_user') {
    readiness = 'waiting_for_user';
    waitReason = 'Requirement is waiting for an explicit user decision.';
  } else if (blockingRequirementIds.length > 0) {
    readiness = 'blocked';
    waitReason = `Blocked by unmet dependency Requirement(s): ${blockingRequirementIds.join(', ')}`;
  } else if (input.requirement.state === 'active' || input.requirement.state === 'planned') {
    readiness = 'ready';
  } else {
    readiness = 'unknown';
    waitReason = `Unrecognized or stale Requirement state: ${input.requirement.state}`;
  }
  return {
    projectId: input.project.projectId,
    workspaceId: input.project.workspaceId,
    requirementId: input.requirement.requirementId,
    title: input.requirement.title,
    persistedState: input.requirement.state,
    readiness,
    effectivePriority: priority,
    prioritySource: source,
    blockingRequirementIds,
    ...(waitReason ? { waitReason } : {}),
    updatedAt: input.requirement.updatedAt,
  };
}

function compareCandidates(left: RequirementDispatchCandidate, right: RequirementDispatchCandidate): number {
  const byPriority = PRIORITY_RANK[left.effectivePriority] - PRIORITY_RANK[right.effectivePriority];
  if (byPriority !== 0) return byPriority;
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return left.requirementId.localeCompare(right.requirementId);
}

/**
 * Read-only cross-project Requirement dispatch selection (#707).
 * Enumerates active Projects' Requirements, computes effective priority, and
 * classifies readiness. Does not create Schedules, Processes, or progress writes.
 */
export function selectCrossProjectRequirementCandidates(input: {
  controllerHome: string;
  now?: () => string;
  limit?: number;
}): CrossProjectRequirementDispatchSelection {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 500), 2_000));
  const projects = listControlPlaneRecords<ProjectIdentity>(input.controllerHome, {
    namespace: PROJECT_SEMANTIC_NAMESPACE,
    limit: 1_000,
  })
    .map((entry) => entry.value)
    .filter((project) => (project.status ?? 'active') === 'active');
  if (projects.length >= 1_000) throw new Error('PROJECT_DISPATCH_LOOKUP_LIMIT');

  const projectsById = new Map(projects.map((project) => [project.projectId, project] as const));
  const requirements = listRequirements({ controllerHome: input.controllerHome }, 5_000);
  if (requirements.length >= 5_000) throw new Error('REQUIREMENT_DISPATCH_LOOKUP_LIMIT');

  const candidates: RequirementDispatchCandidate[] = [];
  for (const record of requirements) {
    const projectId = record.value.projectId?.trim();
    if (!projectId) continue;
    const project = projectsById.get(projectId);
    if (!project) continue;
    candidates.push(
      classifyRequirement({
        controllerHome: input.controllerHome,
        project,
        requirement: record.value,
      }),
    );
  }

  candidates.sort(compareCandidates);
  const bounded = candidates.slice(0, limit);
  const counts = {
    ready: 0,
    blocked: 0,
    waiting_for_user: 0,
    done: 0,
    cancelled: 0,
    unknown: 0,
  } satisfies Record<RequirementDispatchReadiness, number>;
  // Diagnostic ordering and dispatch eligibility are separate views. A page
  // full of urgent-but-blocked Requirements must never hide lower-priority
  // runnable work beyond the diagnostic candidate limit.
  for (const candidate of candidates) counts[candidate.readiness] += 1;
  const ready = candidates
    .filter((candidate) => candidate.readiness === 'ready')
    .slice(0, limit);
  return {
    schemaVersion: 1,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    candidates: bounded,
    ready,
    counts,
  };
}
