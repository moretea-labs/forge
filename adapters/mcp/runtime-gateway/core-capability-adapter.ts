import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { commitSelectedPaths, selectedPathDiff, stageSelectedPaths } from '../../../src/cli/repositories/selected-path-actions';
import { deliverWork } from '../../../src/runtime/control-plane/execution/work-delivery-service';
import { startOrResumeSession } from './execution-tools';
import { result } from './result-adapter';
import { selected } from './shared-adapter';
import { callWorkflowSupervisorAdapter } from './workflow-supervisor-adapter';
import {
  claimControllerRoundSession,
  getControllerRoundRelay,
  releaseObservedControllerSession,
  submitControllerRoundDisposition,
  type ControllerRoundDisposition,
} from '../../../packages/kernel/controller/api/index';
import { recoverControllerAuthority } from '../../../src/runtime/control-plane/execution/controller-authority-recovery';
import { authenticatedFacadeControllerIdentity, runtimeIdentitySnapshot } from './controller-authority-adapter';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function callCoreCapabilityAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'capability_execute') return undefined;
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const input = object(args.arguments);

  try {
    if (capabilityId === 'controller.workflow_supervisor') {
      const forwarded = await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', {
        ...input,
        operation: action,
        request_id: typeof args.request_id === 'string' ? args.request_id.trim() : '',
        ...(typeof args.repo_id === 'string' && args.repo_id.trim() ? { repo_id: args.repo_id.trim() } : {}),
      });
      return forwarded ?? result({ error: { code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE', message: 'Workflow Supervisor capability route is unavailable.' } }, true);
    }
    if (capabilityId === 'controller.round_recovery') {
      if (action !== 'recover_and_dispose') {
        return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported controller.round_recovery action: ${action || '<empty>'}` } }, true);
      }
      if (input.user_directed !== true) throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_USER_REQUIRED: user_directed=true is required.');
      const workId = typeof input.work_id === 'string' ? input.work_id.trim() : '';
      const recoveryReason = typeof input.recovery_reason === 'string' ? input.recovery_reason.trim() : '';
      const disposition = typeof input.disposition === 'string' ? input.disposition.trim() as ControllerRoundDisposition : undefined;
      const handoffId = typeof input.handoff_id === 'string' ? input.handoff_id.trim() : undefined;
      if (!workId) throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_WORK_REQUIRED');
      if (!recoveryReason) throw new Error('WORK_CONTROLLER_AUTHORITY_RECOVERY_REASON_REQUIRED');
      if (!disposition || !['continue_immediately', 'wait', 'wait_for_user', 'goal_complete'].includes(disposition)) {
        throw new Error('CONTROLLER_RELAY_DISPOSITION_INVALID');
      }
      if (disposition === 'wait_for_user' && !handoffId) throw new Error('CONTROLLER_RELAY_WAIT_FOR_USER_HANDOFF_REQUIRED');

      const repository = selected(ctx, args);
      const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
      const before = getControllerRoundRelay(store, workId);
      if (!before) throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_REQUIRED: ${workId}`);
      const identity = authenticatedFacadeControllerIdentity(ctx, {});
      const recovered = recoverControllerAuthority({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        repositoryActiveCheckoutId: repository.activeCheckoutId,
        workId,
        requestedBy: 'user',
        recoveryReason,
        identity,
        runtime: runtimeIdentitySnapshot(ctx),
        leaseMs: 60_000,
      });
      if (!('relay' in recovered)) throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_RELAY_REQUIRED: ${workId}`);
      if (before.providerDispatchEffectId && recovered.relay.providerDispatchEffectId !== before.providerDispatchEffectId) {
        throw new Error(`WORK_CONTROLLER_AUTHORITY_RECOVERY_EFFECT_CHANGED: ${workId}`);
      }

      const claimed = claimControllerRoundSession(store, {
        workId,
        relayWorkId: workId,
        sessionClaim: {
          workId,
          controllerId: identity.controllerId,
          controllerType: identity.controllerType,
          sessionId: identity.sessionId,
          principalId: identity.principalId,
          controllerInstanceId: identity.controllerInstanceId,
          leaseMs: 60_000,
        },
      });
      if (!claimed.relay || claimed.relay.status !== 'claimed') throw new Error(`CONTROLLER_RELAY_ROUND_NOT_CLAIMED: ${claimed.relay?.status ?? 'missing'}`);

      let disposed;
      let releaseResult;
      try {
        disposed = submitControllerRoundDisposition(store, {
          workId,
          identity: {
            controllerId: claimed.session.controllerId,
            controllerType: claimed.session.controllerType,
            principalId: claimed.session.principalId?.trim() || claimed.session.controllerId,
            controllerInstanceId: claimed.session.controllerInstanceId?.trim() || '',
            sessionId: claimed.session.sessionId,
          },
          disposition,
          relayScopeId: recovered.relay.relayScopeId,
          requirementId: recovered.relay.requirementId,
          ...(handoffId ? { handoffId } : {}),
          reason: recoveryReason,
        });
      } finally {
        releaseResult = releaseObservedControllerSession(store, {
          workId,
          actor: `controller-round-recovery:${identity.controllerId}`,
          owner: claimed.session,
        });
      }
      if (!releaseResult?.allowed) throw new Error(`WORK_CONTROLLER_RELEASE_FENCED: ${workId}:${releaseResult?.reason ?? 'unknown'}`);
      const after = getControllerRoundRelay(store, workId);
      return result({
        repoId: repository.repoId,
        workId,
        authorityRecovered: true,
        claimed: true,
        disposition,
        dispositionStatus: disposed.status,
        relayScopeId: disposed.relayScopeId,
        ownerReleased: true,
        providerDispatchEffectId: after?.providerDispatchEffectId,
        providerDispatchEffectPreserved: before.providerDispatchEffectId === after?.providerDispatchEffectId,
        providerRedispatched: false,
      });
    }
    if (capabilityId !== 'repository.git') {
      return result({ error: { code: 'CORE_CAPABILITY_UNSUPPORTED', message: `Unsupported core capability: ${capabilityId || '<empty>'}` } }, true);
    }
    const repository = selected(ctx, args);
    switch (action) {
      case 'diff_paths':
        return result({
          ...selectedPathDiff(repository, {
            paths: input.paths,
            staged: input.staged === true,
            maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : undefined,
          }),
        });
      case 'stage_paths': {
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: input.paths });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...staged,
        }, staged.execution.ok !== true);
      }
      case 'commit_paths': {
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          message: input.message,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...committed,
        }, Boolean(committed.error));
      }
      case 'deliver_work': {
        startOrResumeSession(ctx);
        const delivered = await deliverWork(ctx, {
          ...input,
          repo_id: repository.repoId,
        });
        return result(delivered);
      }
      default:
        return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported repository.git action: ${action || '<empty>'}` } }, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'CORE_CAPABILITY_FAILED', message } }, true);
  }
}
