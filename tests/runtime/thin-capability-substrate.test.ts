import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findActiveCanonicalGrant,
  listCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
  getUserRequest,
  listUserRequests,
  recordUserRequest,
  resolveUserRequest,
  userRequestStorePath,
  recordOwnedResource,
  listOwnedResources,
  markOwnedResourceCleaned,
  canonicalCapabilityRegistry,
  invokeCapability,
  recordDirectActivity,
  getDirectActivity,
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
import { recordUnknownSupervisorNotificationReceipt } from '../../src/runtime/root/workflow-supervisor-runtime';
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

    // 3) An ownerless, scoped grant stays bounded to its principal, exact target and minimum risk.
    const leastPrivilege = recordCanonicalGrant(controllerHome, {
      principalId: 'legacy-owner',
      capabilities: ['audit:read'],
      target: { kind: 'synthetic', id: 'exact-target' },
      scopes: ['audit.read'],
      expiresInMinutes: 60,
    });
    expect(leastPrivilege.riskCeiling).toBe('readonly');
    const exactQuery = {
      principalId: 'legacy-owner',
      capability: 'audit:read',
      target: { kind: 'synthetic', id: 'exact-target' },
      scopes: ['audit.read'],
    };
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, risk: 'readonly' })?.grantId).toBe(leastPrivilege.grantId);
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, risk: 'remote_write' })).toBeUndefined();
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, ownerScope: 'another-owner' })).toBeUndefined();
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, scopes: [] })).toBeUndefined();
    expect(findActiveCanonicalGrant(controllerHome, { capability: 'audit:read', target: exactQuery.target, scopes: exactQuery.scopes })).toBeUndefined();
    expect(findActiveCanonicalGrant(controllerHome, { principalId: 'legacy-owner', capability: 'audit:read' })).toBeUndefined();
    expect(findActiveCanonicalGrant(controllerHome, {
      principalId: 'legacy-owner',
      capability: 'audit:read',
      target: { kind: 'synthetic', id: 'exact-target' },
    })).toBeUndefined();
    const legacyPath = join(controllerHome, 'system', 'authorization-grants', 'grants.json');
    const legacyStore = JSON.parse(readFileSync(legacyPath, 'utf8')) as { grants: Array<Record<string, unknown>> };
    delete legacyStore.grants.find((grant) => grant.grantId === leastPrivilege.grantId)!.riskCeiling;
    writeFileSync(legacyPath, JSON.stringify(legacyStore));
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, risk: 'readonly' })?.grantId).toBe(leastPrivilege.grantId);
    expect(findActiveCanonicalGrant(controllerHome, { ...exactQuery, risk: 'remote_write' })).toBeUndefined();
    expect(() => revokeCanonicalGrant(controllerHome, {
      grantId: leastPrivilege.grantId,
      ownerScope: 'another-owner',
      reason: 'unauthorized revocation',
    })).toThrow('GRANT_OWNER_MISMATCH');

    // 4) Revoke grant
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
    expect(() => recordCanonicalGrant(controllerHome, {
      grantId: globalGrant.grantId,
      principalId: 'chatgpt-controller',
      ownerScope: 'controller:global',
      capabilities: ['google_calendar:*', 'web_browser:read'],
      riskCeiling: 'workspace_write',
    })).toThrow('GRANT_ID_REUSE_REQUIRES_NEW_ENROLLMENT');

    const freshEnrollment = recordCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller',
      ownerScope: 'controller:global',
      capabilities: ['google_calendar:*', 'web_browser:read'],
      riskCeiling: 'workspace_write',
    });
    expect(freshEnrollment.grantId).not.toBe(globalGrant.grantId);
    expect(listCanonicalGrants(controllerHome).find((entry) => entry.grantId === globalGrant.grantId)?.revokedAt).toBeDefined();
    expect(findActiveCanonicalGrant(controllerHome, {
      principalId: 'chatgpt-controller', capability: 'web_browser:read', risk: 'readonly',
    })?.grantId).toBe(freshEnrollment.grantId);
    const fixedStart = new Date('2026-10-21T10:00:00.000Z');
    const timeBoundGrant = recordCanonicalGrant(controllerHome, {
      principalId: 'time-bound-owner', ownerScope: 'controller:replay',
      capabilities: ['browser:read'], riskCeiling: 'readonly',
      expiresInMinutes: 60, now: fixedStart,
    });
    const replayedGrant = recordCanonicalGrant(controllerHome, {
      grantId: timeBoundGrant.grantId,
      principalId: 'time-bound-owner', ownerScope: 'controller:replay',
      capabilities: ['browser:read'], riskCeiling: 'readonly',
      expiresInMinutes: 90 * 24 * 60, now: new Date('2026-10-21T10:30:00.000Z'),
    });
    expect(replayedGrant.createdAt).toBe(timeBoundGrant.createdAt);
    expect(replayedGrant.expiresAt).toBe(timeBoundGrant.expiresAt);
    expect(replayedGrant.updatedAt).toBe('2026-10-21T10:30:00.000Z');
    expect(findActiveCanonicalGrant(controllerHome, {
      principalId: 'time-bound-owner', capability: 'browser:read', at: new Date('2026-10-21T11:01:00.000Z'),
    })).toBeUndefined();
    const boundFirst = recordCanonicalGrant(controllerHome, {
      principalId: 'device-bound-owner', ownerScope: 'controller:devices',
      target: { kind: 'desktop_app', id: 'some-app' },
      capabilities: ['credential:use'], scopes: ['credential.fill'],
      riskCeiling: 'workspace_write',
      constraints: { deviceId: 'local-device-a', use: { purpose: 'sign-in', limit: 1 } },
    });
    expect(() => recordCanonicalGrant(controllerHome, {
      grantId: boundFirst.grantId,
      principalId: 'device-bound-owner', ownerScope: 'controller:devices',
      target: { kind: 'desktop_app', id: 'some-app' },
      capabilities: ['credential:use'], scopes: ['credential.fill'],
      riskCeiling: 'workspace_write',
      constraints: { deviceId: 'local-device-b', use: { purpose: 'sign-in', limit: 1 } },
    })).toThrow('GRANT_IDENTITY_SCOPE_CHANGE_REQUIRES_NEW_ENROLLMENT');
    expect(listCanonicalGrants(controllerHome).find((row) => row.grantId === boundFirst.grantId)?.constraints).toEqual(boundFirst.constraints);
    const boundSecond = recordCanonicalGrant(controllerHome, {
      principalId: 'device-bound-owner', ownerScope: 'controller:devices',
      target: { kind: 'desktop_app', id: 'some-app' },
      capabilities: ['credential:use'], scopes: ['credential.fill'],
      riskCeiling: 'workspace_write',
      constraints: { deviceId: 'local-device-b', use: { purpose: 'sign-in', limit: 1 } },
    });
    expect(boundSecond.grantId).not.toBe(boundFirst.grantId);
    expect(listCanonicalGrants(controllerHome).filter((row) => [boundFirst.grantId, boundSecond.grantId].includes(row.grantId))).toHaveLength(2);
    const replayBound = recordCanonicalGrant(controllerHome, {
      grantId: boundFirst.grantId,
      principalId: 'device-bound-owner', ownerScope: 'controller:devices',
      target: { kind: 'desktop_app', id: 'some-app' },
      capabilities: ['credential:use'], scopes: ['credential.fill'],
      riskCeiling: 'workspace_write',
      constraints: { use: { limit: 1, purpose: 'sign-in' }, deviceId: 'local-device-a' },
    });
    expect(replayBound.grantId).toBe(boundFirst.grantId);
    expect(listCanonicalGrants(controllerHome).find((row) => row.grantId === boundSecond.grantId)).toBeDefined();
    expect(() => recordCanonicalGrant(controllerHome, {
      grantId: leastPrivilege.grantId,
      principalId: 'different-principal',
      capabilities: ['audit:read'],
      target: { kind: 'synthetic', id: 'exact-target' },
      scopes: ['audit.read'],
    })).toThrow('GRANT_IDENTITY_SCOPE_CHANGE_REQUIRES_NEW_ENROLLMENT');
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

  test('Step 4b: requestId remains one authority across legacy duplicate rows', () => {
    const controllerHome = tempHome();
    const path = userRequestStorePath(controllerHome);
    mkdirSync(join(controllerHome, 'system', 'user-requests'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      requests: [
        {
          schemaVersion: 1,
          requestId: 'duplicate-decision',
          kind: 'user_decision_request',
          rootCauseKey: 'legacy-root-a',
          title: 'Older duplicate',
          summary: 'Older compatibility row.',
          actionRequired: 'product_decision',
          status: 'pending',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
          requestId: 'duplicate-decision',
          kind: 'user_decision_request',
          rootCauseKey: 'legacy-root-b',
          title: 'Newer duplicate',
          summary: 'Newer compatibility row.',
          actionRequired: 'product_decision',
          status: 'pending',
          createdAt: '2026-10-01T00:00:01.000Z',
          updatedAt: '2026-10-01T00:00:01.000Z',
        },
      ],
    }, null, 2)}\n`);

    expect(listUserRequests(controllerHome, 'pending')).toHaveLength(1);
    expect(getUserRequest(controllerHome, 'duplicate-decision')?.title).toBe('Newer duplicate');
    expect(() => recordUserRequest(controllerHome, {
      requestId: 'duplicate-decision',
      kind: 'user_decision_request',
      rootCauseKey: 'new-conflicting-root',
      title: 'Conflicting request',
      summary: 'Must fail closed instead of creating a second authority.',
      actionRequired: 'product_decision',
    })).toThrow('USER_REQUEST_ID_CONFLICT');

    const resolved = resolveUserRequest(controllerHome, {
      requestId: 'duplicate-decision',
      decision: 'superseded by canonical decision',
      resolvedBy: 'chatgpt',
    });
    expect(resolved.status).toBe('resolved');
    expect(listUserRequests(controllerHome, 'pending')).toHaveLength(0);
    expect(listUserRequests(controllerHome, 'resolved')).toHaveLength(1);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { requests: Array<{ status: string }> };
    expect(persisted.requests).toHaveLength(2);
    expect(persisted.requests.every((request) => request.status === 'resolved')).toBe(true);
  });

  test('Step 5 & 2: complete records semantic decision and enables finalization without verify/review gates', async () => {
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
      constraints: {},
      requestedBy: 'chatgpt',
      dispatchState: 'running',
    });

    const initial = getWorkContract(store, workId)!;
    expect(isCurrentWorkContract(initial)).toBe(true);

    // Call complete directly via rh_work semantic operations
    const completeResult = await callRhWorkSemanticOperation(store, 'complete', {
      work_id: workId,
      expected_revision: 1,
      work_result_refs: ['git:commit:12345678', 'doc:summary:complete'],
    });

    expect(completeResult?.isError).toBeFalsy();
    const completedWork = getWorkContract(store, workId)!;
    expect(workSemanticView(completedWork).state).toBe('completed');
    expect(completedWork.semanticState).toBe('completed');
    expect(isCurrentWorkContract(completedWork)).toBe(false);
    expect(workSemanticView(completedWork).resultRefs).toEqual(['git:commit:12345678', 'doc:summary:complete']);

    expect(completedWork.completionReceipt).toBeUndefined();

    // Terminal semantic decisions are monotonic. If later evidence shows the
    // same root cause remains open, the model creates an explicit successor Work
    // and preserves this terminal audit record.
    expect(() => reviseWorkSemanticContext(store, workId, {
      expectedRevision: 2,
      state: 'open',
      resultRefs: ['reason:acceptance-still-open'],
    })).toThrow(`WORK_SEMANTIC_REOPEN_FORBIDDEN:${workId}:completed`);
  });


  test('Step 5 & 3: OwnedResource tracks explicit ownership provenance and supports idempotent cleanup', () => {
    const controllerHome = tempHome();

    // 1) Record a Forge-owned worktree
    const worktreePath = join(controllerHome, 'forge-isolated-worktree-1');
    mkdirSync(worktreePath, { recursive: true });
    const worktreeResource = recordOwnedResource(controllerHome, {
      kind: 'worktree',
      targetRef: worktreePath,
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

  test('unknown Gmail Supervisor notification keeps one exact receipt and never creates a second activity on repeated observation', () => {
    const home = tempHome();
    const receipt = {
      receiptId: 'PLG-unknown-send', requestId: 'wfsn_exact_unknown',
      pluginId: 'gmail', actionId: 'send_owner_notification',
      status: 'failed' as const, effectOutcome: 'outcome_unknown' as const,
    };
    expect(recordUnknownSupervisorNotificationReceipt(home, 'task-123', receipt.requestId, receipt)).toBe(true);
    const first = getDirectActivity(home, `workflow-supervisor-notification-unknown-${receipt.requestId}`);
    expect(first).toMatchObject({ status: 'failed', receiptRef: receipt.receiptId,
      targetScope: 'workflow-supervisor-task:task-123' });
    expect(recordUnknownSupervisorNotificationReceipt(home, 'task-123', receipt.requestId, receipt)).toBe(true);
    expect(() => recordUnknownSupervisorNotificationReceipt(home, 'task-123', receipt.requestId, {
      ...receipt, receiptId: 'PLG-conflicting-outcome',
    })).toThrow('WORKFLOW_SUPERVISOR_NOTIFICATION_RECEIPT_CONFLICT');
    expect(getDirectActivity(home, first!.activityId)).toEqual(first);
    expect(listDirectActivities(home).filter((item) => item.activityId === first!.activityId)).toHaveLength(1);
    expect(recordUnknownSupervisorNotificationReceipt(home, 'task-123', 'wrong-request-id', receipt)).toBe(false);
    expect(recordUnknownSupervisorNotificationReceipt(home, 'task-123', 'wfsn_success', {
      ...receipt, requestId: 'wfsn_success', status: 'succeeded', effectOutcome: undefined,
    })).toBe(false);
    expect(listDirectActivities(home)).toHaveLength(1);
  });

  test('Supervisor exhausted activity keeps one exact identity beyond a 200-item projection window', () => {
    const home = tempHome();
    const id = 'workflow-supervisor-stall-task-123';
    const startedAt = '2026-10-17T00:00:00.000Z';
    const original = recordDirectActivity(home, {
      activityId: id, capabilityId: 'workflow-supervisor.continuation',
      kind: 'direct_execution', targetScope: 'workflow-supervisor-task:task-123',
      principalId: 'forge-runtime', status: 'running', startedAt, summary: 'Exhausted provider resume',
    });
    for (let i = 0; i < 205; i++) recordDirectActivity(home, {
      activityId: `unrelated-${i}`, capabilityId: 'repository:read_file',
      kind: 'direct_execution', targetScope: 'repository:test', principalId: 'test',
      status: 'completed', startedAt: '2026-10-18T00:00:00.000Z', summary: 'Unrelated activity',
    });
    expect(listDirectActivities(home, 200).some((item) => item.activityId === id)).toBe(false);
    expect(getDirectActivity(home, id)).toEqual(original);
    recordDirectActivity(home, { ...original, status: 'completed', completedAt: '2026-10-18T01:00:00.000Z' });
    expect(getDirectActivity(home, id)?.status).toBe('completed');
    expect(getDirectActivity(home, 'does-not-exist')).toBeUndefined();
  });
});
