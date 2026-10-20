import type { WorkContract } from './types';

export const MAX_WORK_OBJECTIVE_RELATIONS = 32;

export function normalizeWorkObjectiveRelationIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))].sort();
}

export function validateWorkObjectiveRelationShape(
  work: Pick<WorkContract, 'workId' | 'lifecycleRole' | 'semanticParentWorkId' | 'dependsOnWorkIds'>,
): void {
  const workId = work.workId.trim();
  const semanticParentWorkId = work.semanticParentWorkId?.trim();
  const dependsOnWorkIds = normalizeWorkObjectiveRelationIds(work.dependsOnWorkIds);
  if ((semanticParentWorkId || dependsOnWorkIds.length > 0) && (work.lifecycleRole ?? 'primary') !== 'primary') {
    throw new Error('WORK_OBJECTIVE_RELATION_PRIMARY_REQUIRED');
  }
  if (semanticParentWorkId === workId) throw new Error('WORK_SEMANTIC_PARENT_SELF_REFERENCE');
  if (dependsOnWorkIds.includes(workId)) throw new Error('WORK_DEPENDENCY_SELF_REFERENCE');
  if (dependsOnWorkIds.length > MAX_WORK_OBJECTIVE_RELATIONS) throw new Error('WORK_DEPENDENCY_LIMIT_EXCEEDED');
}
