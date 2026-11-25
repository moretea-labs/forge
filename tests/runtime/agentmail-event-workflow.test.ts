import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RepositoryRecord } from '../../src/core/repository/types';
import { readWorkflowRun } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import { executeRegisteredWorkflow } from '../../src/runtime/workflows/runtime';
import {
  AGENTMAIL_APP_CASE_BINDINGS,
  AGENTMAIL_EVENT_WORKFLOW_ID,
  ensureAgentMailEventWorkflowInstalled,
  materializedAgentMailEventWorkflow,
  resolveAgentMailAppCaseRoute,
} from '../../src/runtime/workflows/first-party/agentmail-event';
import { validateWorkflowRunInputs, type WorkflowJsonValue } from '../../packages/workflow-runtime/api/index';
import { normalizeAgentMailWatchEvent } from '../../src/runtime/events/adapters/agentmail-watch';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function repository(root: string): RepositoryRecord {
  return {
    repoId: 'repo-agentmail-event-test',
    displayName: 'AgentMail event test',
    enabled: true,
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: 'checkout-agentmail-event-test',
    remoteUrl: undefined,
    defaultBranch: 'main',
    repositoryType: 'git',
    lastSeenAt: new Date().toISOString(),
  } as RepositoryRecord;
}

function identity(root: string) {
  return {
    schemaVersion: 1 as const,
    authority: 'repository' as const,
    repositoryId: 'repo-agentmail-event-test',
    checkoutId: 'checkout-agentmail-event-test',
    canonicalRoot: root,
  };
}

function scopeId(): string {
  return (
    'repository:repo-agentmail-event-test:checkout:checkout-agentmail-event-test:workflow:' +
    AGENTMAIL_EVENT_WORKFLOW_ID
  );
}

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

function event() {
  const providerMessageID = 'm'.repeat(700);
  const observation = {
    source: 'mail.watch.matched' as const,
    event_id: RULE_ID + ':' + ACCOUNT_ID + ':' + providerMessageID,
    observed_at: '2026-11-17T02:00:00.000Z',
    ref: {
      provider: 'agentmail' as const,
      account_id: ACCOUNT_ID,
      provider_message_id: providerMessageID,
    },
    summary: {
      rule_id: RULE_ID,
      sender_email: 'sender@example.com',
    },
  };
  return {
    ...observation,
    event_envelope: JSON.parse(
      JSON.stringify(normalizeAgentMailWatchEvent(observation, { receivedAt: observation.observed_at })),
    ) as WorkflowJsonValue,
  };
}

function runValidator(input: Record<string, unknown>) {
  const body = materializedAgentMailEventWorkflow().scripts?.validateEvent?.body;
  if (!body) throw new Error('AGENTMAIL_EVENT_VALIDATOR_MISSING');
  const result = Bun.spawnSync(['node', '-e', body, JSON.stringify(input)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('AgentMail Watch event Workflow (#652)', () => {
  test('resolves only the three explicit unique App-to-Case bindings', () => {
    expect(AGENTMAIL_APP_CASE_BINDINGS).toEqual([
      { appId: '6771288893', caseId: '30000012066543' },
      { appId: '6831952477', caseId: '30000012078130' },
      { appId: '6796884084', caseId: '30000015896615' },
    ]);
    for (const binding of AGENTMAIL_APP_CASE_BINDINGS) {
      expect(resolveAgentMailAppCaseRoute(binding.appId)).toEqual({
        app_id: binding.appId,
        case_id: binding.caseId,
      });
    }
    expect(() => resolveAgentMailAppCaseRoute('1234567890')).toThrow('AGENTMAIL_APP_CASE_BINDING_UNKNOWN');
    expect(() =>
      resolveAgentMailAppCaseRoute('6771288893', [
        ...AGENTMAIL_APP_CASE_BINDINGS,
        { appId: '6771288893', caseId: '30000012078130' },
      ]),
    ).toThrow('AGENTMAIL_APP_CASE_BINDING_AMBIGUOUS');
    expect(() =>
      resolveAgentMailAppCaseRoute('6771288893', [
        ...AGENTMAIL_APP_CASE_BINDINGS,
        { appId: '1234567890', caseId: '30000012066543' },
      ]),
    ).toThrow('AGENTMAIL_APP_CASE_BINDING_AMBIGUOUS');
  });

  test('accepts the nested source envelope and preserves opaque long event IDs', () => {
    const asset = materializedAgentMailEventWorkflow();
    const input = event();
    expect(input.event_id.length).toBeGreaterThan(512);
    expect(validateWorkflowRunInputs(asset, input)).toEqual({ ...input, route: null });
    expect(runValidator(input).exitCode).toBe(0);

    const withSubject = { ...input, ref: { ...input.ref, subject: 'must not enter the receipt' } };
    expect(runValidator(withSubject).exitCode).not.toBe(0);
    expect(runValidator({ ...input, source: 'agentmail' }).exitCode).not.toBe(0);
    expect(runValidator({ ...input, event_id: 'x'.repeat(4097) }).exitCode).not.toBe(0);
    expect(runValidator({ ...input, ref: { ...input.ref, account_id: 'not-a-uuid' } }).exitCode).not.toBe(0);

    for (const binding of AGENTMAIL_APP_CASE_BINDINGS) {
      const route = resolveAgentMailAppCaseRoute(binding.appId);
      const routed = runValidator({ ...input, route });
      expect(routed.exitCode).toBe(0);
      expect(JSON.parse(routed.stdout).route).toEqual(route);
    }
    expect(
      runValidator({
        ...input,
        route: { app_id: '1234567890', case_id: '30000012066543' },
      }).exitCode,
    ).toBe(3);
    expect(
      runValidator({
        ...input,
        route: { app_id: '6771288893', case_id: '30000012078130' },
      }).exitCode,
    ).toBe(4);
    expect(
      runValidator({
        ...input,
        route: { app_id: '6771288893' },
      }).exitCode,
    ).toBe(2);
  });

  test('persists a safe canonical WorkflowRun receipt and rejects replay without redispatch', async () => {
    const controllerHome = temp('forge-agentmail-event-home-');
    const root = temp('forge-agentmail-event-repo-');
    const installed = ensureAgentMailEventWorkflowInstalled(controllerHome);
    expect(installed.value.contentDigest).toBe(materializedAgentMailEventWorkflow().contentDigest);

    const input = event();
    let commandCount = 0;
    const executeCommand = async (commandInput: any) => {
      commandCount += 1;
      const args = JSON.parse(commandInput.command.at(-1) as string) as Record<string, unknown>;
      const result = runValidator(args);
      return {
        route: 'process_direct',
        reason: 'test',
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durableSideEffects: {
          executionJobCount: 0,
          localJobCount: 0,
          workerSpawnCount: 0,
          projectionUpdateCount: 0,
        },
      };
    };

    const execution = {
      controllerHome,
      repository: repository(root),
      executionIdentity: identity(root),
      scopeId: scopeId(),
      runId: 'agentmail-event-stable-run',
      registryScope: { kind: 'controller' as const },
      workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
      inputs: input,
    };
    const first = await executeRegisteredWorkflow(execution, { executeCommand: executeCommand as any });

    expect(first.status).toBe('succeeded');
    await expect(executeRegisteredWorkflow(execution, { executeCommand: executeCommand as any })).rejects.toThrow(
      'WORKFLOW_RUN_ALREADY_SUCCEEDED',
    );
    expect(commandCount).toBe(1);

    const stored = readWorkflowRun(controllerHome, scopeId(), 'agentmail-event-stable-run')!;
    expect(stored.value.status).toBe('succeeded');
    expect(stored.value.outputs['validate-event']).toEqual(input);
    expect(stored.value.outputs['validate-event']).toMatchObject({
      event_envelope: { source: 'agentmail.watch', subject: { kind: 'mail.message' } },
    });
    expect(JSON.stringify(stored.value)).not.toMatch(/body|credential|access_token/i);
  });
});
