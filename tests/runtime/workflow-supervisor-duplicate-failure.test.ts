import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorStore } from '../../supervisor/store';

test('unchanged task-local browser failures retain bounded diagnostics without an unbounded journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-failure-coalesce-'));
  const store = new WorkflowSupervisorStore(root);
  const journal = new Database(join(root, 'supervisor', 'supervisor.sqlite'), { readonly: true });
  try {
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'task-browser-failure-coalesce';
    const conversationId = '12121212-3434-5656-7878-909090909092';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl,
      objective: 'Keep one transport recovery identity without replaying a Send.',
      completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      store.recordBrowserDeliveryAttemptFailure({
        taskId, conversationId, code: 'WORKFLOW_SUPERVISOR_PROVIDER_NO_PROGRESS_WATCHDOG',
      });
    }
    const failureCount = () => (journal.query("SELECT COUNT(*) AS total FROM events WHERE task_id=? AND kind='browser_delivery_attempt_failed'").get(taskId) as { total: number }).total;
    expect(failureCount()).toBe(3);

    // The next error class is new diagnostic evidence, independently bounded.
    for (let attempt = 0; attempt < 20; attempt++) {
      store.recordBrowserDeliveryAttemptFailure({
        taskId, conversationId, code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE',
      });
    }
    expect(failureCount()).toBe(6);

    // A real committed effect allows new diagnostic evidence. The next failure
    // is newly journaled without erasing the earlier observations.
    const effect = control.reserveEnrollment(taskId);
    control.observeEffect({ effectId: effect.effectId, observationId: 'failure-fuse-source-applied', outcome: 'applied' });
    expect(failureCount()).toBe(6);
    store.recordBrowserDeliveryAttemptFailure({
      taskId, conversationId, code: 'WORKFLOW_SUPERVISOR_PROVIDER_NO_PROGRESS_WATCHDOG', effectId: effect.effectId,
    });
    expect(failureCount()).toBe(7);

    // A stale tab from a previous conversation cannot charge the current one.
    store.recordBrowserDeliveryAttemptFailure({
      taskId, conversationId: '99999999-8888-7777-6666-555555555555',
      code: 'WORKFLOW_SUPERVISOR_PROVIDER_NO_PROGRESS_WATCHDOG', effectId: effect.effectId,
    });
    expect(failureCount()).toBe(7);
  } finally {
    journal.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected compact receipt is observed once per exact effect and unchanged assistant response', async () => {
  const { WorkflowSupervisorNativeBrowserAdapter } = await import('../../supervisor/native-browser-adapter');
  const { WorkflowSupervisorEphemeralDiscovery } = await import('../../supervisor/server');
  const { createTestChatgptTargetPort } = await import('./helpers/computer-chatgpt-target-harness');
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-receipt-coalesce-'));
  const store = new WorkflowSupervisorStore(root);
  try {
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'task-compact-receipt-coalesce';
    const conversationId = '12121212-3434-5656-7878-909090909093';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl, objective: 'Do not reparse an unchanged invalid receipt.',
      completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(taskId);
    control.observeEffect({ effectId: effect.effectId, observationId: 'compact-receipt-source-applied', outcome: 'applied' });
    const page = { evaluate: async <T>() => false as T, tabRef: () => ({ windowId: 'window-1', tabId: 'tab-1' }) };
    const targetPort = createTestChatgptTargetPort({
      listTabs: async () => ({
        entries: [{ windowId: 'window-1', tabId: 'tab-1', url: conversationUrl, title: 'receipt', active: true }],
        unavailableProducts: [],
      }),
      reattach: async () => page, create: async () => page, close: async () => undefined,
      snapshot: async () => ({
        url: conversationUrl, title: 'receipt', latestUserText: '',
        latestAssistantResponse: 'C 0000000', providerActivityText: '', providerFailureText: '',
        latestTurnRole: 'assistant', isGenerating: false,
      }),
      dispatchPrompt: async () => ({ dispatched: false, confirmed: false }),
    });
    const errors: string[] = [];
    const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
      targetPort, nowMs: () => 1_000, providerIdleGraceMs: 60_000,
      providerScopeKey: join(root, 'provider-scope'),
      sleep: async () => undefined,
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onError: (error) => { errors.push(String(error)); },
    });
    await adapter.runOnce();
    await adapter.runOnce();
    expect(errors.filter((e) => e.includes('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH'))).toHaveLength(1);
    expect(store.getLatestCompletion(taskId)).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('committed CONTINUE dispatches before slow browser cleanup without another scheduler wake', async () => {
  const { WorkflowSupervisorNativeBrowserAdapter } = await import('../../supervisor/native-browser-adapter');
  const { WorkflowSupervisorEphemeralDiscovery } = await import('../../supervisor/server');
  const { renderSupervisorReceipt } = await import('../../supervisor/protocol');
  const { createTestChatgptTargetPort } = await import('./helpers/computer-chatgpt-target-harness');
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-continuation-priority-'));
  const store = new WorkflowSupervisorStore(root);
  try {
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const taskId = 'continuation-cleanup-priority';
    const conversationId = '56565656-3434-7878-9090-121212121212';
    const conversationUrl = 'https://chatgpt.com/c/' + conversationId;
    control.registerTask({
      taskId, conversationId, conversationUrl,
      objective: 'Dispatch the successor of this completed turn promptly.',
      completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
    });
    const enrollment = control.reserveEnrollment(taskId);
    control.observeEffect({ effectId: enrollment.effectId, observationId: 'initial-send-applied', outcome: 'applied' });
    const task = control.getTask(taskId)!;
    const receipt = renderSupervisorReceipt(task, enrollment.effectId, 'CONTINUE');
    const completed = await control.observeAssistantTurn({ taskId, conversationId, responseText: receipt });
    expect(completed.action).toBe('CONTINUE');
    const successorId = completed.successorEffect?.effectId;
    expect(successorId).toBeDefined();

    const page = { evaluate: async <T>() => false as T, tabRef: () => ({ windowId: 'priority-window', tabId: 'priority-tab' }) };
    let sends = 0;
    let cleanupSawSend = false;
    let currentUser = enrollment.prompt;
    let currentReply = receipt;
    let generating = false;
    const targetPort = createTestChatgptTargetPort({
      listTabs: async () => ({ entries: [{ windowId: 'priority-window', tabId: 'priority-tab',
        url: conversationUrl, title: 'Continuation', active: true, browserProduct: 'chrome' }], unavailableProducts: [] }),
      reattach: async () => page,
      create: async () => { throw new Error('Do not create another conversation'); },
      close: async () => undefined,
      snapshot: async () => ({
        url: conversationUrl, title: 'Continuation', latestUserText: currentUser,
        latestAssistantResponse: currentReply, latestTurnRole: generating ? 'user' as const : 'assistant' as const,
        composerText: '', isGenerating: generating, providerActivityText: '', providerFailureText: '',
      }),
      dispatchPrompt: async (_page, prompt) => {
        expect(prompt).toContain(successorId!);
        sends++;
        currentUser = prompt;
        currentReply = '';
        generating = true;
        return { dispatched: true, confirmed: true };
      },
    });
    const cleanup = targetPort.cleanup.bind(targetPort);
    const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
      targetPort: { ...targetPort, cleanup: async (activeKeys) => {
        cleanupSawSend = sends === 1;
        await cleanup(activeKeys);
      } },
      nowMs: () => Date.now(), providerIdleGraceMs: 60_000,
      providerScopeKey: join(root, 'provider-scope'),
      sleep: async () => undefined,
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onError: (error) => { throw error; },
    });
    await adapter.runOnce();
    expect(sends).toBe(1);
    expect(cleanupSawSend).toBe(true);
    expect(store.effectApplied(successorId!)).toBe(true);
    await adapter.runOnce();
    expect(sends).toBe(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two independent Supervisor adapters serialize bootstrap preparation behind conversation dispatch', async () => {
  const { WorkflowSupervisorNativeBrowserAdapter } = await import('../../supervisor/native-browser-adapter');
  const { WorkflowSupervisorEphemeralDiscovery } = await import('../../supervisor/server');
  const { createTestChatgptTargetPort } = await import('./helpers/computer-chatgpt-target-harness');
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-shared-composer-lane-'));
  const storeA = new WorkflowSupervisorStore(join(root, 'a'));
  const storeB = new WorkflowSupervisorStore(join(root, 'b'));
  const events: string[] = [];
  try {
    const providerScopeKey = join(root, 'shared-provider-scope');
    const conversationId = '41414141-aaaa-bbbb-cccc-414141414141';
    const conversationUrl = 'https://chatgpt.com/c/' + conversationId;
    const projectUrl = 'https://chatgpt.com/g/g-p-abc123-forge/project';
    const controlA = new WorkflowSupervisorControlPlane(storeA, {}, { browserTaskActive: () => true });
    controlA.registerTask({
      taskId: 'supervisor:serial-conversation', conversationId, conversationUrl,
      objective: 'Send through the shared account lane.', completionContract: {},
      continuationPolicy: {}, userBlockerPolicy: {},
    });
    controlA.reserveEnrollment('supervisor:serial-conversation');
    const controlB = new WorkflowSupervisorControlPlane(storeB, {}, {
      browserTaskActive: () => true,
      projectScopeForTask: () => ({ title: 'forge', repoId: 'repo-forge', controllerHome: root }),
    });
    controlB.registerTask({
      taskId: 'supervisor:serial-bootstrap', conversationId: 'bootstrap:supervisor:serial-bootstrap',
      conversationUrl: 'https://chatgpt.com/', objective: 'Bootstrap another task.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    controlB.recordBrowserDiscovery('chrome-extension', [{
      conversationId, canonicalUrl: conversationUrl, projectTitle: 'forge', projectUrl,
    }]);
    controlB.reserveEnrollment('supervisor:serial-bootstrap');
    let enteredFirst!: () => void;
    let allowFirst!: () => void;
    const firstPrepared = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { allowFirst = resolve; });
    const page = { evaluate: async <T>() => false as T, tabRef: () => ({ windowId: 'w', tabId: 't' }) };
    let latestUserText = 'Earlier committed user message';
    const targetA = createTestChatgptTargetPort({
      listTabs: async () => ({ entries: [{ windowId: 'w', tabId: 't', url: conversationUrl, title: 'A', active: true }], unavailableProducts: [] }),
      reattach: async () => page, create: async () => page, close: async () => undefined,
      snapshot: async () => ({
        url: conversationUrl, title: 'A', latestUserText,
        latestAssistantResponse: 'Earlier completed assistant response', latestTurnRole: 'assistant',
        composerText: '', isGenerating: false, providerActivityText: '', providerFailureText: '',
      }),
      preparePrompt: async () => {
        events.push('conversation:prepare'); enteredFirst(); await releaseFirst; return { ready: true };
      },
      dispatchPrompt: async (_page, prompt) => {
        events.push('conversation:dispatch'); latestUserText = prompt;
        return { dispatched: true, confirmed: true };
      },
    });
    const targetB = createTestChatgptTargetPort({
      listTabs: async () => ({ entries: [{ windowId: 'w2', tabId: 't2', url: projectUrl, title: 'Forge', active: true }], unavailableProducts: [] }),
      reattach: async () => page, create: async () => page, close: async () => undefined,
      snapshot: async () => ({
        url: projectUrl, title: 'Forge', latestUserText: '', latestAssistantResponse: '',
        composerText: '', composerSelectorVersion: 'visible-single-v2',
        isGenerating: false, providerActivityText: '', providerFailureText: '',
      }),
      preparePrompt: async () => { events.push('bootstrap:prepare'); return { ready: true }; },
      dispatchPrompt: async () => {
        events.push('bootstrap:dispatch');
        return { dispatched: false, reason: 'test-no-click' };
      },
    });
    const makeAdapter = (control: WorkflowSupervisorControlPlane, targetPort: ReturnType<typeof createTestChatgptTargetPort>) =>
      new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
        targetPort, providerScopeKey, nowMs: () => Date.now(), providerIdleGraceMs: 60_000,
        sleep: async () => undefined,
        setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined,
        onError: (error) => { throw error; },
      });
    const adapterA = makeAdapter(controlA, targetA);
    const adapterB = makeAdapter(controlB, targetB);
    const first = adapterA.runOnce();
    await firstPrepared;
    const second = adapterB.runOnce();
    await Promise.resolve();
    expect(events).toEqual(['conversation:prepare']);
    allowFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'conversation:prepare', 'conversation:dispatch', 'bootstrap:prepare', 'bootstrap:dispatch',
    ]);
  } finally {
    storeA.close(); storeB.close();
    rmSync(root, { recursive: true, force: true });
  }
});
