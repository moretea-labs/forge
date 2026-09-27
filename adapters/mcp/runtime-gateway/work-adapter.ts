import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { SEMANTIC_SCOPE_KEY } from '../../../src/cli/repositories/controller-home';
import { listControllerChecks } from '../../../src/cli/controller/check-runner';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { isRhWorkAcceptedOperation } from '../../../src/runtime/control-plane/facade/rh-work-operation-contract';
import { findControlPlaneRecordsByKey, readControlPlaneRecord } from '../../../src/runtime/control-plane/persistence/sqlite-store';
import { result } from './result-adapter';
import { selected } from './shared-adapter';
import { invalidFacadeOperation } from './status-inbox-adapter';
import { normalizeRhWorkInputCompatibility } from './work-input-compatibility';
import { callRhWorkScheduleAdapter, isRhWorkScheduleOperation } from './scheduler-adapter';
import { callRhWorkRequirementOperation, isRhWorkRequirementOperation } from './work-requirement-operations';
import { callRhWorkSemanticOperation } from './work-semantic-operations';
import {
  callRhWorkPlanCreateOperation,
  callRhWorkPlanCreateWithoutRepository,
  callRhWorkPlanOperation,
} from './work-plan-operations';
import { callRhWorkWorkflowOperation } from './work-workflow-operations';
import { callRhWorkLearningOperation } from './work-learning-operations';
import { callRhWorkControllerOperation } from './work-controller-operations';
import { runFacadeRepair } from './work-repair-adapter';

export { runFacadeRepair };
export { runtimeIdentitySnapshot } from './controller-authority-adapter';

export function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function semanticStableSpec(operation: string) {
  if (operation === 'work_get' || operation === 'work_revise' || operation === 'work_complete') {
    return { namespace: 'work_contract', idField: 'work_id', kind: 'work' as const };
  }
  if (operation === 'plan_get' || operation === 'plan_revise') {
    return { namespace: 'plan_contract', idField: 'plan_id', kind: 'plan' as const };
  }
  return undefined;
}

async function routeStableSemanticOperation(
  ctx: MultiRepositoryMcpToolContext,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  const spec = semanticStableSpec(operation);
  if (!spec) return undefined;

  const id = String(args[spec.idField] ?? '').trim();
  if (!id) {
    return result(buildFacadeResult({
      status: 'not_found',
      summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} stable id is required.`,
      data: {},
    }) as unknown as Record<string, unknown>, true);
  }

  const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim()
    ? args.repo_id.trim()
    : undefined;
  let targetScope: string;
  if (explicitRepoId) {
    const exact = readControlPlaneRecord<unknown>(ctx.controllerHome, spec.namespace, explicitRepoId, id);
    if (!exact) {
      return result(buildFacadeResult({
        status: 'not_found',
        summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} ${id} not found in repository ${explicitRepoId}.`,
        data: spec.kind === 'work' ? { workId: id, repoId: explicitRepoId } : { planId: id, repoId: explicitRepoId },
      }) as unknown as Record<string, unknown>, true);
    }
    targetScope = explicitRepoId;
  } else {
    const canonicalSemantic = readControlPlaneRecord<unknown>(
      ctx.controllerHome,
      spec.namespace,
      SEMANTIC_SCOPE_KEY,
      id,
    );
    const matches = canonicalSemantic
      ? [{ ...canonicalSemantic, scope: SEMANTIC_SCOPE_KEY }]
      : findControlPlaneRecordsByKey<unknown>(ctx.controllerHome, {
          namespace: spec.namespace,
          key: id,
          limit: 2,
        });
    if (matches.length === 0) {
      return result(buildFacadeResult({
        status: 'not_found',
        summary: `${spec.kind === 'work' ? 'Work' : 'Plan'} ${id} not found.`,
        data: spec.kind === 'work' ? { workId: id } : { planId: id },
      }) as unknown as Record<string, unknown>, true);
    }
    if (matches.length > 1) {
      return result(buildFacadeResult({
        status: 'blocked',
        summary: `SEMANTIC_ID_SCOPE_AMBIGUOUS: ${id} resolves to ${matches.length} scopes.`,
        data: { id, scopes: matches.map((record) => record.scope).sort() },
      }) as unknown as Record<string, unknown>, true);
    }
    targetScope = matches[0]!.scope;
  }

  const semanticStore = { controllerHome: ctx.controllerHome, scopeKey: targetScope };
  return spec.kind === 'work'
    ? callRhWorkSemanticOperation(semanticStore, operation, args)
    : callRhWorkPlanOperation(semanticStore, operation, args);
}

/**
 * Thin rh_work router.
 *
 * Work is semantic context only. Repository execution, checks, review, Git
 * delivery and cleanup are separate capabilities and never re-enter a Work
 * lifecycle here.
 */
export async function callWorkAdapter(
  ctx: MultiRepositoryMcpToolContext,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const compatibility = normalizeRhWorkInputCompatibility(input);
  if (!compatibility.ok) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: compatibility.summary,
      data: compatibility.data,
    }) as unknown as Record<string, unknown>, true);
  }

  const args = compatibility.args;
  const operation = compatibility.operation;
  if (!isRhWorkAcceptedOperation(operation)) return invalidFacadeOperation('rh_work', operation);

  if (isRhWorkRequirementOperation(operation) && operation !== 'requirement_promote_candidate') {
    const requirement = await callRhWorkRequirementOperation(ctx, undefined, operation, args);
    if (requirement) return requirement;
  }

  const stableSemantic = await routeStableSemanticOperation(ctx, operation, args);
  if (stableSemantic) return stableSemantic;

  const repositoryOptionalPlan = await callRhWorkPlanCreateWithoutRepository(ctx, operation, args);
  if (repositoryOptionalPlan) return repositoryOptionalPlan;

  if (operation === 'start') {
    const semanticStart = await callRhWorkSemanticOperation(
      { controllerHome: ctx.controllerHome, scopeKey: SEMANTIC_SCOPE_KEY },
      operation,
      args,
    );
    if (semanticStart) return semanticStart;
  }

  const repository = selected(ctx, args);
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };

  if (isRhWorkScheduleOperation(operation)) {
    return callRhWorkScheduleAdapter(ctx, repository, operation, args);
  }

  if (operation === 'launcher_start') {
    const controller = await callRhWorkControllerOperation(ctx, repository, operation, args);
    if (controller) return controller;
  }

  const workflow = await callRhWorkWorkflowOperation(ctx, repository, operation, args);
  if (workflow) return workflow;

  const learning = callRhWorkLearningOperation(ctx, repository, operation, args);
  if (learning) return learning;

  const requirement = await callRhWorkRequirementOperation(ctx, repository, operation, args);
  if (requirement) return requirement;

  const plan = await callRhWorkPlanOperation(store, operation, args);
  if (plan) return plan;

  const planCreate = await callRhWorkPlanCreateOperation(store, operation, args, {
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    checks: listControllerChecks(repository.canonicalRoot),
  });
  if (planCreate) return planCreate;

  if (operation === 'repair') return runFacadeRepair(ctx, repository, args);

  return invalidFacadeOperation('rh_work', operation);
}
