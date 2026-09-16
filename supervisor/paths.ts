import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveWorkflowSupervisorForgeHome(forgeHome?: string): string {
  return resolve(forgeHome ?? process.env.FORGE_HOME ?? join(homedir(), '.forge'));
}

export function workflowSupervisorRootPath(forgeHome?: string): string {
  return join(resolveWorkflowSupervisorForgeHome(forgeHome), 'supervisor');
}

export function workflowSupervisorDatabasePathValue(forgeHome?: string): string {
  return join(workflowSupervisorRootPath(forgeHome), 'supervisor.sqlite');
}

export function workflowSupervisorSocketPath(forgeHome?: string): string {
  return join(workflowSupervisorRootPath(forgeHome), 'supervisor.sock');
}
