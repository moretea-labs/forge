import type { ProjectIdentity, ProjectPlacement, WorkspaceIdentity } from '../../../../packages/kernel/identity/api/index';
import { projectIdentity, projectPlacement, workspaceIdentity } from '../../../../packages/kernel/identity/api/index';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../persistence/sqlite-store';

export const WORKSPACE_SEMANTIC_NAMESPACE = 'workspace_semantic';
export const PROJECT_SEMANTIC_NAMESPACE = 'project_semantic';
export const PROJECT_PLACEMENT_NAMESPACE = 'project_placement';
const CONTROLLER_SCOPE = 'controller';

export function writeWorkspaceIdentity(input: { controllerHome: string; value: Omit<WorkspaceIdentity, 'schemaVersion'> | WorkspaceIdentity; expectedRevision?: number | null }): ControlPlaneRecord<WorkspaceIdentity> {
  const value = workspaceIdentity(input.value);
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKSPACE_SEMANTIC_NAMESPACE, scope: CONTROLLER_SCOPE, key: value.workspaceId, schemaVersion: 1, value,
    action: 'workspace_semantic_write', expectedRevision: input.expectedRevision,
  });
}

export function readWorkspaceIdentity(controllerHome: string, workspaceId: string): ControlPlaneRecord<WorkspaceIdentity> | undefined {
  return readControlPlaneRecord(controllerHome, WORKSPACE_SEMANTIC_NAMESPACE, CONTROLLER_SCOPE, workspaceId.trim());
}

export function listWorkspaceIdentities(controllerHome: string): ControlPlaneRecord<WorkspaceIdentity>[] {
  return listControlPlaneRecords<WorkspaceIdentity>(controllerHome, { namespace: WORKSPACE_SEMANTIC_NAMESPACE, scope: CONTROLLER_SCOPE, limit: 1_000 });
}

export function writeProjectIdentity(input: { controllerHome: string; value: Omit<ProjectIdentity, 'schemaVersion'> | ProjectIdentity; expectedRevision?: number | null }): ControlPlaneRecord<ProjectIdentity> {
  const value = projectIdentity(input.value);
  const workspace = readWorkspaceIdentity(input.controllerHome, value.workspaceId);
  if (!workspace) throw new Error(`PROJECT_WORKSPACE_NOT_FOUND: ${value.workspaceId}`);
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: PROJECT_SEMANTIC_NAMESPACE, scope: value.workspaceId, key: value.projectId, schemaVersion: 1, value,
    action: 'project_semantic_write', expectedRevision: input.expectedRevision,
  });
}

export function readProjectIdentity(controllerHome: string, workspaceId: string, projectId: string): ControlPlaneRecord<ProjectIdentity> | undefined {
  return readControlPlaneRecord(controllerHome, PROJECT_SEMANTIC_NAMESPACE, workspaceId.trim(), projectId.trim());
}

export function listProjectIdentities(controllerHome: string, workspaceId: string): ControlPlaneRecord<ProjectIdentity>[] {
  return listControlPlaneRecords<ProjectIdentity>(controllerHome, { namespace: PROJECT_SEMANTIC_NAMESPACE, scope: workspaceId.trim(), limit: 1_000 });
}

export function writeProjectPlacement(input: { controllerHome: string; value: Omit<ProjectPlacement, 'schemaVersion'> | ProjectPlacement; expectedRevision?: number | null }): ControlPlaneRecord<ProjectPlacement> {
  const value = projectPlacement(input.value);
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: PROJECT_PLACEMENT_NAMESPACE, scope: value.forgeInstanceId, key: value.projectId, schemaVersion: 1, value,
    action: 'project_placement_write', expectedRevision: input.expectedRevision,
  });
}

export function readProjectPlacement(controllerHome: string, forgeInstanceId: string, projectId: string): ControlPlaneRecord<ProjectPlacement> | undefined {
  return readControlPlaneRecord(controllerHome, PROJECT_PLACEMENT_NAMESPACE, forgeInstanceId.trim(), projectId.trim());
}
