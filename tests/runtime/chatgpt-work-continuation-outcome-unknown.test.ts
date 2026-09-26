import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getChatgptWorkConversationBinding } from '../../adapters/chatgpt/work-conversation-binding-store';
import type { ChatgptProviderDeliveryHost } from '../../adapters/chatgpt/provider-delivery';
import { runWorkChatgptContinuation } from '../../src/runtime/control-plane/launcher/chatgpt-work-continuation';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(workId: string) {
  const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-outcome-unknown-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'outcome-unknown@example.test'], ['config', 'user.name', 'Outcome Unknown Test']] as string[][]) {
    execFileSync('git', args, { cwd: repoRoot });
  }
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'chatgpt-outcome-unknown' });
  const store = { controllerHome, repoId: repository.repoId };
  createWorkContract(store, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    mode: 'goal_workloop',
    objective: 'Reconcile an ambiguous ChatGPT provider send without replay.',
    acceptanceCriteria: [],
    allowedPaths: ['**/*'],
    forbiddenPaths: [],
    checks: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  return { controllerHome, repoRoot, repository, store };
}

describe('ChatGPT Work outcome-unknown Supervisor handoff', () => {
  test('enrolls the existing Supervisor when an exact conversation binding was observed', async () => {
    const workId = 'WORK-OUTCOME-UNKNOWN-BOUND';
    const { controllerHome, repoRoot, repository, store } = fixture(workId);
    const enrollments: string[] = [];
    let settlements = 0;
    const browserHost: ChatgptProviderDeliveryHost = {
      async dispatch(input) {
        return {
          status: 'outcome_unknown',
          provider: 'controller-browser',
          browserSessionId: input.browserSessionId,
          conversationUrl: 'https://chatgpt.com/c/outcome-unknown-bound',
          executionPreferenceVerified: true,
          error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN', message: 'provider acceptance remained ambiguous' },
        };
      },
    };

    const result = await runWorkChatgptContinuation({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      workId,
      prompt: 'continue exact work',
      controllerAuthorityId: 'cra_11111111111111111111111111111111',
      relayScopeId: `goal:${workId}`,
    }, {
      bridgeRuntime: false,
      browserHost,
      enrollWorkflowSupervisor: async (_options, enrolledWorkId) => {
        enrollments.push(enrolledWorkId);
        return { status: 'enrolled' as const, taskId: 'task-bound', effectId: 'effect-bound' };
      },
      settleBrowserTab: async () => {
        settlements += 1;
        return { status: 'closed' as const };
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      providerDeliveryStatus: 'outcome_unknown',
      conversationId: 'outcome-unknown-bound',
      conversationUrl: 'https://chatgpt.com/c/outcome-unknown-bound',
      error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN' },
    });
    expect(enrollments).toEqual([workId]);
    expect(settlements).toBe(0);
    expect(getChatgptWorkConversationBinding(store, workId)).toMatchObject({
      conversationId: 'outcome-unknown-bound',
      conversationUrl: 'https://chatgpt.com/c/outcome-unknown-bound',
    });
  });

  test('does not enroll Supervisor when outcome-unknown has no exact conversation identity', async () => {
    const workId = 'WORK-OUTCOME-UNKNOWN-UNBOUND';
    const { controllerHome, repoRoot, repository, store } = fixture(workId);
    const enrollments: string[] = [];
    const browserHost: ChatgptProviderDeliveryHost = {
      async dispatch(input) {
        return {
          status: 'outcome_unknown',
          provider: 'controller-browser',
          browserSessionId: input.browserSessionId,
          conversationUrl: 'https://chatgpt.com/',
          executionPreferenceVerified: false,
          error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN', message: 'no exact conversation identity observed' },
        };
      },
    };

    const result = await runWorkChatgptContinuation({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      workId,
      prompt: 'continue exact work',
      controllerAuthorityId: 'cra_22222222222222222222222222222222',
      relayScopeId: `goal:${workId}`,
    }, {
      bridgeRuntime: false,
      browserHost,
      enrollWorkflowSupervisor: async (_options, enrolledWorkId) => {
        enrollments.push(enrolledWorkId);
        return { status: 'enrolled' as const, taskId: 'task-unbound', effectId: 'effect-unbound' };
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      providerDeliveryStatus: 'outcome_unknown',
      conversationUrl: 'https://chatgpt.com/',
      error: { code: 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN' },
    });
    expect(result.conversationId).toBeUndefined();
    expect(enrollments).toEqual([]);
    expect(getChatgptWorkConversationBinding(store, workId)).toBeUndefined();
  });
});
