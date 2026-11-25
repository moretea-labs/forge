import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { SEMANTIC_SCOPE_KEY } from '../../../src/effects/controller-home';
import { listControllerChecks } from '../../../src/runtime/execution/process-runtime/check-runner';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { isRhProjectAcceptedOperation } from '../../../src/runtime/control-plane/facade/rh-project-operation-contract';
import {
  findControlPlaneRecordsByKey,
  readControlPlaneRecord,
} from '../../../src/runtime/control-plane/persistence/sqlite-store';
import { result } from './result-adapter';
import { selected, selectedOptional } from './shared-adapter';
import { invalidFacadeOperation } from './status-inbox-adapter';
import { callRhProjectScheduleAdapter, isRhProjectScheduleOperation } from './scheduler-adapter';
import {
  callRhProjectRequirementOperation,
  isRhProjectRequirementOperation,
} from './rh-project-requirement-operations';
import { callRhProjectProjectOperation, isRhProjectProjectOperation } from './rh-project-project-operations';
import {
  callRhProjectPlanCreateOperation,
  callRhProjectPlanCreateWithoutRepository,
  callRhProjectPlanOperation,
  isRhProjectLightweightPlanOperation,
} from './rh-project-plan-operations';
import { callRhProjectWorkflowOperation } from './rh-project-workflow-operations';
import { callRhProjectLearningOperation } from './rh-project-learning-operations';
import { callRhProjectControllerOperation } from './rh-project-controller-operations';
import { runFacadeRepair } from './rh-project-repair-adapter';

export { runFacadeRepair };
export { runtimeIdentitySnapshot } from './controller-authority-adapter';

export function contextRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function contextText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function semanticStableSpec(operation: string) {
  if (operation === 'plan_get' || operation === 'plan_revise') {
    return { namespace: 'plan_contract', idField: 'plan_id' } as const;
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
    return result(
      buildFacadeResult({
        status: 'not_found',
        summary: 'Plan stable id is required.',
        data: {},
      }) as unknown as Record<string, unknown>,
      true,
    );
  }

  const explicitRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  let targetScope: string;
  if (explicitRepoId) {
    const exact = readControlPlaneRecord<unknown>(ctx.controllerHome, spec.namespace, explicitRepoId, id);
    if (!exact) {
      return result(
        buildFacadeResult({
          status: 'not_found',
          summary: 'Plan ' + id + ' not found in repository ' + explicitRepoId + '.',
          data: { planId: id, repoId: explicitRepoId },
        }) as unknown as Record<string, unknown>,
        true,
      );
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
      return result(
        buildFacadeResult({
          status: 'not_found',
          summary: 'Plan ' + id + ' not found.',
          data: { planId: id },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    if (matches.length > 1) {
      return result(
        buildFacadeResult({
          status: 'blocked',
          summary: `SEMANTIC_ID_SCOPE_AMBIGUOUS: ${id} resolves to ${matches.length} scopes.`,
          data: { id, scopes: matches.map((record) => record.scope).sort() },
        }) as unknown as Record<string, unknown>,
        true,
      );
    }
    targetScope = matches[0]!.scope;
  }

  const planStore = explicitRepoId
    ? { controllerHome: ctx.controllerHome, repoId: explicitRepoId }
    : { controllerHome: ctx.controllerHome, scopeKey: targetScope };
  return callRhProjectPlanOperation(planStore, operation, args);
}

/** Reject prototype-polluting input while keeping the direct typed operation path. */
function unsafeInputKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsafe = unsafeInputKey(item);
      if (unsafe) return unsafe;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return key;
    const unsafe = unsafeInputKey(child);
    if (unsafe) return unsafe;
  }
  return undefined;
}

/** Direct semantic operations only; Work-era carrier translation is retired. */
export async function callRhProjectAdapter(
  ctx: MultiRepositoryMcpToolContext,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const unsafe = unsafeInputKey(input);
  if (unsafe) {
    return result(
      buildFacadeResult({
        status: 'blocked',
        summary: 'MCP_INPUT_UNSAFE_KEY',
        data: { key: unsafe },
      }) as unknown as Record<string, unknown>,
      true,
    );
  }
  // Retired carriers are not translated to a live operation. Typed direct
  // fields are the only accepted interface.
  if (Object.hasOwn(input, 'capability_id')) {
    return result(
      buildFacadeResult({
        status: 'blocked',
        summary: 'CAPABILITY_ID_RETIRED',
        data: { retiredField: 'capability_id' },
      }) as unknown as Record<string, unknown>,
      true,
    );
  }
  const args = input;
  const operation = typeof args.operation === 'string' ? args.operation.trim() : '';
  if (!isRhProjectAcceptedOperation(operation)) return invalidFacadeOperation('rh_project', operation);

  if (isRhProjectProjectOperation(operation)) {
    const repository = selectedOptional(ctx, args);
    const project = callRhProjectProjectOperation(ctx, repository, operation, args);
    if (project) return project;
  }

  if (isRhProjectRequirementOperation(operation) && operation !== 'requirement_promote_candidate') {
    const repository = selectedOptional(ctx, args);
    const requirement = await callRhProjectRequirementOperation(ctx, repository, operation, args);
    if (requirement) return requirement;
  }

  const stableSemantic = await routeStableSemanticOperation(ctx, operation, args);
  if (stableSemantic) return stableSemantic;

  const repositoryOptionalPlan = await callRhProjectPlanCreateWithoutRepository(ctx, operation, args);
  if (repositoryOptionalPlan) return repositoryOptionalPlan;

  const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
  const explicitRepoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (projectId && !explicitRepoId && !ctx.explicitRepository && isRhProjectLightweightPlanOperation(operation)) {
    const projectPlan = await callRhProjectPlanOperation(
      { controllerHome: ctx.controllerHome, scopeKey: SEMANTIC_SCOPE_KEY },
      operation,
      args,
    );
    if (projectPlan) return projectPlan;
  }

  const repository = selected(ctx, args);
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };

  if (isRhProjectScheduleOperation(operation)) {
    return callRhProjectScheduleAdapter(ctx, repository, operation, args);
  }

  if (operation === 'launcher_start') {
    const controller = await callRhProjectControllerOperation(ctx, repository, operation, args);
    if (controller) return controller;
  }

  const workflow = await callRhProjectWorkflowOperation(ctx, repository, operation, args);
  if (workflow) return workflow;

  const learning = callRhProjectLearningOperation(ctx, repository, operation, args);
  if (learning) return learning;

  const requirement = await callRhProjectRequirementOperation(ctx, repository, operation, args);
  if (requirement) return requirement;

  const plan = await callRhProjectPlanOperation(store, operation, args);
  if (plan) return plan;

  const planCreate = await callRhProjectPlanCreateOperation(store, operation, args, {
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    checks: listControllerChecks(repository.canonicalRoot),
  });
  if (planCreate) return planCreate;

  if (operation === 'repair') {
    return runFacadeRepair(ctx, repository, args);
  }

  return invalidFacadeOperation('rh_project', operation);
}
