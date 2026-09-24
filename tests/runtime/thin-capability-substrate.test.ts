import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findActiveCanonicalGrant,
  listCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
} from '../../packages/kernel/identity/api/index';
import {
  createSchedule,
  extractScheduleDefinition,
  extractScheduleRuntimeState,
  getScheduleDefinition,
  getScheduleRuntimeState,
} from '../../packages/kernel/scheduler/api/index';
import {
  listUserRequests,
  recordUserRequest,
  resolveUserRequest,
} from '../../packages/kernel/identity/api/index';
import {
  createWorkContract,
  getWorkContract,
  isCurrentWorkContract,
  reviseWorkSemanticContext,
  workSemanticView,
} from '../../packages/kernel/work/api/index';
import { callRhWorkSemanticOperation } from '../../adapters/mcp/runtime-gateway/work-semantic-operations';
import { finalizeGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempHome(prefix = 'forge-thin-substrate-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('Thin capability substrate', () => {
  test('Step 3: Canonical Grant authority provides global and target-specific authorization without mandatory repoId', () => {
    const controllerHome = tempHome();

    // 1) Global capability grant without repository
    const globalGrant = recordCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      ownerScope: 'controller:global',
      capabilities: ['google_calendar:*', 'web_browser:read'],
      riskCeiling: 'workspace_write',
      expiresInMinutes: 60,
    });
    expect(globalGrant.grantId).toBeDefined();
    expect(globalGrant.capabilities).toContain('google_calendar:*');

    // 2) Query active grant
    const foundCalendar = findActiveCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      capability: 'google_calendar:events_list',
      risk: 'readonly',
    });
    expect(foundCalendar?.grantId).toBe(globalGrant.grantId);

    const foundBrowser = findActiveCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      capability: 'web_browser:read',
      risk: 'readonly',
    });
    expect(foundBrowser?.grantId).toBe(globalGrant.grantId);

    // Destructive is never pre-authorized
    const destructiveQuery = findActiveCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      capability: 'web_browser:read',
      risk: 'destructive',
    });
    expect(destructiveQuery).toBeUndefined();

    // 3) Revoke grant
    revokeCanonicalGrant(controllerHome, {
      grantId: globalGrant.grantId,
      ownerScope: 'controller:global',
      reason: 'test completed',
    });

    const revokedQuery = findActiveCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      capability: 'web_browser:read',
      risk: 'readonly',
    });
    expect(revokedQuery).toBeUndefined();
  });

  test('Step 4: ScheduleDefinition splits authored intent from mechanical runtime state', () => {
    const controllerHome = tempHome();
    const repoId = 'repo-schedule-thin';

    const schedule = createSchedule(controllerHome, {
      requestId: 'req-schedule-1',
      repoId,
      name: 'Nightly verification schedule',
      enabled: true,
      trigger: { type: 'interval', everyMinutes: 60 },
      policy: {
        maxActiveOccurrences: 1,
        maxFailures: 3,
        cooldownMinutes: 10,
        dailyBudgetMinutes: 120,
        shadowMode: false,
      },
      action: { operation: 'run_tests', arguments: { suite: 'unit' } },
      stopConditions: ['error_count > 5'],
    });

    const definition = extractScheduleDefinition(schedule);
    expect(definition.scheduleId).toBe(schedule.scheduleId);
    expect(definition.name).toBe('Nightly verification schedule');
    expect(definition.enabled).toBe(true);
    expect(definition.trigger.everyMinutes).toBe(60);
    expect((definition as any).lastTriggeredAt).toBeUndefined();
    expect((definition as any).consecutiveFailures).toBeUndefined();

    const runtimeState = extractScheduleRuntimeState(schedule);
    expect(runtimeState.scheduleId).toBe(schedule.scheduleId);
    expect(runtimeState.consecutiveFailures).toBe(0);

    const fetchedDef = getScheduleDefinition(controllerHome, repoId, schedule.scheduleId);
    expect(fetchedDef.name).toBe('Nightly verification schedule');
    const fetchedRuntime = getScheduleRuntimeState(controllerHome, repoId, schedule.scheduleId);
    expect(fetchedRuntime.consecutiveFailures).toBe(0);
  });

  test('Step 4: UserActionRequest / UserDecisionRequest coalesces repeated requests with identical rootCauseKey', () => {
    const controllerHome = tempHome();
    const rootCauseKey = 'provider_auth:google_calendar:missing_credentials';

    // 1) First request creation
    const req1 = recordUserRequest(controllerHome, {
      kind: 'user_action_request',
      rootCauseKey,
      title: 'Google Calendar Login Required',
      summary: 'OAuth token missing or expired for calendar integration.',
      actionRequired: 'login',
    });
    expect(req1.requestId).toBeDefined();
    expect(req1.status).toBe('pending');

    // 2) Duplicate creation attempt with same rootCauseKey returns the exact same request
    const req2 = recordUserRequest(controllerHome, {
      kind: 'user_action_request',
      rootCauseKey,
      title: 'Duplicate Calendar Login Attempt',
      summary: 'Retrying from another scheduled run.',
      actionRequired: 'login',
    });
    expect(req2.requestId).toBe(req1.requestId);

    const pendingList = listUserRequests(controllerHome, 'pending');
    expect(pendingList).toHaveLength(1);

    // 3) Resolving the request
    const resolved = resolveUserRequest(controllerHome, {
      requestId: req1.requestId,
      decision: 'user signed in successfully',
      resolvedBy: 'user-greyson',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution?.decision).toBe('user signed in successfully');

    expect(listUserRequests(controllerHome, 'pending')).toHaveLength(0);
  });

  test('Step 5 & 2: work_complete records semantic decision and enables finalization without verify/review gates', async () => {
    const controllerHome = tempHome();
    const repoId = 'repo-work-complete-test';
    const store = { controllerHome, repoId };
    const workId = 'work-thin-complete-1';

    createWorkContract(store, {
      workId,
      repoId,
      mode: 'direct_control',
      objective: 'Implement thin feature.',
      acceptanceCriteria: ['Must be thin and clean'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const initial = getWorkContract(store, workId)!;
    expect(isCurrentWorkContract(initial)).toBe(true);

    // Call work_complete directly via rh_work semantic operations
    const completeResult = await callRhWorkSemanticOperation(store, 'work_complete', {
      work_id: workId,
      expected_revision: 1,
      work_result_refs: ['git:commit:12345678', 'doc:summary:complete'],
    });

    expect(completeResult?.isError).toBeFalsy();
    const completedWork = getWorkContract(store, workId)!;
    expect(workSemanticView(completedWork).state).toBe('completed');
    expect(completedWork.status).toBe('completed');
    expect(isCurrentWorkContract(completedWork)).toBe(false);
    expect(workSemanticView(completedWork).resultRefs).toEqual(['git:commit:12345678', 'doc:summary:complete']);

    // Calling finalizeGoalWorkloop on a semantically completed work immediately succeeds with a receipt
    const finalizeResult = finalizeGoalWorkloop({ workStore: store, handoffStore: { controllerHome }, repoId }, { workId });
    expect(finalizeResult.status).toBe('ok');
    expect(finalizeResult.data?.finalStatus).toBe('completed');
    expect(finalizeResult.data?.completionReceipt).toBeDefined();
  });
});
