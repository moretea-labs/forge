/** Portable Workspace/Project identity. Repository registration is node-local placement, never semantic identity. */
export interface WorkspaceIdentity {
  schemaVersion: 1;
  workspaceId: string;
  title: string;
}

export type ProjectStatus = 'active' | 'archived';

/** Aligns with goal RequirementPriority without importing the goal domain. */
export const PROJECT_DEFAULT_REQUIREMENT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type ProjectDefaultRequirementPriority = (typeof PROJECT_DEFAULT_REQUIREMENT_PRIORITIES)[number];

export interface ProjectIdentity {
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  displayName: string;
  /** Existing rows without status are interpreted as active. */
  status?: ProjectStatus;
  /** Stable digest of a portable source identity (for example a normalized Git remote), never a local path. */
  sourceFingerprint?: string;
  /** The single canonical root Requirement for this Project. Bound once through the Requirement transaction. */
  rootRequirementId?: string;
  /**
   * Optional Project-level default Requirement priority for cross-project
   * dispatch selection (#707). Explicit Requirement.priority always wins.
   */
  defaultRequirementPriority?: ProjectDefaultRequirementPriority;
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
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'archived') throw new Error('PROJECT_STATUS_INVALID');
  const sourceFingerprint = input.sourceFingerprint?.trim();
  if (sourceFingerprint && !/^[a-f0-9]{64}$/i.test(sourceFingerprint))
    throw new Error('PROJECT_SOURCE_FINGERPRINT_INVALID');
  const rootRequirementId = input.rootRequirementId?.trim();
  if (rootRequirementId && rootRequirementId.length > 160) throw new Error('PROJECT_ROOT_REQUIREMENT_ID_INVALID');
  const defaultRequirementPriority = input.defaultRequirementPriority?.trim() as
    | ProjectDefaultRequirementPriority
    | undefined;
  if (
    defaultRequirementPriority &&
    !(PROJECT_DEFAULT_REQUIREMENT_PRIORITIES as readonly string[]).includes(defaultRequirementPriority)
  ) {
    throw new Error('PROJECT_DEFAULT_REQUIREMENT_PRIORITY_INVALID');
  }
  return {
    schemaVersion: 1,
    projectId,
    workspaceId,
    displayName,
    status,
    ...(sourceFingerprint ? { sourceFingerprint: sourceFingerprint.toLowerCase() } : {}),
    ...(rootRequirementId ? { rootRequirementId } : {}),
    ...(defaultRequirementPriority ? { defaultRequirementPriority } : {}),
  };
}

export function projectPlacement(input: Omit<ProjectPlacement, 'schemaVersion'>): ProjectPlacement {
  const projectId = boundedId(input.projectId, 'PROJECT_ID_INVALID');
  const forgeInstanceId = boundedId(input.forgeInstanceId, 'FORGE_INSTANCE_ID_INVALID');
  const repositoryId = boundedId(input.repositoryId, 'PROJECT_REPOSITORY_ID_INVALID');
  const checkoutId = input.checkoutId?.trim();
  if (checkoutId && checkoutId.length > 512) throw new Error('PROJECT_CHECKOUT_ID_INVALID');
  return { schemaVersion: 1, projectId, forgeInstanceId, repositoryId, ...(checkoutId ? { checkoutId } : {}) };
}
