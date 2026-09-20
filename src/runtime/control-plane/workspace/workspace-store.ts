import type { ProjectIdentity, ProjectPlacement, WorkspaceIdentity } from '../../../../packages/kernel/identity/api/index';
import { projectIdentity, projectPlacement, workspaceIdentity } from '../../../../packages/kernel/identity/api/index';
import {
  listControlPlaneRecords,
  listControlPlaneRecordsWithinTransaction,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
  writeControlPlaneRecordWithinTransaction,
  type ControlPlaneRecord,
} from '../persistence/sqlite-store';

export const WORKSPACE_SEMANTIC_NAMESPACE = 'workspace_semantic';
export const PROJECT_SEMANTIC_NAMESPACE = 'project_semantic';
export const PROJECT_PLACEMENT_NAMESPACE = 'project_placement';
const CONTROLLER_SCOPE = 'controller';

export const DEFAULT_PERSONAL_WORKSPACE_ID = 'workspace-personal';
export const DEFAULT_PERSONAL_WORKSPACE_TITLE = 'Personal workspace';

export interface EnsureProjectWorkspaceBindingInput {
  controllerHome: string;
  preferredProjectId?: string;
  fallbackProjectId?: string;
  sourceFingerprint?: string;
  displayName: string;
  forgeInstanceId: string;
  repositoryId: string;
  defaultWorkspaceId?: string;
  defaultWorkspaceTitle?: string;
}

export interface EnsureProjectWorkspaceBindingResult {
  workspace: WorkspaceIdentity;
  project: ProjectIdentity;
  placement: ProjectPlacement;
  createdWorkspace: boolean;
  createdProject: boolean;
  createdPlacement: boolean;
}

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

export function ensureProjectWorkspaceBinding(input: EnsureProjectWorkspaceBindingInput): EnsureProjectWorkspaceBindingResult {
  const preferredProjectId = input.preferredProjectId?.trim();
  const fallbackProjectId = input.fallbackProjectId?.trim();
  const candidateProjectId = preferredProjectId || fallbackProjectId;
  if (!candidateProjectId) throw new Error('PROJECT_PORTABLE_IDENTITY_REQUIRED');
  const sourceFingerprint = input.sourceFingerprint?.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('PROJECT_DISPLAY_NAME_INVALID');
  const defaultWorkspaceId = input.defaultWorkspaceId?.trim() || DEFAULT_PERSONAL_WORKSPACE_ID;
  const defaultWorkspaceTitle = input.defaultWorkspaceTitle?.trim() || DEFAULT_PERSONAL_WORKSPACE_TITLE;

  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const projects = listControlPlaneRecordsWithinTransaction<ProjectIdentity>(database, {
      namespace: PROJECT_SEMANTIC_NAMESPACE,
      limit: 1000,
    });
    if (projects.length >= 1000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');

    const exactMatches = projects.filter(({ value }) => value.projectId === candidateProjectId);
    if (exactMatches.length > 1) throw new Error(`PROJECT_IDENTITY_AMBIGUOUS: ${candidateProjectId}`);
    const sourceMatches = sourceFingerprint
      ? projects.filter(({ value }) => value.sourceFingerprint === sourceFingerprint)
      : [];
    if (sourceMatches.length > 1) throw new Error('PROJECT_SOURCE_IDENTITY_AMBIGUOUS');

    const exact = exactMatches[0]?.value;
    const sameSource = sourceMatches[0]?.value;
    if (exact && sameSource && exact.projectId !== sameSource.projectId) {
      throw new Error(`PROJECT_IDENTITY_SOURCE_ALIAS_CONFLICT: project=${exact.projectId} source_project=${sameSource.projectId}`);
    }
    if (preferredProjectId && sameSource && sameSource.projectId !== preferredProjectId) {
      throw new Error(`PROJECT_IDENTITY_SOURCE_ALIAS_CONFLICT: declared=${preferredProjectId} existing=${sameSource.projectId}`);
    }

    const existingProject = exact ?? sameSource;
    if (existingProject?.sourceFingerprint && sourceFingerprint && existingProject.sourceFingerprint !== sourceFingerprint) {
      throw new Error(`PROJECT_IDENTITY_SOURCE_MISMATCH: ${existingProject.projectId}`);
    }
    if (preferredProjectId && existingProject && existingProject.projectId !== preferredProjectId) {
      throw new Error(`PROJECT_IDENTITY_DECLARATION_MISMATCH: declared=${preferredProjectId} existing=${existingProject.projectId}`);
    }

    const projectId = existingProject?.projectId ?? candidateProjectId;
    const workspaceId = existingProject?.workspaceId ?? defaultWorkspaceId;
    let workspace = readControlPlaneRecordWithinTransaction<WorkspaceIdentity>(
      database,
      WORKSPACE_SEMANTIC_NAMESPACE,
      CONTROLLER_SCOPE,
      workspaceId,
    );
    let createdWorkspace = false;
    if (!workspace) {
      if (existingProject) throw new Error(`PROJECT_WORKSPACE_IDENTITY_UNRESOLVED: ${workspaceId}`);
      const value = workspaceIdentity({ workspaceId, title: defaultWorkspaceTitle });
      workspace = writeControlPlaneRecordWithinTransaction(database, {
        namespace: WORKSPACE_SEMANTIC_NAMESPACE,
        scope: CONTROLLER_SCOPE,
        key: value.workspaceId,
        schemaVersion: 1,
        value,
        action: 'workspace_semantic_onboard',
        expectedRevision: null,
      });
      createdWorkspace = true;
    }

    let projectRecord = existingProject
      ? projects.find((entry) => entry.value.workspaceId === existingProject.workspaceId && entry.value.projectId === existingProject.projectId)
      : undefined;
    let createdProject = false;
    if (!projectRecord) {
      const value = projectIdentity({
        projectId,
        workspaceId,
        displayName,
        ...(sourceFingerprint ? { sourceFingerprint } : {}),
      });
      projectRecord = writeControlPlaneRecordWithinTransaction(database, {
        namespace: PROJECT_SEMANTIC_NAMESPACE,
        scope: workspaceId,
        key: value.projectId,
        schemaVersion: 1,
        value,
        action: 'project_semantic_onboard',
        expectedRevision: null,
      });
      createdProject = true;
    }

    const placements = listControlPlaneRecordsWithinTransaction<ProjectPlacement>(database, {
      namespace: PROJECT_PLACEMENT_NAMESPACE,
      scope: input.forgeInstanceId,
      limit: 1000,
    });
    if (placements.length >= 1000) throw new Error('PROJECT_PLACEMENT_LOOKUP_LIMIT');
    const repositoryPlacements = placements.filter(({ value }) => value.repositoryId === input.repositoryId);
    if (repositoryPlacements.length > 1) throw new Error('PROJECT_REPOSITORY_PLACEMENT_AMBIGUOUS');
    const repositoryPlacement = repositoryPlacements[0]?.value;
    if (repositoryPlacement && repositoryPlacement.projectId !== projectId) {
      throw new Error(`PROJECT_REPOSITORY_ALREADY_BOUND: repository=${input.repositoryId} existing=${repositoryPlacement.projectId} requested=${projectId}`);
    }

    let placementRecord = readControlPlaneRecordWithinTransaction<ProjectPlacement>(
      database,
      PROJECT_PLACEMENT_NAMESPACE,
      input.forgeInstanceId,
      projectId,
    );
    if (placementRecord && placementRecord.value.repositoryId !== input.repositoryId) {
      throw new Error(`PROJECT_PLACEMENT_REPOSITORY_CONFLICT: project=${projectId} existing=${placementRecord.value.repositoryId} requested=${input.repositoryId}`);
    }
    let createdPlacement = false;
    if (!placementRecord) {
      const value = projectPlacement({
        projectId,
        forgeInstanceId: input.forgeInstanceId,
        repositoryId: input.repositoryId,
      });
      placementRecord = writeControlPlaneRecordWithinTransaction(database, {
        namespace: PROJECT_PLACEMENT_NAMESPACE,
        scope: input.forgeInstanceId,
        key: projectId,
        schemaVersion: 1,
        value,
        action: 'project_placement_onboard',
        expectedRevision: null,
      });
      createdPlacement = true;
    }

    return {
      workspace: workspace.value,
      project: projectRecord.value,
      placement: placementRecord.value,
      createdWorkspace,
      createdProject,
      createdPlacement,
    };
  });
}

/** Resolve semantic project through current placement; never derive identity from a path. */
export function resolveProjectForRepositoryPlacement(input: {
  controllerHome: string; forgeInstanceId: string; repositoryId: string; checkoutId?: string; projectId?: string;
}): ProjectIdentity | undefined {
  const placements = listControlPlaneRecords<ProjectPlacement>(input.controllerHome, {
    namespace: PROJECT_PLACEMENT_NAMESPACE, scope: input.forgeInstanceId, limit: 1000,
  });
  if (placements.length >= 1000) throw new Error('PROJECT_PLACEMENT_LOOKUP_LIMIT');
  const matches = placements.filter(({ value }) => value.repositoryId === input.repositoryId
    && (!value.checkoutId || value.checkoutId === input.checkoutId)
    && (!input.projectId || value.projectId === input.projectId));
  if (matches.length > 1) throw new Error('PROJECT_PLACEMENT_AMBIGUOUS');
  const placement = matches[0]?.value;
  if (!placement) return undefined;
  const projects = listControlPlaneRecords<ProjectIdentity>(input.controllerHome, { namespace: PROJECT_SEMANTIC_NAMESPACE, limit: 1000 });
  if (projects.length >= 1000) throw new Error('PROJECT_IDENTITY_LOOKUP_LIMIT');
  const identities = projects.filter(({ value }) => value.projectId === placement.projectId);
  if (identities.length !== 1) throw new Error('PROJECT_PLACEMENT_IDENTITY_UNRESOLVED');
  return identities[0]!.value;
}
