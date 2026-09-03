/** Portable Workspace/Project identity. Repository registration is node-local placement, never semantic identity. */
export interface WorkspaceIdentity {
  schemaVersion: 1;
  workspaceId: string;
  title: string;
}

export interface ProjectIdentity {
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  displayName: string;
  /** Stable digest of a portable source identity (for example a normalized Git remote), never a local path. */
  sourceFingerprint?: string;
}

/** Node-local mapping from one portable Project to the repository/checkout used by this ForgeInstance. Never sync this record. */
export interface ProjectPlacement {
  schemaVersion: 1;
  projectId: string;
  forgeInstanceId: string;
  repositoryId: string;
  checkoutId?: string;
}

function boundedId(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(code);
  return normalized;
}

export function workspaceIdentity(input: Omit<WorkspaceIdentity, 'schemaVersion'>): WorkspaceIdentity {
  const workspaceId = boundedId(input.workspaceId, 'WORKSPACE_ID_INVALID');
  const title = input.title.trim();
  if (!title || title.length > 512) throw new Error('WORKSPACE_TITLE_INVALID');
  return { schemaVersion: 1, workspaceId, title };
}

export function projectIdentity(input: Omit<ProjectIdentity, 'schemaVersion'>): ProjectIdentity {
  const projectId = boundedId(input.projectId, 'PROJECT_ID_INVALID');
  const workspaceId = boundedId(input.workspaceId, 'WORKSPACE_ID_INVALID');
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 512) throw new Error('PROJECT_DISPLAY_NAME_INVALID');
  const sourceFingerprint = input.sourceFingerprint?.trim();
  if (sourceFingerprint && !/^[a-f0-9]{64}$/i.test(sourceFingerprint)) throw new Error('PROJECT_SOURCE_FINGERPRINT_INVALID');
  return { schemaVersion: 1, projectId, workspaceId, displayName, ...(sourceFingerprint ? { sourceFingerprint: sourceFingerprint.toLowerCase() } : {}) };
}

export function projectPlacement(input: Omit<ProjectPlacement, 'schemaVersion'>): ProjectPlacement {
  const projectId = boundedId(input.projectId, 'PROJECT_ID_INVALID');
  const forgeInstanceId = boundedId(input.forgeInstanceId, 'FORGE_INSTANCE_ID_INVALID');
  const repositoryId = boundedId(input.repositoryId, 'PROJECT_REPOSITORY_ID_INVALID');
  const checkoutId = input.checkoutId?.trim();
  if (checkoutId && checkoutId.length > 512) throw new Error('PROJECT_CHECKOUT_ID_INVALID');
  return { schemaVersion: 1, projectId, forgeInstanceId, repositoryId, ...(checkoutId ? { checkoutId } : {}) };
}
