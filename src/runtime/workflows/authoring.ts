import {
  materializeWorkflowAsset,
  materializeWorkflowGraphAsset,
  workflowFeatureDescriptor,
  type WorkflowAssetDraft,
  type WorkflowExecutableAssetDefinition,
  type WorkflowFeatureDescriptorV1,
  type WorkflowGraphAssetDraft,
} from '../../../packages/workflow-runtime/api/index';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
  type WorkflowAssetContentLocation,
} from '../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  registerWorkflowFeatureAsset,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';

export type WorkflowProposalAuthorKind = 'human' | 'ui' | 'model' | 'import';

export interface WorkflowDraftProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  author: { kind: WorkflowProposalAuthorKind; id: string };
  scope: WorkflowRegistryScope;
  operation: { kind: 'create' } | { kind: 'update'; expectedRegistryRevision: number };
  draft: WorkflowAssetDraft | WorkflowGraphAssetDraft;
}

export interface WorkflowProposalIssue {
  code: string;
  message: string;
}

export interface WorkflowProposalPreflightV1 {
  schemaVersion: 1;
  proposalId: string;
  author: WorkflowDraftProposalV1['author'];
  scope: WorkflowRegistryScope;
  operation: WorkflowDraftProposalV1['operation'];
  descriptor: WorkflowFeatureDescriptorV1;
  asset: WorkflowExecutableAssetDefinition;
  valid: boolean;
  issues: WorkflowProposalIssue[];
  warnings: WorkflowProposalIssue[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHOR_KINDS = new Set<WorkflowProposalAuthorKind>(['human', 'ui', 'model', 'import']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(code);
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}
function normalizeScope(value: unknown): WorkflowRegistryScope {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('WORKFLOW_PROPOSAL_SCOPE_INVALID');
  if (value.kind === 'controller') {
    exact(value, ['kind'], 'WORKFLOW_PROPOSAL_SCOPE_FIELD_UNSUPPORTED');
    return { kind: 'controller' };
  }
  if (value.kind === 'project') {
    exact(value, ['kind', 'projectId'], 'WORKFLOW_PROPOSAL_SCOPE_FIELD_UNSUPPORTED');
    return { kind: 'project', projectId: boundedId(value.projectId, 'WORKFLOW_PROPOSAL_PROJECT_ID_INVALID') };
  }
  throw new Error('WORKFLOW_PROPOSAL_SCOPE_INVALID');
}

function materializeDraft(value: unknown): WorkflowExecutableAssetDefinition {
  if (!record(value)) throw new Error('WORKFLOW_PROPOSAL_DRAFT_INVALID');
  if (value.schemaVersion === 1) return materializeWorkflowAsset(value as unknown as WorkflowAssetDraft);
  if (value.schemaVersion === 2) return materializeWorkflowGraphAsset(value as unknown as WorkflowGraphAssetDraft);
  throw new Error('WORKFLOW_PROPOSAL_DRAFT_SCHEMA_UNSUPPORTED');
}

function normalizeProposal(input: unknown): WorkflowDraftProposalV1 & { asset: WorkflowExecutableAssetDefinition } {
  if (!record(input)) throw new Error('WORKFLOW_PROPOSAL_INVALID');
  exact(
    input,
    ['schemaVersion', 'proposalId', 'author', 'scope', 'operation', 'draft'],
    'WORKFLOW_PROPOSAL_FIELD_UNSUPPORTED',
  );
  if (input.schemaVersion !== 1) throw new Error('WORKFLOW_PROPOSAL_SCHEMA_VERSION_UNSUPPORTED');
  const proposalId = boundedId(input.proposalId, 'WORKFLOW_PROPOSAL_ID_INVALID');
  if (!record(input.author)) throw new Error('WORKFLOW_PROPOSAL_AUTHOR_INVALID');
  exact(input.author, ['kind', 'id'], 'WORKFLOW_PROPOSAL_AUTHOR_FIELD_UNSUPPORTED');
  if (!AUTHOR_KINDS.has(input.author.kind as WorkflowProposalAuthorKind))
    throw new Error('WORKFLOW_PROPOSAL_AUTHOR_KIND_INVALID');
  const author = {
    kind: input.author.kind as WorkflowProposalAuthorKind,
    id: boundedId(input.author.id, 'WORKFLOW_PROPOSAL_AUTHOR_ID_INVALID'),
  };
  if (!record(input.operation) || typeof input.operation.kind !== 'string')
    throw new Error('WORKFLOW_PROPOSAL_OPERATION_INVALID');
  let operation: WorkflowDraftProposalV1['operation'];
  if (input.operation.kind === 'create') {
    exact(input.operation, ['kind'], 'WORKFLOW_PROPOSAL_OPERATION_FIELD_UNSUPPORTED');
    operation = { kind: 'create' };
  } else if (input.operation.kind === 'update') {
    exact(input.operation, ['kind', 'expectedRegistryRevision'], 'WORKFLOW_PROPOSAL_OPERATION_FIELD_UNSUPPORTED');
    if (
      !Number.isSafeInteger(input.operation.expectedRegistryRevision) ||
      Number(input.operation.expectedRegistryRevision) < 1
    )
      throw new Error('WORKFLOW_PROPOSAL_REGISTRY_REVISION_INVALID');
    operation = { kind: 'update', expectedRegistryRevision: Number(input.operation.expectedRegistryRevision) };
  } else {
    throw new Error('WORKFLOW_PROPOSAL_OPERATION_KIND_INVALID');
  }
  return {
    schemaVersion: 1,
    proposalId,
    author,
    scope: normalizeScope(input.scope),
    operation,
    draft: structuredClone(input.draft) as WorkflowAssetDraft | WorkflowGraphAssetDraft,
    asset: materializeDraft(input.draft),
  };
}

function issue(code: string, message: string): WorkflowProposalIssue {
  return { code, message };
}

export function preflightWorkflowProposal(controllerHome: string, input: unknown): WorkflowProposalPreflightV1 {
  const proposal = normalizeProposal(input);
  const descriptor = workflowFeatureDescriptor(proposal.asset);
  const current = readWorkflowRegistryEntry(controllerHome, proposal.scope, descriptor.workflowId);
  const issues: WorkflowProposalIssue[] = [];
  const warnings: WorkflowProposalIssue[] = [];
  if (proposal.operation.kind === 'create' && current)
    issues.push(
      issue('WORKFLOW_PROPOSAL_ALREADY_EXISTS', `Workflow ${descriptor.workflowId} already exists in this scope.`),
    );
  if (proposal.operation.kind === 'update') {
    if (!current) {
      issues.push(
        issue('WORKFLOW_PROPOSAL_NOT_FOUND', `Workflow ${descriptor.workflowId} does not exist in this scope.`),
      );
    } else if (current.revision !== proposal.operation.expectedRegistryRevision) {
      issues.push(
        issue(
          'WORKFLOW_PROPOSAL_REVISION_CONFLICT',
          'Workflow registry revision changed since this proposal was authored.',
        ),
      );
    }
  }
  for (const childId of descriptor.childWorkflowDependencies) {
    const child = readWorkflowRegistryEntry(controllerHome, proposal.scope, childId);
    if (!child)
      warnings.push(issue('WORKFLOW_PROPOSAL_CHILD_NOT_INSTALLED', `Child workflow ${childId} is not installed yet.`));
  }
  if (descriptor.capabilityDependencies.length > 0) {
    warnings.push(
      issue(
        'WORKFLOW_PROPOSAL_CAPABILITY_BINDINGS_REQUIRED',
        'Capability bindings must be configured before invocation can become ready.',
      ),
    );
  }
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    author: proposal.author,
    scope: proposal.scope,
    operation: proposal.operation,
    descriptor,
    asset: proposal.asset,
    valid: issues.length === 0,
    issues,
    warnings,
  };
}

export interface WorkflowProposalApplyAuthorization {
  canInstallWorkflows: boolean;
}

function assertDestinationMatchesScope(scope: WorkflowRegistryScope, destination: WorkflowAssetContentLocation): void {
  if (scope.kind === 'controller') {
    if (destination.kind !== 'controller') throw new Error('WORKFLOW_PROPOSAL_DESTINATION_SCOPE_MISMATCH');
    return;
  }
  if (destination.kind !== 'project' || destination.contract.projectId !== scope.projectId)
    throw new Error('WORKFLOW_PROPOSAL_DESTINATION_SCOPE_MISMATCH');
}

/** Installs content only. Activation is deliberately a separate Workflow lifecycle operation. */
export function applyWorkflowProposal(
  controllerHome: string,
  input: unknown,
  destination: WorkflowAssetContentLocation,
  authorization: WorkflowProposalApplyAuthorization,
) {
  if (!authorization.canInstallWorkflows) throw new Error('WORKFLOW_PROPOSAL_INSTALL_NOT_AUTHORIZED');
  const preflight = preflightWorkflowProposal(controllerHome, input);
  if (!preflight.valid) throw new Error('WORKFLOW_PROPOSAL_PREFLIGHT_FAILED');
  assertDestinationMatchesScope(preflight.scope, destination);
  const written =
    preflight.asset.schemaVersion === 1
      ? writeWorkflowAssetContent(destination, (input as WorkflowDraftProposalV1).draft as WorkflowAssetDraft)
      : writeWorkflowGraphAssetContent(
          destination,
          (input as WorkflowDraftProposalV1).draft as WorkflowGraphAssetDraft,
        );
  return registerWorkflowFeatureAsset({
    controllerHome,
    scope: preflight.scope,
    asset: written.asset,
    contentLocation:
      preflight.scope.kind === 'controller'
        ? { kind: 'controller', path: written.path }
        : { kind: 'project', path: written.path, projectId: preflight.scope.projectId },
    status: 'installed',
    expectedRevision: preflight.operation.kind === 'create' ? null : preflight.operation.expectedRegistryRevision,
  });
}
