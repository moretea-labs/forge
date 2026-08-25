import { describe, expect, test } from 'bun:test';
import { normalizeCheckIds, classifyVerificationOutcome } from '../../src/runtime/control-plane/facade/check-normalization';
import { listCapabilityDescriptors, summarizeCapabilityGroups } from '../../src/runtime/control-plane/facade/capability-registry';
import { evaluatePolicyGate } from '../../src/runtime/control-plane/facade/policy-gate';
import { buildFacadeResult } from '../../src/runtime/control-plane/facade/facade-result';
import { allowedFacadeOperations, validateSuggestedNextActions } from '../../src/runtime/control-plane/facade/suggested-actions';
import { buildSuperControllerInvocation, type ThinLauncherRequest } from '../../src/runtime/control-plane/launcher/thin-launcher';
import { runtimeToolDefinitions } from '../../src/runtime/gateway/mcp/runtime-tool-definitions';
import {
  FACADE_TOOLS,
  HANDOFF_STATUSES,
  type FacadeResult,
  type HandoffItem,
  isTerminalHandoffStatus,
  selectExecutionMode,
} from '../../src/runtime/control-plane/facade/types';

describe('handoff and facade contracts', () => {
  test('keeps the ChatGPT-facing facade small and stable', () => {
    expect(FACADE_TOOLS).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('keeps controller round disposition in the exposed rh_work schema and facade operation contract', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.operation?.enum).toContain('controller_disposition');
    expect(properties).toHaveProperty('disposition');
    expect(properties).toHaveProperty('relay_scope_id');
    expect(allowedFacadeOperations('rh_work')).toContain('controller_disposition');
  });

  test('keeps Work continuation scheduling inside rh_work instead of expanding the tool surface', () => {
    expect(allowedFacadeOperations('rh_work')).toEqual(expect.arrayContaining([
      'schedule_create',
      'schedule_list',
      'schedule_get',
      'schedule_pause',
      'schedule_resume',
      'schedule_delete',
      'schedule_trigger',
    ]));
    expect(FACADE_TOOLS).toHaveLength(5);
  });

  test('classifies terminal handoff statuses', () => {
    expect(HANDOFF_STATUSES).toContain('pending');
    expect(isTerminalHandoffStatus('pending')).toBe(false);
    expect(isTerminalHandoffStatus('resolved')).toBe(true);
    expect(isTerminalHandoffStatus('expired')).toBe(true);
  });

  test('selects contract-free direct control for small supervised mutation', () => {
    expect(
      selectExecutionMode({
        expectedFiles: 2,
        expectedChangedLines: 80,
        scopeClear: true,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'direct_control', missingContractFields: [], createWorkContract: false, requiresWork: false });
  });

  test('routes unconfirmed approval-gated work to handoff', () => {
    expect(
      selectExecutionMode({
        objective: 'Apply a bounded policy fix',
        expectedFiles: 1,
        expectedChangedLines: 40,
        scopeClear: true,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: true,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true, createWorkContract: false });
  });

  test('keeps small objective-only work direct instead of forcing handoff for missing scope fields', () => {
    expect(
      selectExecutionMode({
        objective: 'Fix the bounded router regression',
        expectedFiles: 1,
        expectedChangedLines: 40,
        scopeClear: false,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'direct_control', createWorkContract: false, createHandoff: false });
  });

  test('requires explicit user approval for architecture strategy conflicts', () => {
    expect(
      selectExecutionMode({
        objective: 'Change the default execution strategy',
        expectedFiles: 1,
        expectedChangedLines: 40,
        scopeClear: true,
        requiresUserApproval: true,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true, createWorkContract: false });
  });

  test('selects handoff only when the request is underspecified', () => {
    expect(
      selectExecutionMode({
        scopeClear: false,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true, createWorkContract: false });
  });

  test('keeps long-running checks direct unless continuity is explicitly required', () => {
    expect(
      selectExecutionMode({
        scopeClear: true,
        expectedFiles: 12,
        expectedChangedLines: 800,
        requiresLongRunningChecks: true,
        requiresRecovery: false,
        requiresWorker: false,
        requiresExternalEffect: false,
        requiresApproval: false,
      }),
    ).toMatchObject({ mode: 'direct_control', createWorkContract: false });
  });

  test('selects handoff only for high-risk work needing approval', () => {
    expect(
      selectExecutionMode({
        scopeClear: true,
        destructive: true,
        requiresUserApproval: true,
        requiresApproval: true,
      }),
    ).toMatchObject({ mode: 'handoff_only', createHandoff: true });
  });

  test('supports bounded facade results with evidence refs and suggested actions', () => {
    const result: FacadeResult<{ pendingHandoffs: number }> = {
      schemaVersion: 1,
      status: 'ok',
      summary: 'Controller is ready.',
      data: { pendingHandoffs: 1 },
      evidenceRefs: [{ title: 'status projection', detailLevel: 'summary' }],
      warnings: [],
      suggestedNextActions: [
        {
          label: 'List pending handoffs',
          tool: 'rh_inbox',
          operation: 'list',
          risk: 'readonly',
          confidence: 'high',
        },
      ],
      rawAvailable: false,
      detailLevel: 'summary',
    };

    expect(result.suggestedNextActions[0]?.tool).toBe('rh_inbox');
  });

  test('normalizes rh_work suggested action risks instead of trusting caller metadata', () => {
    const normalized = validateSuggestedNextActions([
      { label: 'Continue', tool: 'rh_work', operation: 'continue', risk: 'readonly' },
      { label: 'Finalize', tool: 'rh_work', operation: 'finalize', risk: 'readonly' },
      { label: 'Read context', tool: 'rh_context', operation: 'get', risk: 'readonly' },
    ]);

    expect(normalized.actions.map((action) => action.risk)).toEqual([
      'workspace_write',
      'local_repo_write',
      'readonly',
    ]);
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('rh_work.continue risk readonly -> workspace_write'),
      expect.stringContaining('rh_work.finalize risk readonly -> local_repo_write'),
    ]));
  });

  test('facade result defaults to bounded data without raw stdout/stderr/secrets', () => {
    const facade = buildFacadeResult({
      summary: 'ok',
      data: {
        stdout: 'x'.repeat(10_000),
        secret: 'should-be-bounded-as-string',
        nested: { deep: { log: 'y'.repeat(5_000) } },
      },
    });
    expect(facade.rawAvailable).toBe(false);
    expect(facade.detailLevel).toBe('summary');
    expect(String((facade.data as { stdout: string }).stdout).length).toBeLessThan(5_000);
    expect(JSON.stringify(facade)).not.toContain('Bearer ');
  });

  test('suggested_next_actions cannot reference nonexistent check or tool', () => {
    const validation = validateSuggestedNextActions(
      [
        {
          label: 'Bad tool',
          tool: 'not_a_tool' as 'rh_work',
          operation: 'start',
          risk: 'readonly',
        },
        {
          label: 'Bad check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:does-not-exist' },
          risk: 'workspace_write',
        },
        {
          label: 'Good check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:check:type' },
          risk: 'workspace_write',
        },
      ],
      { validCheckIds: ['package:check:type'] },
    );
    expect(validation.actions.map((action) => action.label)).toEqual(['Good check']);
    expect(validation.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test('represents a handoff item without raw logs', () => {
    const handoff: HandoffItem = {
      schemaVersion: 1,
      id: 'hnd_test',
      repoId: 'repo_test',
      taskId: 'T1',
      title: 'Verification needs review',
      severity: 'needs_review',
      status: 'pending',
      reason: 'The failure may require a product decision.',
      summary: 'A targeted check failed after a bounded change.',
      currentState: {
        repoId: 'repo_test',
        taskId: 'T1',
        mode: 'goal_workloop',
        statusSummary: 'waiting for ChatGPT decision',
        checks: [{ checkId: 'package:check:type', ok: false }],
      },
      evidenceRefs: [{ evidenceId: 'ev_test', title: 'typecheck summary', detailLevel: 'summary' }],
      recommendedDecision: 'Decide whether to repair code or adjust the contract.',
      recommendedPrompt: 'Continue from handoff hnd_test and inspect evidence ev_test.',
      suggestedNextActions: [
        {
          label: 'Read task context',
          tool: 'rh_context',
          operation: 'get',
          payload: { task_id: 'T1' },
          risk: 'readonly',
        },
      ],
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    };

    expect(handoff.evidenceRefs[0]?.detailLevel).toBe('summary');
    expect(handoff.suggestedNextActions[0]?.tool).toBe('rh_context');
  });

  test('routes typed plugin capabilities through the real plugin executor instead of rh_work', () => {
    const capabilities = listCapabilityDescriptors([]);
    expect(capabilities.find((entry) => entry.capabilityId === 'platform.ios')?.exposedVia).toBe('plugin_action_execute');
    expect(capabilities.find((entry) => entry.capabilityId === 'plugin.browser')?.exposedVia).toBe('plugin_action_execute');
    const iosGroup = summarizeCapabilityGroups([]).find((entry) => entry.group === 'ios');
    expect(iosGroup?.executionSurfaces).toEqual(['plugin_action_execute']);
    expect(iosGroup?.facadeTools).toEqual([]);
  });

  test('registers parallel internal capabilities without expanding facade tools', () => {
    const capabilities = listCapabilityDescriptors([]);
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('repository.direct_edit');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.goal_workloop');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.self_healing');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.external_controller');
    expect(new Set(capabilities.map((entry) => entry.exposedVia).filter((surface) => surface.startsWith('rh_')))).toEqual(new Set(['rh_context', 'rh_inbox', 'rh_status', 'rh_work']));
    expect(capabilities.some((entry) => entry.exposedVia === 'plugin_action_execute')).toBe(true);
    expect(new Set(capabilities.map((entry) => entry.group))).toEqual(new Set([
      'browser',
      'controller',
      'evidence',
      'git',
      'ios',
      'issue-task',
      'repository-core',
      'runtime-maintenance',
    ]));
    expect(capabilities.every((entry) => entry.schemaExposure === 'stable_static')).toBe(true);
    const groups = summarizeCapabilityGroups([]);
    expect(groups.find((entry) => entry.group === 'git')).toMatchObject({ capabilityCount: 1, facadeTools: ['rh_work'] });
    expect(groups.find((entry) => entry.group === 'ios')).toMatchObject({ capabilityCount: 1, executionSurfaces: ['plugin_action_execute'], facadeTools: [] });
  });

  test('policy gate preserves bounded direct edit and blocks raw secret access', () => {
    expect(evaluatePolicyGate({
      risk: 'local_repo_write',
      directEditBoundary: { scopeClear: true, pathsExplicit: true, maxChangedFiles: 2, maxChangedLines: 80 },
    })).toMatchObject({ decision: 'allowed' });
    expect(evaluatePolicyGate({ risk: 'raw_secret_config' })).toMatchObject({ decision: 'denied' });
    expect(evaluatePolicyGate({ risk: 'remote_write' })).toMatchObject({ decision: 'allowed' });
  });

  test('normalizes check aliases without treating invalid ids as check failures', () => {
    const normalized = normalizeCheckIds(['typecheck', 'docs', 'package:test'], [
      { id: 'package:check:type' },
      { id: 'package:test' },
    ]);
    expect(normalized.validCheckIds).toEqual(['package:check:type', 'package:test']);
    expect(normalized.invalidCheckIds).toEqual(['docs']);
    expect(normalized.warnings[0]).toContain('invalid_check_id');
  });

  test('classifies invalid check id as non-acceptance failure', () => {
    const classified = classifyVerificationOutcome({
      checkId: 'docs',
      available: [{ id: 'package:check:type' }],
    });
    expect(classified.outcome).toBe('invalid_check_id');
    expect(classified.isAcceptanceFailure).toBe(false);
  });
});


describe('Thin Launcher external Controller invocation', () => {
  const request = (overrides: Partial<ThinLauncherRequest> = {}): ThinLauncherRequest => ({ controllerType: 'chatgpt', workId: 'WORK-1', cwd: '/tmp/repo', controllerHome: '/tmp/controller', repoId: 'repo-1', ...overrides });
  test('builds safe ChatGPT browser continuation invocations', () => {
    expect(buildSuperControllerInvocation(request({ browserSessionId: 'browser-session-123' }), 'forge', 'continue bounded work')).toEqual({ executable: 'forge', args: ['chatgpt', 'work-continue', '--repo', '/tmp/repo', '--controller-home', '/tmp/controller', '--repo-id', 'repo-1', '--work-id', 'WORK-1', '--prompt', 'continue bounded work', '--session', 'browser-session-123'] });
    const byUrl = buildSuperControllerInvocation(request({ conversationUrl: 'https://chatgpt.com/c/example' }), 'forge', 'continue bounded work').args;
    expect(byUrl).toEqual(expect.arrayContaining(['work-continue', '--conversation-url', 'https://chatgpt.com/c/example']));
    expect(byUrl).not.toContain('browser-consult');
    expect(byUrl).not.toContain('oracle');
    expect(() => buildSuperControllerInvocation(request({ conversationUrl: 'https://example.com/c/example' }), 'forge', 'continue bounded work')).toThrow('LAUNCHER_CHATGPT_CONVERSATION_URL_INVALID');
  });
  test('uses non-interactive provider modes and requires Forge MCP bootstrap for detached CLI controllers', () => {
    const bootstrap = {
      url: 'http://127.0.0.1:8765/mcp',
      bearerTokenEnvVar: 'FORGE_RUNTIME_MCP_TOKEN' as const,
      principalId: 'external:codex:reservation-1',
      sessionId: 'external-session:codex:reservation-1',
      env: { FORGE_RUNTIME_MCP_TOKEN: 'secret-not-for-argv' },
    };
    const codex = buildSuperControllerInvocation(
      request({ controllerType: 'codex', args: ['--color', 'never'] }),
      'codex',
      'continue bounded work',
      bootstrap,
    );
    expect(codex.executable).toBe('codex');
    expect(codex.args.slice(0, 2)).toEqual(['--ask-for-approval', 'never']);
    expect(codex.args).toContain('exec');
    expect(codex.args).toContain('workspace-write');
    expect(codex.args.join(' ')).toContain('mcp_servers.forge.url=');
    expect(codex.args.join(' ')).toContain('X-Forge-Forwarded-Principal-Id');
    expect(codex.args.join(' ')).toContain('X-Forge-Forwarded-Controller-Type');
    expect(codex.args.join(' ')).toContain('external:codex:reservation-1');
    expect(codex.args.join(' ')).not.toContain('secret-not-for-argv');

    expect(() => buildSuperControllerInvocation(
      request({ controllerType: 'claude', args: ['--max-budget-usd', '1'] }),
      'claude',
      'continue bounded work',
    )).toThrow('LAUNCHER_CLAUDE_FORGE_MCP_CONFIG_REQUIRED');
    expect(buildSuperControllerInvocation(
      request({ controllerType: 'claude', args: ['--mcp-config', '{\"mcpServers\":{}}', '--max-budget-usd', '1'] }),
      'claude',
      'continue bounded work',
    )).toEqual({
      executable: 'claude',
      args: ['--print', '--permission-mode', 'auto', '--mcp-config', '{"mcpServers":{}}', '--max-budget-usd', '1', 'continue bounded work'],
    });
  });
});
