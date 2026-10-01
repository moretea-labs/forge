import type { WorkContract, WorkSemanticView } from './types';

export const MAX_WORK_OBJECTIVE_RELATIONS = 32;
export const MAX_WORK_OBJECTIVE_GRAPH_NODES = 100;
export const MAX_WORK_OBJECTIVE_GRAPH_HISTORY_NODES = 200;

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

export interface WorkObjectiveGraphEdge {
  kind: 'decomposition' | 'dependency';
  fromWorkId: string;
  toWorkId: string;
  workRevision: number;
}

export interface WorkObjectiveGraphProjection {
  schemaVersion: 1;
  rootWorkId?: string;
  current: {
    nodes: WorkSemanticView[];
    edges: WorkObjectiveGraphEdge[];
    truncated: boolean;
  };
  history: {
    nodes: WorkSemanticView[];
    edges: WorkObjectiveGraphEdge[];
    truncated: boolean;
  };
}

function relationEdges(view: WorkSemanticView): WorkObjectiveGraphEdge[] {
  const edges: WorkObjectiveGraphEdge[] = [];
  const parent = view.semanticParentWorkId?.trim();
  if (parent) edges.push({ kind: 'decomposition', fromWorkId: parent, toWorkId: view.workId, workRevision: view.revision });
  for (const dependency of normalizeWorkObjectiveRelationIds(view.dependsOnWorkIds)) {
    edges.push({ kind: 'dependency', fromWorkId: dependency, toWorkId: view.workId, workRevision: view.revision });
  }
  return edges;
}

function connectedCurrentIds(current: readonly WorkSemanticView[], rootWorkId?: string): { ids: Set<string>; truncated: boolean } {
  const byId = new Map(current.map((view) => [view.workId, view] as const));
  if (!rootWorkId?.trim()) {
    const ids = new Set([...byId.keys()].sort().slice(0, MAX_WORK_OBJECTIVE_GRAPH_NODES));
    return { ids, truncated: byId.size > ids.size };
  }
  const root = rootWorkId.trim();
  if (!byId.has(root)) return { ids: new Set(), truncated: false };
  const adjacency = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    if (!byId.has(left) || !byId.has(right)) return;
    const leftSet = adjacency.get(left) ?? new Set<string>();
    const rightSet = adjacency.get(right) ?? new Set<string>();
    leftSet.add(right);
    rightSet.add(left);
    adjacency.set(left, leftSet);
    adjacency.set(right, rightSet);
  };
  for (const view of current) {
    const parent = view.semanticParentWorkId?.trim();
    if (parent) link(parent, view.workId);
    for (const dependency of normalizeWorkObjectiveRelationIds(view.dependsOnWorkIds)) link(dependency, view.workId);
  }
  const ids = new Set<string>();
  const queue = [root];
  while (queue.length > 0 && ids.size < MAX_WORK_OBJECTIVE_GRAPH_NODES) {
    const workId = queue.shift()!;
    if (ids.has(workId)) continue;
    ids.add(workId);
    for (const adjacent of [...(adjacency.get(workId) ?? [])].sort()) {
      if (!ids.has(adjacent)) queue.push(adjacent);
    }
  }
  return { ids, truncated: queue.some((workId) => !ids.has(workId)) };
}

export function projectWorkObjectiveGraph(
  currentViews: readonly WorkSemanticView[],
  historyViews: readonly WorkSemanticView[] = [],
  rootWorkId?: string,
): WorkObjectiveGraphProjection {
  const currentById = new Map(currentViews.map((view) => [view.workId, view] as const));
  const connected = connectedCurrentIds(currentViews, rootWorkId);
  const currentNodes = [...connected.ids]
    .map((workId) => currentById.get(workId))
    .filter((view): view is WorkSemanticView => Boolean(view))
    .sort((left, right) => left.workId.localeCompare(right.workId));
  const currentEdges = currentNodes.flatMap(relationEdges)
    .filter((edge) => connected.ids.has(edge.fromWorkId) && connected.ids.has(edge.toWorkId))
    .sort((left, right) => `${left.kind}:${left.fromWorkId}:${left.toWorkId}`.localeCompare(`${right.kind}:${right.fromWorkId}:${right.toWorkId}`));
  const allHistory = historyViews
    .filter((view) => connected.ids.has(view.workId))
    .sort((left, right) => left.workId.localeCompare(right.workId) || right.revision - left.revision);
  const historyNodes = allHistory.slice(0, MAX_WORK_OBJECTIVE_GRAPH_HISTORY_NODES);
  const historyEdges = historyNodes.flatMap(relationEdges)
    .filter((edge) => connected.ids.has(edge.fromWorkId) && connected.ids.has(edge.toWorkId));
  return {
    schemaVersion: 1,
    ...(rootWorkId?.trim() ? { rootWorkId: rootWorkId.trim() } : {}),
    current: { nodes: currentNodes, edges: currentEdges, truncated: connected.truncated },
    history: { nodes: historyNodes, edges: historyEdges, truncated: allHistory.length > historyNodes.length },
  };
}
