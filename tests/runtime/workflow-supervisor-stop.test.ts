import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorStore } from '../../supervisor/store';

test('operator stop is terminal without claiming semantic completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-stop-'));
  const store = new WorkflowSupervisorStore(root);
  try {
    const control = new WorkflowSupervisorControlPlane(store, {
      completionContract: async () => ({ valid: true, reason: 'ok' }),
      userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
    });
    const taskId = 'supervisor:operator-stop';
    control.registerTask({
      taskId,
      conversationId: `bootstrap:${taskId}`,
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Must be cancellable without pretending the objective completed.',
      completionContract: { kind: 'model_semantic_completion' },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    control.reserveEnrollment(taskId);

    expect(control.listTasks(true).map((task) => task.taskId)).toEqual([taskId]);
    expect(control.browserTasks().map((task) => task.taskId)).toEqual([taskId]);
    expect(control.stopTask(taskId, 'user requested stop')).toEqual({ taskId, terminal: 'STOPPED', deduplicated: false });
    expect(store.terminalAction(taskId)).toBe('STOPPED');
    expect(control.listTasks(true)).toEqual([]);
    expect(control.browserTasks()).toEqual([]);
    expect(control.bootstrapPoll(taskId)).toMatchObject({ terminal: 'STOPPED' });

    const enrolledTaskId = 'supervisor:operator-stop-enrolled';
    control.registerTask({
      taskId: enrolledTaskId,
      conversationId: `bootstrap:${enrolledTaskId}`,
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Stop an already enrolled browser task.',
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
    });
    control.reserveEnrollment(enrolledTaskId);
    control.bindBootstrapConversation({
      taskId: enrolledTaskId,
      conversationId: 'conversation-stop-enrolled',
      conversationUrl: 'https://chatgpt.com/c/conversation-stop-enrolled',
    });
    control.stopTask(enrolledTaskId, 'user requested stop');
    expect(control.browserPoll({
      conversationId: 'conversation-stop-enrolled',
      conversationUrl: 'https://chatgpt.com/c/conversation-stop-enrolled',
    })).toMatchObject({ terminal: 'STOPPED' });
    expect(control.stopTask(taskId, 'user requested stop')).toEqual({ taskId, terminal: 'STOPPED', deduplicated: true });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
