import {
  assertResolvedAuthorization,
  requestExplicitAuthorization,
  type AuthorizationRequestRecord,
  type AuthorizationRiskClass,
} from '../control-plane/governance/authorization';
import type { WorkflowPackageRiskV1 } from '../../../packages/workflow-runtime/domain/workflow-package';
import type { WorkflowRegistryScope } from '../control-plane/persistence/workflow-registry-store';

const VERIFIED_WORKFLOW_PACKAGE_APPROVAL = Symbol('verified-workflow-package-approval');

export interface WorkflowPackageActivationApprovalProof {
  readonly workflowId: string;
  readonly packageDigest: string;
  readonly scopeKey: string;
  readonly approvalRequestId: string;
  readonly [VERIFIED_WORKFLOW_PACKAGE_APPROVAL]: true;
}

function workflowScopeKey(scope: WorkflowRegistryScope): string {
  return scope.kind === 'controller' ? 'controller' : `project:${scope.projectId}`;
}

function activationCommand(scope: WorkflowRegistryScope, workflowId: string, packageDigest: string): string[] {
  return ['workflow.package.activate', workflowScopeKey(scope), workflowId, packageDigest];
}

function authorizationRisk(risk: WorkflowPackageRiskV1['level']): AuthorizationRiskClass {
  switch (risk) {
    case 'read':
      return 'readonly';
    case 'workspace_write':
      return 'workspace_write';
    case 'external_write':
      return 'remote_write';
    case 'destructive':
      return 'destructive';
  }
}

export function requestWorkflowPackageActivationApproval(input: {
  controllerHome: string;
  repositoryId: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  packageDigest: string;
  risk: WorkflowPackageRiskV1['level'];
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
}): AuthorizationRequestRecord {
  const scopeKey = workflowScopeKey(input.scope);
  const command = activationCommand(input.scope, input.workflowId, input.packageDigest);
  return requestExplicitAuthorization({
    controllerHome: input.controllerHome,
    repositoryId: input.repositoryId,
    requestKey: command.join('\n'),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    permissionSnapshotVersion: input.permissionSnapshotVersion,
    risk: authorizationRisk(input.risk),
    humanSummary: `Activate Workflow ${input.workflowId} package ${input.packageDigest}.`,
    consequences: [
      `Workflow scope: ${scopeKey}`,
      `Package digest: ${input.packageDigest}`,
      `Declared package risk: ${input.risk}`,
      'Activation permits future authorized callers/triggers to invoke this exact package identity.',
    ],
    command,
  });
}

export function verifyWorkflowPackageActivationApproval(input: {
  controllerHome: string;
  repositoryId: string;
  approvalRequestId: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  packageDigest: string;
  sessionId?: string;
  principalId?: string;
  permissionSnapshotVersion: number;
}): WorkflowPackageActivationApprovalProof {
  assertResolvedAuthorization({
    controllerHome: input.controllerHome,
    repositoryId: input.repositoryId,
    approvalRequestId: input.approvalRequestId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    permissionSnapshotVersion: input.permissionSnapshotVersion,
    command: activationCommand(input.scope, input.workflowId, input.packageDigest),
  });
  return {
    workflowId: input.workflowId,
    packageDigest: input.packageDigest,
    scopeKey: workflowScopeKey(input.scope),
    approvalRequestId: input.approvalRequestId,
    [VERIFIED_WORKFLOW_PACKAGE_APPROVAL]: true,
  };
}

export function assertWorkflowPackageActivationApproval(
  proof: WorkflowPackageActivationApprovalProof | undefined,
  scope: WorkflowRegistryScope,
  workflowId: string,
  packageDigest: string,
): void {
  if (
    proof?.[VERIFIED_WORKFLOW_PACKAGE_APPROVAL] !== true ||
    proof.workflowId !== workflowId ||
    proof.packageDigest !== packageDigest ||
    proof.scopeKey !== workflowScopeKey(scope)
  ) {
    throw new Error('WORKFLOW_PACKAGE_ACTIVATE_APPROVAL_REQUIRED:' + packageDigest);
  }
}
