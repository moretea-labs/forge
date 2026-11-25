import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../src/effects/controller-home';
import { getToolPolicy } from '../../src/runtime/control-plane/tool-policy';
import { listRepositories, resolveRepositorySelection } from '../../src/runtime/repositories/registry';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import {
  createPlanSemanticContext,
  readPlanContractStore,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  readControlPlaneRecord,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('historical Plan workId metadata does not disable Requirement read-only access', async () => {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-legacy-plan-work-id-'));
  homes.push(controllerHome);
  ensureControllerHome(controllerHome);
  const requirementId = 'REQ-LEGACY-WORK-METADATA-READ';
  const planId = 'PLAN-LEGACY-WORK-METADATA-READ';

  createRequirement(
    { controllerHome },
    {
      requirementId,
      title: 'Keep canonical Requirement readable',
      outcomeStatement: 'Read the Requirement independently of historical Plan ownership.',
    },
  );

  createPlanSemanticContext(
    { controllerHome, scopeKey: SEMANTIC_SCOPE_KEY },
    {
      planId,
      requirementId,
      scopeKey: SEMANTIC_SCOPE_KEY,
      sourceBasisRevision: 'historical-source',
      goal: 'Historical Plan row remains readable.',
      items: [{ id: 'A', objective: 'Old semantic task', dependencies: [] }],
    },
  );
  const existing = readControlPlaneRecord<any>(controllerHome, 'plan_contract', SEMANTIC_SCOPE_KEY, planId);
  expect(existing).toBeDefined();
  withControlPlaneTransaction(controllerHome, (database) => {
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'plan_contract',
      scope: SEMANTIC_SCOPE_KEY,
      key: planId,
      schemaVersion: 1,
      value: {
        ...existing!.value,
        workId: 'WORK-RETIRED',
        steps: (existing!.value.steps ?? []).map((step: any) => ({
          ...step,
          workId: 'WORK-RETIRED',
        })),
      },
      action: 'test_historical_plan_metadata',
      expectedRevision: existing!.revision,
    });
  });
  const planStore = readPlanContractStore({ controllerHome, scopeKey: SEMANTIC_SCOPE_KEY });
  expect(planStore.contracts).toHaveLength(1);
  expect(planStore.contracts[0]?.planId).toBe(planId);

  const ctx = {
    repoRoot: controllerHome,
    controllerHome,
    policy: getToolPolicy('controller', { repoRoot: controllerHome }),
    toolset: 'full',
    repositoryAccess: { list: listRepositories, resolve: resolveRepositorySelection },
    enableChatgptBrowser: false,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  const reply = await callRuntimeTool(ctx, 'rh_project', {
    operation: 'requirement_get',
    requirement_id: requirementId,
    detail_level: 'detail',
  });
  expect(reply).toBeTruthy();
  const value = reply!.structuredContent as any;
  expect(value?.status).toBe('ok');
  expect(value?.data?.requirement?.requirementId).toBe(requirementId);
  expect(value?.data?.relatedPlans?.map((plan: any) => plan.planId)).toContain(planId);
});
