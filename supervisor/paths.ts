import { join } from 'node:path';
import { resolveControllerHome } from '../src/cli/repositories/controller-home';

export function resolveWorkflowSupervisorForgeHome(controllerHome?: string): string {
  return resolveControllerHome(controllerHome);
}

export function workflowSupervisorRootPath(controllerHome?: string): string {
  return join(resolveWorkflowSupervisorForgeHome(controllerHome), 'supervisor');
}

export function workflowSupervisorDatabasePathValue(controllerHome?: string): string {
  return join(workflowSupervisorRootPath(controllerHome), 'supervisor.sqlite');
}

export function workflowSupervisorSocketPath(controllerHome?: string): string {
  return join(workflowSupervisorRootPath(controllerHome), 'supervisor.sock');
}
