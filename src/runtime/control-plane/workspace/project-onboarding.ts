import { ensureForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  normalizeRemoteUrl,
  portableProjectSourceFingerprint,
  stablePortableProjectId,
} from '../../../cli/repositories/identity';
import { loadProjectEngineeringContract } from '../../context/project-engineering-contract';
import {
  ensureProjectWorkspaceBinding,
  type EnsureProjectWorkspaceBindingResult,
} from './workspace-store';

export type RepositoryProjectOnboardingResult =
  | {
      status: 'bound';
      projectId: string;
      workspaceId: string;
      forgeInstanceId: string;
      identitySource: 'project_contract' | 'canonical_remote';
      createdWorkspace: boolean;
      createdProject: boolean;
      createdPlacement: boolean;
    }
  | {
      status: 'unbound';
      reason: 'portable_project_identity_unavailable';
    };

/**
 * Bind a repository to portable Project/Workspace semantics only when Work
 * admission actually treats it as a project. Repository registration remains a
 * node-local placement concern and never creates semantic identity by itself.
 */
export function ensureRepositoryProjectOnboarding(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  sourceRevision?: string;
}): RepositoryProjectOnboardingResult {
  const contract = loadProjectEngineeringContract({
    repoRoot: input.repository.canonicalRoot,
    sourceRevision: input.sourceRevision?.trim() || 'working-tree',
  });
  const declaredProjectId = contract.status === 'ready' ? contract.contract.projectId : undefined;
  const canonicalRemote = input.repository.canonicalRemote ?? normalizeRemoteUrl(input.repository.remoteUrl);
  if (!declaredProjectId && !canonicalRemote) {
    return { status: 'unbound', reason: 'portable_project_identity_unavailable' };
  }

  const sourceFingerprint = canonicalRemote
    ? portableProjectSourceFingerprint(canonicalRemote)
    : undefined;
  const fallbackProjectId = canonicalRemote
    ? stablePortableProjectId(canonicalRemote)
    : undefined;
  const instance = ensureForgeInstanceIdentity({
    controllerHome: input.controllerHome,
    label: 'Forge Runtime',
  });
  const binding: EnsureProjectWorkspaceBindingResult = ensureProjectWorkspaceBinding({
    controllerHome: input.controllerHome,
    preferredProjectId: declaredProjectId,
    fallbackProjectId,
    sourceFingerprint,
    displayName: input.repository.displayName,
    forgeInstanceId: instance.instanceId,
    repositoryId: input.repository.repoId,
  });

  return {
    status: 'bound',
    projectId: binding.project.projectId,
    workspaceId: binding.project.workspaceId,
    forgeInstanceId: binding.placement.forgeInstanceId,
    identitySource: declaredProjectId ? 'project_contract' : 'canonical_remote',
    createdWorkspace: binding.createdWorkspace,
    createdProject: binding.createdProject,
    createdPlacement: binding.createdPlacement,
  };
}
