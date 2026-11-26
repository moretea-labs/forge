import {
  materializeWorkflowPackageBundle,
  type WorkflowPackageBundleV1,
} from '../../../packages/workflow-runtime/domain/workflow-package-bundle';
import type {
  WorkflowPackageChildDependencyV1,
  WorkflowPackageRiskV1,
  WorkflowPackageRuntimeCompatibilityV1,
} from '../../../packages/workflow-runtime/domain/workflow-package';
import type { WorkflowAssetContentLocation } from '../control-plane/persistence/workflow-content-store';
import { preflightWorkflowProposal, type WorkflowDraftProposalV1 } from './authoring';
import { installWorkflowPackage } from './package-install';
import { updateWorkflowPackage } from './package-update';

export interface PackagedWorkflowAuthoringMetadata {
  tags?: string[];
  runtimeCompatibility?: WorkflowPackageRuntimeCompatibilityV1;
  requiredWorkflows?: WorkflowPackageChildDependencyV1[];
  risk: WorkflowPackageRiskV1;
}

export interface PackagedWorkflowAuthoringAuthorization {
  canInstallWorkflows: boolean;
  canUpdateWorkflows: boolean;
}

export type PackagedWorkflowAuthoringResultV1 =
  | {
      schemaVersion: 1;
      operation: 'create';
      bundle: WorkflowPackageBundleV1;
      install: ReturnType<typeof installWorkflowPackage>;
    }
  | {
      schemaVersion: 1;
      operation: 'update';
      bundle: WorkflowPackageBundleV1;
      update: ReturnType<typeof updateWorkflowPackage>;
    };

function publisherFor(author: WorkflowDraftProposalV1['author']): WorkflowPackageBundleV1['manifest']['publisher'] {
  switch (author.kind) {
    case 'model':
      return { kind: 'model', id: author.id };
    case 'import':
      return { kind: 'import', id: author.id };
    case 'human':
    case 'ui':
      return { kind: 'user', id: author.id };
  }
}

/**
 * First-class authoring path: proposals are never persisted as bare Workflow
 * content. A validated Package Bundle is created first, then Package install/update
 * owns lifecycle and identity mutation. Authoring never activates a Workflow.
 */
export function applyPackagedWorkflowProposal(input: {
  controllerHome: string;
  proposal: unknown;
  destination: WorkflowAssetContentLocation;
  runtimeVersion: string;
  package: PackagedWorkflowAuthoringMetadata;
  authorization: PackagedWorkflowAuthoringAuthorization;
}): PackagedWorkflowAuthoringResultV1 {
  const preflight = preflightWorkflowProposal(input.controllerHome, input.proposal);
  if (!preflight.valid) throw new Error('WORKFLOW_PACKAGED_AUTHORING_PREFLIGHT_FAILED');
  const bundle = materializeWorkflowPackageBundle(preflight.asset, {
    tags: input.package.tags,
    runtimeCompatibility: input.package.runtimeCompatibility,
    requiredWorkflows: input.package.requiredWorkflows,
    risk: input.package.risk,
    publisher: publisherFor(preflight.author),
  });
  if (preflight.operation.kind === 'create') {
    const install = installWorkflowPackage({
      controllerHome: input.controllerHome,
      scope: preflight.scope,
      location: input.destination,
      bundle,
      runtimeVersion: input.runtimeVersion,
      authorization: { canInstallWorkflows: input.authorization.canInstallWorkflows },
    });
    return { schemaVersion: 1, operation: 'create', bundle, install };
  }
  const update = updateWorkflowPackage({
    controllerHome: input.controllerHome,
    scope: preflight.scope,
    location: input.destination,
    workflowId: preflight.descriptor.workflowId,
    bundle,
    runtimeVersion: input.runtimeVersion,
    expectedRegistryRevision: preflight.operation.expectedRegistryRevision,
    authorization: { canUpdateWorkflows: input.authorization.canUpdateWorkflows },
  });
  return { schemaVersion: 1, operation: 'update', bundle, update };
}
