import type { PortfolioWorkflow } from './types';
import { listActivePortfolioWorkflows, savePortfolioWorkflow } from './store';

const EXTERNAL_CONTROLLER_REQUIRED = 'Portfolio execution requires an explicitly claimed external Controller.';

/**
 * Portfolio definitions remain durable planning records. Kernel-owned DAG execution
 * is retired, so ticking only records the explicit handoff state and creates no Job.
 */
export function tickPortfolioWorkflow(controllerHome: string, source: PortfolioWorkflow): PortfolioWorkflow {
  const steps = source.steps.map((step) => step.status === 'pending' || step.status === 'queued'
    ? { ...step, status: 'blocked' as const, error: EXTERNAL_CONTROLLER_REQUIRED }
    : step);
  return savePortfolioWorkflow(controllerHome, { ...source, status: 'paused', steps });
}

export function tickPortfolioWorkflows(controllerHome: string): PortfolioWorkflow[] {
  return listActivePortfolioWorkflows(controllerHome)
    .map((workflow) => tickPortfolioWorkflow(controllerHome, workflow));
}
