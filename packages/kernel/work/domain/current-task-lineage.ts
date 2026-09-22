import type { ScopeRef } from '../../identity/api/index';
import { semanticScopeRefForWork, type WorkContract } from './types';

export interface CurrentTaskSemanticProjection {
  schemaVersion: 1;
  workId: string;
  objective: string;
  semanticScope: ScopeRef;
  lifecycleRole: 'primary' | 'execution_child';
  requirementId?: string;
  planId?: string;
  planStepId?: string;
  parentWorkId?: string;
  predecessorWorkId?: string;
  supersedes: string[];
  supersededBy?: string;
}

/**
 * Exact semantic identity for the task currently being executed.
 * Broader Requirement/Plan membership is descriptive lineage metadata only.
 */
export function currentTaskSemanticProjectionForWork(work: WorkContract): CurrentTaskSemanticProjection {
  return {
    schemaVersion: 1,
    workId: work.workId,
    objective: work.objective,
    semanticScope: semanticScopeRefForWork(work),
    lifecycleRole: work.lifecycleRole ?? 'primary',
    ...(work.requirementId?.trim() ? { requirementId: work.requirementId.trim() } : {}),
    ...(work.planId?.trim() ? { planId: work.planId.trim() } : {}),
    ...(work.planStepId?.trim() ? { planStepId: work.planStepId.trim() } : {}),
    ...(work.parentWorkId?.trim() ? { parentWorkId: work.parentWorkId.trim() } : {}),
    ...(work.predecessorWorkId?.trim() ? { predecessorWorkId: work.predecessorWorkId.trim() } : {}),
    supersedes: [...new Set((work.supersedes ?? []).map((id) => id.trim()).filter(Boolean))].sort(),
    ...(work.supersededBy?.trim() ? { supersededBy: work.supersededBy.trim() } : {}),
  };
}

/**
 * Derive only explicit Work lineage. Broad Requirement/Plan membership is
 * deliberately ignored because it is Goal scope, not current-task authority.
 */
export function currentTaskLineageWorkIds(
  originWorkIds: readonly string[],
  contracts: readonly WorkContract[],
): Set<string> {
  const byId = new Map(contracts.map((contract) => [contract.workId, contract] as const));
  const forward = new Set(originWorkIds.map((id) => id.trim()).filter((id) => id && byId.has(id)));

  // Expand only *forward* from the exact origin(s). A child may include its
  // parent as ancestry later, but that parent must never become a new forward
  // seed that pulls sibling children into the current task.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const work of contracts) {
      if (forward.has(work.workId)) {
        const explicitSuccessor = work.supersededBy?.trim();
        if (explicitSuccessor && byId.has(explicitSuccessor) && !forward.has(explicitSuccessor)) {
          forward.add(explicitSuccessor);
          expanded = true;
        }
        continue;
      }
      const parentWorkId = work.parentWorkId?.trim();
      const predecessorWorkId = work.predecessorWorkId?.trim();
      const supersedes = (work.supersedes ?? []).map((id) => id.trim()).filter(Boolean);
      if (
        (parentWorkId && forward.has(parentWorkId))
        || (predecessorWorkId && forward.has(predecessorWorkId))
        || supersedes.some((id) => forward.has(id))
      ) {
        forward.add(work.workId);
        expanded = true;
      }
    }
  }

  // Preserve explicit ancestry for audit/fencing, but never use ancestors as
  // descendant-expansion seeds. That keeps fork siblings independent.
  const linked = new Set(forward);
  const upstream = [...forward];
  while (upstream.length > 0) {
    const work = byId.get(upstream.pop()!);
    if (!work) continue;
    const ancestors = [
      work.parentWorkId,
      work.predecessorWorkId,
      ...(work.supersedes ?? []),
    ].map((id) => id?.trim()).filter((id): id is string => Boolean(id));
    for (const id of ancestors) {
      if (!byId.has(id) || linked.has(id)) continue;
      linked.add(id);
      upstream.push(id);
    }
  }
  return linked;
}
