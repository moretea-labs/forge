import { listAllControlPlaneRecords } from '../control-plane/persistence/sqlite-store';

interface WorkflowRunIdentityRecord {
  schemaVersion: number;
  workflowId: string;
  version: string;
  contentDigest: string;
  runId: string;
  scopeId: string;
  status: string;
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'compensated']);

export function listNonterminalWorkflowRuns(
  controllerHome: string,
  identity: { workflowId: string; version: string; contentDigest: string },
): WorkflowRunIdentityRecord[] {
  return listAllControlPlaneRecords<WorkflowRunIdentityRecord>(controllerHome, { namespace: 'workflow_run' })
    .map((record) => record.value)
    .filter(
      (run) =>
        run.workflowId === identity.workflowId &&
        run.version === identity.version &&
        run.contentDigest === identity.contentDigest &&
        !TERMINAL_RUN_STATUSES.has(run.status),
    );
}

export function assertNoNonterminalWorkflowRuns(
  controllerHome: string,
  identity: { workflowId: string; version: string; contentDigest: string },
  errorCode: string,
): void {
  const matching = listNonterminalWorkflowRuns(controllerHome, identity);
  if (matching.length === 0) return;
  const refs = matching
    .slice(0, 8)
    .map((run) => `${run.scopeId}/${run.runId}:${run.status}`)
    .sort();
  throw new Error(`${errorCode}:${matching.length}:${refs.join(',')}`);
}
