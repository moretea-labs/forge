export type WorkspacePlacementMode = 'current' | 'isolated' | 'auto';

export interface WorkspaceAdmissionConstraintInput {
  workspaceMode?: WorkspacePlacementMode;
  requireWorktree?: boolean;
  /**
   * Forbid repository mutation through the current/direct-main lane. This is
   * an admission constraint, not a routing hint: callers must never silently
   * downgrade it to Direct Control.
   */
  directMainProhibited?: boolean;
}

export interface WorkspaceAdmissionConstraint {
  workspaceMode: WorkspacePlacementMode;
  requireWorktree: boolean;
  directMainProhibited: boolean;
  requiresIsolation: boolean;
}

export type WorkspaceAdmissionResolution =
  | { ok: true; constraint: WorkspaceAdmissionConstraint }
  | { ok: false; code: 'WORKSPACE_PLACEMENT_CONSTRAINT_CONFLICT'; message: string };

/**
 * Canonicalize Work placement before Route Policy runs. Placement is a policy
 * fence: explicit isolation / direct-main prohibition has precedence over an
 * operator request for the fast Direct Control topology.
 */
export function resolveWorkspaceAdmissionConstraint(
  input: WorkspaceAdmissionConstraintInput = {},
): WorkspaceAdmissionResolution {
  const workspaceMode = input.workspaceMode ?? 'auto';
  const directMainProhibited = input.directMainProhibited === true;

  if (workspaceMode === 'current' && input.requireWorktree === true) {
    return {
      ok: false,
      code: 'WORKSPACE_PLACEMENT_CONSTRAINT_CONFLICT',
      message: 'workspaceMode=current conflicts with requireWorktree=true.',
    };
  }
  if (workspaceMode === 'isolated' && input.requireWorktree === false) {
    return {
      ok: false,
      code: 'WORKSPACE_PLACEMENT_CONSTRAINT_CONFLICT',
      message: 'workspaceMode=isolated conflicts with requireWorktree=false.',
    };
  }
  if (workspaceMode === 'current' && directMainProhibited) {
    return {
      ok: false,
      code: 'WORKSPACE_PLACEMENT_CONSTRAINT_CONFLICT',
      message: 'workspaceMode=current conflicts with directMainProhibited=true because the current lane cannot prove a non-main placement at admission time.',
    };
  }

  const requiresIsolation = workspaceMode === 'isolated'
    || input.requireWorktree === true
    || directMainProhibited;
  return {
    ok: true,
    constraint: {
      workspaceMode: requiresIsolation ? 'isolated' : workspaceMode,
      requireWorktree: requiresIsolation,
      directMainProhibited,
      requiresIsolation,
    },
  };
}
