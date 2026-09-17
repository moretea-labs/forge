import { randomUUID } from 'crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  controllerRoundBlockerClass,
  getControllerRoundRelay,
  getControllerSession,
  rearmControllerRoundAfterProviderRecovery,
} from '../../../packages/kernel/controller/api/index';
import { recoverControllerAuthority } from '../../../src/runtime/control-plane/execution/controller-authority-recovery';
import { runStandaloneChatgptPrompt } from '../../../src/runtime/control-plane/launcher/chatgpt-work-continuation';
import {
  buildRecoveryAuditRecord,
  writeRecoveryAuditRecord,
  type RecoveryActionDescriptor,
} from '../../../src/runtime/recovery';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import {
  authenticatedFacadeControllerIdentity,
  runtimeIdentitySnapshot,
} from './controller-authority-adapter';
import { result } from './result-adapter';

const CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX = 'controller.provider.recover:';
const CONTROLLER_AUTHORITY_RECOVERY_CAPABILITY_PREFIX = 'controller.authority.recover:';
const CONTROLLER_PROVIDER_RECOVERY_AUDIT_ACTION: RecoveryActionDescriptor = {
  id: 'recovery.controller_provider_probe',
  title: 'Verify Controller provider recovery',
  description: 'Verify the current ChatGPT provider with a non-semantic probe before rearming one exact blocked ControllerRound.',
  class: 'unknown',
  risk: 'medium',
  confirmation: 'authorization',
  localOnly: false,
  boundedTo: ['controller_round', 'chatgpt_provider'],
};

export interface ControllerProviderRecoveryInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  workId: string;
  relayScopeId: string;
  authorityId: string;
  timeoutMs?: number;
  now?: () => string;
  probe?: typeof runStandaloneChatgptPrompt;
}

export async function recoverControllerRoundAfterVerifiedProviderRepair(input: ControllerProviderRecoveryInput) {
  const store = { controllerHome: input.controllerHome, repoId: input.repoId };
  const workId = input.workId.trim();
  const relayScopeId = input.relayScopeId.trim();
  const authorityId = input.authorityId.trim();
  const blocked = getControllerRoundRelay(store, workId);
  if (!blocked) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_RELAY_REQUIRED: ${workId}`);
  if (blocked.relayScopeId !== relayScopeId) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_SCOPE_MISMATCH: ${workId}`);
  if ((blocked.authorityId?.trim() || '') !== authorityId) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_AUTHORITY_MISMATCH: ${workId}`);
  if (controllerRoundBlockerClass(blocked) !== 'consecutive_failures') throw new Error(`CONTROLLER_PROVIDER_RECOVERY_BLOCKER_MISMATCH: ${workId}`);
  if (getControllerSession(store, workId)) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_ACTIVE_CLAIM: ${workId}`);

  const probe = input.probe ?? runStandaloneChatgptPrompt;
  const nonce = randomUUID();
  const probeResult = await probe({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    scopeId: `controller-provider-recovery:${workId}:${authorityId}`,
    prompt: `Forge provider recovery probe ${nonce}. Reply with ACK only. Do not invoke tools or modify external state.`,
    tabPolicy: 'new',
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  if (probeResult.status !== 'dispatched' || probeResult.providerDeliveryStatus !== 'dispatch_confirmed') {
    const code = probeResult.error?.code ?? `CHATGPT_PROVIDER_${probeResult.providerDeliveryStatus?.toUpperCase() ?? 'PROBE_FAILED'}`;
    throw new Error(`CONTROLLER_PROVIDER_RECOVERY_PROBE_FAILED: ${code}: ${probeResult.error?.message ?? probeResult.status}`);
  }

  const verifiedAt = input.now?.() ?? new Date().toISOString();
  if (Date.parse(verifiedAt) <= Date.parse(blocked.updatedAt)) throw new Error(`CONTROLLER_PROVIDER_RECOVERY_EVIDENCE_NOT_FRESH: ${workId}`);
  const audit = writeRecoveryAuditRecord(input.controllerHome, input.repoId, buildRecoveryAuditRecord({
    actor: 'rh_work.controller_provider_recovery',
    action: CONTROLLER_PROVIDER_RECOVERY_AUDIT_ACTION,
    result: 'succeeded',
    reason: `Verified provider recovery for exact ControllerRound ${workId}.`,
    evidence: [{
      source: 'chatgpt_provider_recovery_probe',
      message: 'ChatGPT provider dispatch was confirmed by a non-semantic recovery probe.',
      at: verifiedAt,
      details: {
        workId,
        relayScopeId,
        controllerAuthorityId: authorityId,
        blockedUpdatedAt: blocked.updatedAt,
        provider: probeResult.provider,
        providerDeliveryStatus: probeResult.providerDeliveryStatus,
        browserSessionId: probeResult.browserSessionId,
        executionPreferenceVerified: probeResult.executionPreferenceVerified,
      },
    }],
    at: verifiedAt,
  }));
  const relay = rearmControllerRoundAfterProviderRecovery(store, {
    workId,
    relayScopeId,
    authorityId,
    expectedUpdatedAt: blocked.updatedAt,
    evidenceId: audit.id,
  });
  return { relay, audit, probe: probeResult };
}

type RecoveryRepository = {
  repoId: string;
  canonicalRoot: string;
  activeCheckoutId: string;
};

export async function callRhWorkControllerRecoveryOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RecoveryRepository,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (operation !== 'repair' || typeof args.capability_id !== 'string') return undefined;

  const capability = args.capability_id.trim();
  if (capability.startsWith(CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX)) {
    const workId = capability.slice(CONTROLLER_PROVIDER_RECOVERY_CAPABILITY_PREFIX.length).trim();
    if (!workId) return undefined;
    const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    const relayScopeId = typeof args.relay_scope_id === 'string' ? args.relay_scope_id.trim() : '';
    const authorityId = typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '';
    if (!explicitWorkId || explicitWorkId !== workId) {
      return result(buildFacadeResult({ status: 'blocked', summary: `CONTROLLER_PROVIDER_RECOVERY_SCOPE_MISMATCH: capability targets ${workId}; exact work_id is required.`, data: { workId, providerRecovered: false } }) as unknown as Record<string, unknown>, true);
    }
    if (!relayScopeId || !authorityId) {
      return result(buildFacadeResult({ status: 'blocked', summary: 'CONTROLLER_PROVIDER_RECOVERY_AUTHORITY_REQUIRED: exact controller_authority_id and relay_scope_id are required.', data: { workId, providerRecovered: false } }) as unknown as Record<string, unknown>, true);
    }
    try {
      const recovered = await recoverControllerRoundAfterVerifiedProviderRepair({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        repoRoot: repository.canonicalRoot,
        workId,
        relayScopeId,
        authorityId,
        timeoutMs: typeof args.probe_timeout_ms === 'number' ? args.probe_timeout_ms : undefined,
      });
      return result(buildFacadeResult({
        summary: `Verified ChatGPT provider recovery and rearmed exact ControllerRound for Work ${workId} without changing semantic round identity or recovery budgets.`,
        data: { workId, providerRecovered: true, recoveryAuditId: recovered.audit.id, provider: recovered.probe.provider, relay: recovered.relay },
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller provider recovery failed.', data: { workId, providerRecovered: false } }) as unknown as Record<string, unknown>, true);
    }
  }

  if (capability.startsWith(CONTROLLER_AUTHORITY_RECOVERY_CAPABILITY_PREFIX)) {
    const workId = capability.slice(CONTROLLER_AUTHORITY_RECOVERY_CAPABILITY_PREFIX.length).trim();
    if (!workId) return undefined;
    const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
    if (!explicitWorkId || explicitWorkId !== workId) {
      return result(buildFacadeResult({ status: 'blocked', summary: `WORK_CONTROLLER_AUTHORITY_RECOVERY_SCOPE_MISMATCH: capability targets ${workId}; exact work_id is required.`, data: { workId, authorityRecovered: false } }) as unknown as Record<string, unknown>, true);
    }
    try {
      const recovered = recoverControllerAuthority({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        repositoryActiveCheckoutId: repository.activeCheckoutId,
        workId,
        requestedBy: typeof args.requested_by === 'string' ? args.requested_by : undefined,
        identity: authenticatedFacadeControllerIdentity(ctx, args, { allowTransportSessionRollover: true }),
        runtime: runtimeIdentitySnapshot(ctx),
        leaseMs: typeof args.lease_ms === 'number' ? args.lease_ms : undefined,
      });
      return result(buildFacadeResult({ summary: `Controller authority for exact Work ${workId} was recovered without changing semantic Work identity, relay scope, or recovery budgets.`, data: recovered }) as unknown as Record<string, unknown>);
    } catch (error) {
      return result(buildFacadeResult({ status: 'blocked', summary: error instanceof Error ? error.message : 'Controller authority recovery failed.', data: { workId, authorityRecovered: false } }) as unknown as Record<string, unknown>, true);
    }
  }

  return undefined;
}
