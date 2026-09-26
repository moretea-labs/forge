import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findActiveCanonicalGrant,
  listCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
  listUserRequests,
  recordUserRequest,
  resolveUserRequest,
  recordOwnedResource,
  listOwnedResources,
  markOwnedResourceCleaned,
  canonicalCapabilityRegistry,
  invokeCapability,
  recordDirectActivity,
  listDirectActivities,
  projectUnifiedActivityView,
} from '../../packages/kernel/identity/api/index';
import {
  createSchedule,
  extractScheduleDefinition,
  extractScheduleRuntimeState,
  getScheduleDefinition,
  getScheduleRuntimeState,
} from '../../packages/kernel/scheduler/api/index';
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
});  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });


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

    // Calling finalizeGoalWorkloop on an already semantically completed work is a
    // compatibility no-op: it succeeds without inventing a delivery/cleanup
    // receipt and without re-running the verify/review gates.
    const finalizeResult = finalizeGoalWorkloop({ workStore: store, handoffStore: { controllerHome }, repoId }, { workId });
    expect(finalizeResult.status).toBe('ok');
    expect(finalizeResult.data?.semanticWorkState).toBe('completed');
    expect(finalizeResult.data?.completionReceipt).toBeNull();
    expect(getWorkContract(store, workId)?.completionReceipt).toBeUndefined();
  });


  test('Step 5 & 3: OwnedResource tracks explicit ownership provenance and supports idempotent cleanup', () => {
    const controllerHome = tempHome();

    // 1) Record a Forge-owned worktree
    const worktreeResource = recordOwnedResource(controllerHome, {
      kind: 'worktree',
      targetRef: '/tmp/forge-isolated-worktree-1',
      creator: 'forge:worktree-manager',
      associatedWorkId: 'work-abc',
      retentionIntent: 'temporary',
    });
    expect(worktreeResource.resourceId).toBeDefined();
    expect(worktreeResource.status).toBe('active');
    expect(worktreeResource.provenance.creator).toBe('forge:worktree-manager');

    // 2) List owned active resources
    const active = listOwnedResources(controllerHome, { kind: 'worktree', status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].resourceId).toBe(worktreeResource.resourceId);

    // 3) Mark cleaned up with proof
    const cleaned = markOwnedResourceCleaned(
      controllerHome,
      worktreeResource.resourceId,
      'forge:cleanup-daemon',
      'receipt:git-worktree-remove-ok',
    );
    expect(cleaned?.status).toBe('released');
    expect(cleaned?.cleanupProof?.cleanedBy).toBe('forge:cleanup-daemon');

    // 4) Verify active list is now empty
    const remainingActive = listOwnedResources(controllerHome, { kind: 'worktree', status: 'active' });
    expect(remainingActive.length).toBe(0);
  });

  test('Step 2: Mode-free capability broker dispatches domain capability directly with typed handle and authorization', async () => {
    const controllerHome = tempHome();

    // 1) Register a domain capability
    canonicalCapabilityRegistry.register('browser:navigate', async (input) => {
      return {
        success: true,
        result: { currentUrl: input.arguments.url, title: 'Example Domain' },
        handle: {
          handleId: 'handle-browser-1',
          capabilityId: 'browser:navigate',
          executionKind: 'synchronous',
          target: input.target,
          status: 'completed',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: { currentUrl: input.arguments.url },
        },
      };
    });

    // 2) Unprivileged caller without grant fails authorization
    const unauthResult = await invokeCapability(controllerHome, {
      capabilityId: 'browser:navigate',
      principalId: 'unauthorized-user',
      target: { scope: 'global' },
      arguments: { url: 'https://example.com' },
    });
    expect(unauthResult.success).toBe(false);
    expect(unauthResult.error?.code).toBe('UNAUTHORIZED_CAPABILITY');

    // 3) Issue grant to principal
    recordCanonicalGrant(controllerHome, {
      principalId: 'test-agent',
      ownerScope: 'controller:global',
      capabilities: ['browser:*'],
      riskCeiling: 'workspace_write',
      expiresInMinutes: 60,
    });

    // 4) Authorized caller succeeds directly without Requirement, Plan, or Work
    const authResult = await invokeCapability(controllerHome, {
      capabilityId: 'browser:navigate',
      principalId: 'test-agent',
      target: { scope: 'global' },
      arguments: { url: 'https://example.com' },
    });
    expect(authResult.success).toBe(true);
    expect(authResult.result).toEqual({ currentUrl: 'https://example.com', title: 'Example Domain' });
    expect(authResult.handle?.status).toBe('completed');
  });

  test('Step 6: Direct capability activity without Work projects to Activity/history instead of synthetic Work', () => {
    const controllerHome = tempHome();

    // 1) Record direct capability execution (no associatedWorkId)
    const directAct = recordDirectActivity(controllerHome, {
      capabilityId: 'repository:read_file',
      kind: 'direct_execution',
      targetScope: 'repository:repo-foo',
      principalId: 'chatgpt-controller',
      status: 'completed',
      summary: 'Read README.md',
    });
    expect(directAct.activityId).toBeDefined();

    // 2) Record work-bound capability execution
    const workBoundAct = recordDirectActivity(controllerHome, {
      capabilityId: 'repository:edit_file',
      kind: 'work_bound',
      targetScope: 'repository:repo-foo',
      principalId: 'chatgpt-controller',
      associatedWorkId: 'work-plan-1',
      status: 'completed',
      summary: 'Patched bug',
    });

    // 3) Project unified view
    const view = projectUnifiedActivityView(controllerHome, [
      {
        type: 'work',
        id: 'work-plan-1',
        title: 'Fix issue',
        status: 'completed',
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    ]);

    expect(view.workTree.length).toBe(1);
    expect(view.workTree[0].id).toBe('work-plan-1');

    // Direct activities list contains only non-Work activities
    expect(view.directActivities.length).toBe(1);
    expect(view.directActivities[0].activityId).toBe(directAct.activityId);
    expect(view.directActivities[0].capabilityId).toBe('repository:read_file');
  });
});
