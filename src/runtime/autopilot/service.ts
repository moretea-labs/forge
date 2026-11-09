import { recordCanonicalGrant, revokeCanonicalGrant, listCanonicalGrants } from '../../../packages/kernel/identity/api';
import { readRequirement, requirementSemanticView } from '../control-plane/persistence/requirement-store';
import { listPlanContracts } from '../control-plane/facade/plan-contract-store';
import { createAutopilotRun, defaultAutopilotPolicy, readAutopilotRun, setAutopilotRunStatus, updateAutopilotRun } from './store';
import { runAutopilotLoop, type AutopilotRunnerDependencies } from './runner';
import type { AutopilotPolicy } from './types';
import { readAutopilotProviderApiKey } from './provider-config';

const CAPABILITY = 'autopilot:execute';
const activeLoops = new Map<string, AbortController>();

function loopKey(controllerHome: string, repoId: string, requirementId: string): string {
  return `${controllerHome}\n${repoId}\n${requirementId}`;
}
function ownerScope(repoId: string, requirementId: string): string {
  return `forge-autopilot:${repoId}:${requirementId}`;
}
function target(repoId: string, requirementId: string) {
  return {
    kind: 'requirement',
    id: requirementId,
    repoId,
    scopeRef: { schemaVersion: 1 as const, kind: 'requirement' as const, id: requirementId },
  };
}
function constraints(requirementRevision: number, checkoutId: string, policy: AutopilotPolicy) {
  return {
    requirementRevision,
    checkoutId,
    provider: policy.provider,
    endpoint: policy.endpoint,
    protocol: policy.protocol,
    model: policy.model,
    maxTotalTokens: policy.maxTotalTokens,
    maxTurns: policy.maxTurns,
    maxToolCalls: policy.maxToolCalls,
    checkpointPlanIds: policy.checkpointPlanIds,
  };
}

export function activeAutopilotGrant(controllerHome: string, repoId: string, requirementId: string) {
  const now = Date.now();
  return listCanonicalGrants(controllerHome, { ownerScope: ownerScope(repoId, requirementId) })
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > now && grant.capabilities.includes(CAPABILITY))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}


function policyFromGrant(constraints: Record<string, unknown>): AutopilotPolicy {
  const provider = constraints.provider === 'joycode' ? 'joycode' : 'deepseek';
  return defaultAutopilotPolicy({
    provider,
    endpoint: String(constraints.endpoint ?? (provider === 'joycode' ? 'https://api-ai.jd.com' : 'https://api.deepseek.com')),
    protocol: provider === 'joycode' ? 'chat_completions' : (constraints.protocol === 'responses' ? 'responses' : 'chat_completions'),
    model: String(constraints.model ?? (provider === 'joycode' ? 'JoyAI-Code-1.6' : 'deepseek-chat')),
    maxTotalTokens: Number(constraints.maxTotalTokens),
    maxTurns: Number(constraints.maxTurns),
    maxToolCalls: Number(constraints.maxToolCalls),
    checkpointPlanIds: Array.isArray(constraints.checkpointPlanIds) ? constraints.checkpointPlanIds.map(String) : [],
  });
}

function providerApiKey(policy: AutopilotPolicy, supplied?: string): string | undefined {
  if (policy.provider === 'joycode') return undefined;
  const apiKey = supplied ?? readAutopilotProviderApiKey(policy.endpoint);
  if (!apiKey?.trim()) throw new Error('AUTOPILOT_DEEPSEEK_API_KEY_MISSING');
  return apiKey;
}

function isBudgetPause(reason: string | undefined): boolean {
  return reason === 'max_total_tokens_reached'
    || reason === 'max_turns_reached'
    || reason === 'max_tool_calls_reached';
}

function sameExecutionPolicy(left: AutopilotPolicy, right: AutopilotPolicy): boolean {
  return left.provider === right.provider
    && left.endpoint === right.endpoint
    && left.protocol === right.protocol
    && left.model === right.model
    && JSON.stringify(left.checkpointPlanIds) === JSON.stringify(right.checkpointPlanIds);
}

function validateBudgetRefresh(current: NonNullable<ReturnType<typeof readAutopilotRun>>['value'], next: AutopilotPolicy): void {
  if (!sameExecutionPolicy(current.policy, next)) {
    throw new Error('AUTOPILOT_BUDGET_REAUTHORIZATION_POLICY_CHANGED');
  }
  if (next.maxTotalTokens < 1_000 || next.maxTurns < 1 || next.maxToolCalls < 1) {
    throw new Error('AUTOPILOT_BUDGET_REAUTHORIZATION_INSUFFICIENT');
  }
}

export function authorizeAutopilot(input: {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  requirementId: string;
  principalId?: string;
  confirmAuthorization: boolean;
  policy?: Partial<AutopilotPolicy>;
  expiresInMinutes?: number;
}) {
  if (!input.confirmAuthorization) throw new Error('AUTOPILOT_AUTHORIZATION_CONFIRMATION_REQUIRED');
  // The adapter resolves the exact checkout through the canonical Repository
  // Registry; Runtime consumes the explicit fact instead of reaching into CLI.
  const checkoutId = input.checkoutId?.trim();
  if (!checkoutId) throw new Error('AUTOPILOT_CHECKOUT_REQUIRED');
  const requirementRecord = readRequirement({ controllerHome: input.controllerHome }, input.requirementId);
  if (!requirementRecord) throw new Error(`AUTOPILOT_REQUIREMENT_NOT_FOUND: ${input.requirementId}`);
  const requirement = requirementSemanticView(requirementRecord.value);
  if (requirement.repoId && requirement.repoId !== input.repoId) {
    throw new Error(`AUTOPILOT_REQUIREMENT_REPOSITORY_CONFLICT: ${requirement.repoId}`);
  }
  if (requirement.state !== 'open') throw new Error(`AUTOPILOT_REQUIREMENT_NOT_OPEN: ${requirement.state}`);
  const policy = defaultAutopilotPolicy(input.policy);
  if (policy.checkpointPlanIds.length > 0) {
    const ownedPlanIds = new Set(listPlanContracts({
      controllerHome:input.controllerHome,repoId:input.repoId,status:'active',limit:100,
    }).filter((plan) => plan.requirementId === input.requirementId).map((plan) => plan.planId));
    const invalid = policy.checkpointPlanIds.filter((planId) => !ownedPlanIds.has(planId));
    if (invalid.length > 0) throw new Error(`AUTOPILOT_CHECKPOINT_PLAN_MISMATCH: ${invalid.join(',')}`);
  }
  const existingRun = readAutopilotRun(input.controllerHome,input.repoId,input.requirementId);
  const budgetRefresh = existingRun?.value.status === 'paused' && isBudgetPause(existingRun.value.stopReason)
    ? existingRun
    : undefined;
  if (budgetRefresh) {
    if (budgetRefresh.value.requirementRevision !== requirement.revision
        || budgetRefresh.value.checkoutId !== checkoutId) {
      throw new Error('AUTOPILOT_BUDGET_REAUTHORIZATION_SCOPE_CHANGED');
    }
    validateBudgetRefresh(budgetRefresh.value, policy);
  }
  const previous = activeAutopilotGrant(input.controllerHome,input.repoId,input.requirementId);
  if (previous) {
    revokeCanonicalGrant(input.controllerHome,{
      grantId:previous.grantId,
      ownerScope:ownerScope(input.repoId,input.requirementId),
      reason:'superseded_by_new_autopilot_authorization',
    });
  }
  const grant = recordCanonicalGrant(input.controllerHome, {
    principalId: input.principalId?.trim() || 'forge-local-user',
    ownerScope: ownerScope(input.repoId, input.requirementId),
    capabilities: [CAPABILITY],
    target: target(input.repoId, input.requirementId),
    riskCeiling: 'workspace_write',
    constraints: constraints(requirement.revision, checkoutId, policy),
    expiresInMinutes: input.expiresInMinutes,
  });
  const refreshedRun = budgetRefresh
    ? updateAutopilotRun(input.controllerHome,input.repoId,input.requirementId,(run) => ({
        ...run,
        grantId: grant.grantId,
        policy,
        budgetBaseline: {
          totalTokens: run.usage.totalTokens,
          turns: run.usage.turns,
          toolCalls: run.usage.toolCalls,
        },
      }),'autopilot_budget_reauthorized')
    : undefined;
  return { grant, requirement, policy, checkoutId, refreshedRun: refreshedRun?.value };
}

export function revokeAutopilot(input: {
  controllerHome: string;
  repoId: string;
  requirementId: string;
  reason?: string;
}) {
  const grant = activeAutopilotGrant(input.controllerHome, input.repoId, input.requirementId);
  if (!grant) throw new Error('AUTOPILOT_ACTIVE_GRANT_NOT_FOUND');
  const revoked = revokeCanonicalGrant(input.controllerHome, {
    grantId: grant.grantId,
    ownerScope: ownerScope(input.repoId, input.requirementId),
    reason: input.reason?.trim() || 'autopilot authorization revoked',
  });
  activeLoops.get(loopKey(input.controllerHome, input.repoId, input.requirementId))?.abort();
  const run = readAutopilotRun(input.controllerHome, input.repoId, input.requirementId);
  if (run && ['running', 'paused'].includes(run.value.status)) {
    setAutopilotRunStatus(input.controllerHome, input.repoId, input.requirementId, 'cancelled', 'authorization_revoked');
  }
  return revoked;
}

function launch(
  controllerHome: string,
  repoId: string,
  requirementId: string,
  grantId: string,
  requirementRevision: number,
  dependencies?: AutopilotRunnerDependencies,
): void {
  const key = loopKey(controllerHome, repoId, requirementId);
  if (activeLoops.has(key)) throw new Error('AUTOPILOT_ALREADY_RUNNING');
  const controller = new AbortController();
  activeLoops.set(key, controller);
  void runAutopilotLoop(controllerHome, repoId, requirementId, controller.signal, {
    ...dependencies,
    validateAuthorization:() => {
      const grant = activeAutopilotGrant(controllerHome,repoId,requirementId);
      if (!grant) return { ok:false,reason:'authorization_expired_or_revoked' };
      if (grant.grantId !== grantId) return { ok:false,reason:'authorization_superseded' };
      if (Number(grant.constraints?.requirementRevision) !== requirementRevision) {
        return { ok:false,reason:'authorization_revision_mismatch' };
      }
      return { ok:true };
    },
  })
    .catch((error) => {
      const current = readAutopilotRun(controllerHome, repoId, requirementId);
      if (!current || current.value.status !== 'running') return;
      const message = error instanceof Error ? error.message : String(error);
      setAutopilotRunStatus(controllerHome, repoId, requirementId, 'failed', message);
    })
    .finally(() => {
      if (activeLoops.get(key) === controller) activeLoops.delete(key);
    });
}

export function startAutopilot(input: {
  controllerHome: string;
  repoId: string;
  requirementId: string;
  dependencies?: AutopilotRunnerDependencies;
}) {
  const requirementRecord = readRequirement({ controllerHome: input.controllerHome }, input.requirementId);
  if (!requirementRecord) throw new Error(`AUTOPILOT_REQUIREMENT_NOT_FOUND: ${input.requirementId}`);
  const requirement = requirementSemanticView(requirementRecord.value);
  const grant = activeAutopilotGrant(input.controllerHome, input.repoId, input.requirementId);
  if (!grant) throw new Error('AUTOPILOT_EXACT_GRANT_REQUIRED');
  const enrolled = grant.constraints ?? {};
  if (Number(enrolled.requirementRevision) !== requirement.revision) {
    throw new Error(`AUTOPILOT_REQUIREMENT_REVISION_REAPPROVAL_REQUIRED: approved=${String(enrolled.requirementRevision)},current=${requirement.revision}`);
  }
  const checkoutId = String(enrolled.checkoutId ?? '').trim();
  if (!checkoutId) throw new Error('AUTOPILOT_GRANT_CHECKOUT_MISSING');
  const policy = policyFromGrant(enrolled as Record<string, unknown>);
  const apiKey = providerApiKey(policy, input.dependencies?.apiKey);
  const run = createAutopilotRun(input.controllerHome, {
    repoId: input.repoId,
    checkoutId,
    requirementId: input.requirementId,
    requirementRevision: requirement.revision,
    grantId: grant.grantId,
    policy,
  });
  launch(input.controllerHome,input.repoId,input.requirementId,grant.grantId,requirement.revision,{...input.dependencies,apiKey});
  return run;
}

export function pauseAutopilot(controllerHome: string, repoId: string, requirementId: string) {
  const current = readAutopilotRun(controllerHome, repoId, requirementId);
  if (!current) throw new Error('AUTOPILOT_RUN_NOT_FOUND');
  if (current.value.status !== 'running') throw new Error(`AUTOPILOT_NOT_RUNNING: ${current.value.status}`);
  const key = loopKey(controllerHome, repoId, requirementId);
  activeLoops.get(key)?.abort();
  return setAutopilotRunStatus(controllerHome, repoId, requirementId, 'paused', 'paused_by_user');
}

export function resumeAutopilot(input: {
  controllerHome: string;
  repoId: string;
  requirementId: string;
  dependencies?: AutopilotRunnerDependencies;
}) {
  const run = readAutopilotRun(input.controllerHome, input.repoId, input.requirementId);
  if (!run) throw new Error('AUTOPILOT_RUN_NOT_FOUND');
  const key = loopKey(input.controllerHome,input.repoId,input.requirementId);
  if (activeLoops.has(key)) throw new Error('AUTOPILOT_ALREADY_RUNNING');
  if (!['paused','blocked','failed','running'].includes(run.value.status)) {
    throw new Error(`AUTOPILOT_RESUME_STATE_INVALID: ${run.value.status}`);
  }
  const apiKey = providerApiKey(run.value.policy, input.dependencies?.apiKey);
  const requirementRecord = readRequirement({ controllerHome: input.controllerHome }, input.requirementId);
  if (!requirementRecord) throw new Error('AUTOPILOT_REQUIREMENT_NOT_FOUND');
  const requirement = requirementSemanticView(requirementRecord.value);
  const grant = activeAutopilotGrant(input.controllerHome, input.repoId, input.requirementId);
  if (!grant || grant.grantId !== run.value.grantId) throw new Error('AUTOPILOT_EXACT_GRANT_REQUIRED');
  if (requirement.revision !== run.value.requirementRevision) {
    throw new Error(`AUTOPILOT_REQUIREMENT_REVISION_REAPPROVAL_REQUIRED: approved=${run.value.requirementRevision},current=${requirement.revision}`);
  }
  const updated = run.value.status === 'running'
    ? run
    : setAutopilotRunStatus(input.controllerHome,input.repoId,input.requirementId,'running');
  launch(input.controllerHome,input.repoId,input.requirementId,grant.grantId,requirement.revision,{...input.dependencies,apiKey});
  return updated;
}

export function autopilotStatus(controllerHome: string, repoId: string, requirementId: string) {
  const run = readAutopilotRun(controllerHome,repoId,requirementId);
  const grant = activeAutopilotGrant(controllerHome,repoId,requirementId);
  const requirementRecord = readRequirement({ controllerHome },requirementId);
  const requirement = requirementRecord ? requirementSemanticView(requirementRecord.value) : undefined;
  const approvedRevision = grant ? Number(grant.constraints?.requirementRevision) : undefined;
  return {
    run:run?.value,
    runRevision:run?.revision,
    grant,
    requirementRevision:requirement?.revision,
    approvedRevision:Number.isFinite(approvedRevision) ? approvedRevision : undefined,
    requiresReapproval:Boolean(grant && requirement && approvedRevision !== requirement.revision),
    runtimeActive:activeLoops.has(loopKey(controllerHome,repoId,requirementId)),
  };
}
