import { createExecutionJob, findExecutionJob } from '../../execution/jobs/store';
import type { PortfolioStep, PortfolioWorkflow } from './types';
import { listActivePortfolioWorkflows, savePortfolioWorkflow } from './store';
import { operationRequiresHumanAuthorization } from '../../control-plane/governance/external-effects';

function terminalFailure(status: string): boolean {
  return ['failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(status);
}

function portfolioExecutionRetired(): boolean {
  return true;
}

function synchronizeStep(step: PortfolioStep): PortfolioStep {
  return { ...step };
}

function updateFromJobs(controllerHome: string, workflow: PortfolioWorkflow): PortfolioWorkflow {
  const steps = workflow.steps.map((original) => {
    const step = synchronizeStep(original);
    if (step.jobId) {
      const job = findExecutionJob(controllerHome, step.jobId);
      if (job?.status === 'running') step.status = 'running';
      else if (job?.status === 'succeeded') step.status = 'succeeded';
      else if (job && terminalFailure(job.status)) { step.status = 'failed'; step.error = job.error?.message; }
    }
    if (step.compensationJobId) {
      const compensation = findExecutionJob(controllerHome, step.compensationJobId);
      if (compensation?.status === 'running') step.status = 'compensating';
      else if (compensation?.status === 'succeeded') step.status = 'compensated';
      else if (compensation && terminalFailure(compensation.status)) { step.status = 'failed'; step.error = compensation.error?.message; }
    }
    return step;
  });
  return { ...workflow, steps };
}

function queueStep(controllerHome: string, workflow: PortfolioWorkflow, step: PortfolioStep): PortfolioStep {
  if (operationRequiresHumanAuthorization(step.operation, step.arguments ?? {})) {
    return { ...step, status: 'blocked', error: 'External side effects require a separately authorized user request.' };
  }
  const dependencyJobIds = step.dependsOn
    .map((dependency) => workflow.steps.find((candidate) => candidate.stepId === dependency)?.jobId)
    .filter((value): value is string => Boolean(value));
  const created = createExecutionJob(controllerHome, {
    repoId: step.repoId,
    type: 'mcp-tool',
    requestId: `${workflow.requestId}:${step.stepId}`,
    semanticKey: `portfolio:${workflow.workflowId}:${step.stepId}`,
    priority: step.priority,
    origin: { surface: 'system', actor: workflow.workflowId, correlationId: workflow.workflowId },
    payload: { operation: step.operation, arguments: step.arguments, target: 'mcp-tool', portfolioWorkflowId: workflow.workflowId, portfolioStepId: step.stepId },
    resourceClaims: step.resourceClaims,
    dependencies: dependencyJobIds,
    maxAttempts: 1,
  });
  return { ...step, status: 'queued', jobId: created.job.jobId };
}

function beginCompensation(controllerHome: string, workflow: PortfolioWorkflow): PortfolioWorkflow {
  const steps = [...workflow.steps];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.status !== 'succeeded' || !step.compensation || step.compensationJobId) continue;
    if (operationRequiresHumanAuthorization(step.compensation.operation, step.compensation.arguments ?? {})) {
      steps[index] = { ...step, status: 'blocked', error: 'Compensation has an external side effect and requires explicit user authorization.' };
      break;
    }
    const created = createExecutionJob(controllerHome, {
      repoId: step.repoId,
      type: 'mcp-tool',
      requestId: `${workflow.requestId}:${step.stepId}:compensation`,
      semanticKey: `portfolio-compensation:${workflow.workflowId}:${step.stepId}`,
      priority: 'P0',
      origin: { surface: 'system', actor: workflow.workflowId, correlationId: workflow.workflowId },
      payload: { operation: step.compensation.operation, arguments: step.compensation.arguments, target: 'mcp-tool', compensation: true },
      resourceClaims: step.resourceClaims,
      maxAttempts: 1,
    });
    steps[index] = { ...step, status: 'compensating', compensationJobId: created.job.jobId };
    break;
  }
  return { ...workflow, status: 'compensating', steps };
}

export function tickPortfolioWorkflow(controllerHome: string, source: PortfolioWorkflow): PortfolioWorkflow {
  if (portfolioExecutionRetired()) {
    const steps = source.steps.map((step) => step.status === 'pending' || step.status === 'queued'
      ? { ...step, status: 'blocked' as const, error: 'Portfolio execution requires an explicitly claimed external Controller.' }
      : step);
    return savePortfolioWorkflow(controllerHome, { ...source, status: 'paused', steps });
  }
  let workflow = updateFromJobs(controllerHome, source);
  const failed = workflow.steps.some((step) => step.status === 'failed' || step.status === 'blocked');
  if (failed) {
    if (workflow.failurePolicy === 'compensate' && workflow.steps.some((step) => step.status === 'succeeded' && step.compensation)) {
      workflow = beginCompensation(controllerHome, workflow);
      const compensationPending = workflow.steps.some((step) => step.status === 'compensating');
      if (!compensationPending && workflow.steps.filter((step) => step.compensation).every((step) => step.status === 'compensated' || step.status !== 'succeeded')) workflow.status = 'compensated';
    } else workflow.status = 'failed';
    return savePortfolioWorkflow(controllerHome, workflow);
  }
  if (workflow.steps.every((step) => step.status === 'succeeded' || step.status === 'compensated')) {
    workflow.status = 'succeeded';
    return savePortfolioWorkflow(controllerHome, workflow);
  }
  const steps = workflow.steps.map((step) => {
    if (step.status !== 'pending') return step;
    const dependencies = step.dependsOn.map((id) => workflow.steps.find((candidate) => candidate.stepId === id));
    if (dependencies.some((dependency) => !dependency || dependency.status === 'failed' || dependency.status === 'blocked')) return { ...step, status: 'blocked' as const, error: 'Dependency failed.' };
    if (!dependencies.every((dependency) => dependency?.status === 'succeeded')) return step;
    return queueStep(controllerHome, workflow, step);
  });
  return savePortfolioWorkflow(controllerHome, { ...workflow, steps });
}

export function tickPortfolioWorkflows(controllerHome: string): PortfolioWorkflow[] {
  return listActivePortfolioWorkflows(controllerHome)
    .map((workflow) => tickPortfolioWorkflow(controllerHome, workflow));
}
