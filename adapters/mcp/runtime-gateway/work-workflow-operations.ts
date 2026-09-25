import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { selectRepositoryCheckout } from '../../../src/cli/repositories/registry';
import { executionIdentityForRepository } from '../../../src/runtime/control-plane/execution/execution-identity';
import { readWorkflowRun } from '../../../src/runtime/control-plane/persistence/workflow-run-store';
import { schedulePublicationOutcomeCollection } from '../../../src/runtime/root/assistant-learning-loop';
import { ensureXiaohongshuWorkflowInstalled, XIAOHONGSHU_WORKFLOW_IDS } from '../../../src/runtime/workflows/first-party/xiaohongshu';
import { executeRegisteredWorkflow, observeAndReconcileRegisteredWorkflow } from '../../../src/runtime/workflows/runtime';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result } from './result-adapter';

type RepositorySelection = Parameters<typeof selectRepositoryCheckout>[0];

/**
 * Dedicated rh_work Workflow domain dispatch. Workflow execution is fenced by
 * its typed Work/target/effect identities rather than Work-wide Controller ownership;
 * this adapter does not own Work lifecycle transitions or semantic completion.
 */
export async function callRhWorkWorkflowOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositorySelection,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (operation !== 'workflow_execute' && operation !== 'workflow_reconcile') return undefined;
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  try {
    const workId = String(args.work_id ?? '').trim();
    const workflowId = String(args.workflow_id ?? '').trim();
    const runId = String(args.workflow_run_id ?? '').trim();
    if (!workId || !workflowId || !runId) throw new Error('WORKFLOW_FACADE_IDENTITY_REQUIRED');
    const work = getWorkContract(store, workId);
    if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);

    const workRepository = selectRepositoryCheckout(repository, work.checkoutId);
    const executionIdentity = executionIdentityForRepository(workRepository, { workId });
    if (Object.values(XIAOHONGSHU_WORKFLOW_IDS).includes(workflowId as never)) {
      ensureXiaohongshuWorkflowInstalled(ctx.controllerHome, workflowId);
    }
    const projectId = typeof args.workflow_scope_project_id === 'string' ? args.workflow_scope_project_id.trim() : '';
    const registryScope = projectId ? { kind: 'project' as const, projectId } : { kind: 'controller' as const };
    const workflowInputs = args.workflow_inputs && typeof args.workflow_inputs === 'object' && !Array.isArray(args.workflow_inputs)
      ? args.workflow_inputs as Record<string, WorkflowJsonValue>
      : {};
    const base = {
      controllerHome: ctx.controllerHome,
      repository: workRepository,
      executionIdentity,
      workId,
      runId,
      registryScope,
      workflowId,
      inputs: workflowInputs,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    };
    const learningMetadata = (workflow: Awaited<ReturnType<typeof executeRegisteredWorkflow>>) => {
      const persisted = readWorkflowRun(ctx.controllerHome, workId, runId)?.value;
      let outcomeCollectionSchedule;
      let outcomeCollectionError: string | undefined;
      if (workflow.status === 'succeeded' && workflow.publicationReceipt) {
        try {
          outcomeCollectionSchedule = schedulePublicationOutcomeCollection({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            workId,
            publication: workflow.publicationReceipt,
            workflowInputs,
          });
        } catch (error) {
          outcomeCollectionError = error instanceof Error ? error.message : 'OUTCOME_COLLECTION_SCHEDULE_FAILED';
        }
      }
      return {
        ...(persisted?.evidenceRef ? { workflowEvidenceRef: persisted.evidenceRef } : {}),
        ...(outcomeCollectionSchedule ? { outcomeCollectionSchedule } : {}),
        ...(outcomeCollectionError ? { outcomeCollectionError } : {}),
      };
    };

    if (operation === 'workflow_reconcile') {
      const reconciliationRequestId = String(args.workflow_reconciliation_request_id ?? '').trim();
      if (!reconciliationRequestId) throw new Error('WORKFLOW_RECONCILIATION_REQUEST_ID_REQUIRED');
      const reconciled = await observeAndReconcileRegisteredWorkflow({ ...base, reconciliationRequestId });
      if (reconciled.status === 'running') {
        const resumed = await executeRegisteredWorkflow(base);
        return result(buildFacadeResult({
          summary: `Workflow ${workflowId}/${runId} reconciled from canonical observation and resumed without replaying the uncertain effect.`,
          data: { workflow: resumed, ...learningMetadata(resumed) },
        }) as unknown as Record<string, unknown>);
      }
      return result(buildFacadeResult({
        status: reconciled.status === 'failed' ? 'blocked' : 'ok',
        summary: `Workflow ${workflowId}/${runId} reconciliation settled as ${reconciled.status}.`,
        data: { workflow: reconciled },
      }) as unknown as Record<string, unknown>, reconciled.status === 'failed');
    }

    const executed = await executeRegisteredWorkflow(base);
    return result(buildFacadeResult({
      status: executed.status === 'failed' || executed.status === 'reconcile_required' ? 'blocked' : 'ok',
      summary: `Workflow ${workflowId}/${runId} is ${executed.status}.`,
      data: { workflow: executed, ...learningMetadata(executed) },
    }) as unknown as Record<string, unknown>, executed.status === 'failed' || executed.status === 'reconcile_required');
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Workflow execution failed.',
      data: { workflowExecuted: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
