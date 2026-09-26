import { describe, expect, test } from 'bun:test';
import { normalizeCheckIds, classifyVerificationOutcome } from '../../src/runtime/control-plane/facade/check-normalization';
import { listCapabilityDescriptors, searchCapabilityDescriptors, summarizeCapabilityGroups } from '../../src/runtime/control-plane/facade/capability-registry';
import { evaluatePolicyGate } from '../../src/runtime/control-plane/facade/policy-gate';
import { buildFacadeResult } from '../../src/runtime/control-plane/facade/facade-result';
import { allowedFacadeOperations, validateSuggestedNextActions } from '../../src/runtime/control-plane/facade/suggested-actions';
import { buildSuperControllerInvocation, type ThinLauncherRequest } from '../../src/runtime/control-plane/launcher/thin-launcher';
import { FROZEN_RH_WORK_TOOL_OPERATIONS, runtimeToolDefinitions } from '../../src/runtime/gateway/mcp/runtime-tool-definitions';
import { CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS } from '../../src/runtime/context/automatic-learning';
import {
  FACADE_TOOLS,
  HANDOFF_STATUSES,
  type FacadeResult,
  type HandoffItem,
  isTerminalHandoffStatus,
} from '../../src/runtime/control-plane/facade/types';

describe('handoff and facade contracts', () => {
  test('keeps the ChatGPT-facing facade small and stable', () => {
    expect(FACADE_TOOLS).toEqual(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
  });

  test('keeps expensive maintenance inspection explicit on rh_status', () => {
    const rhStatus = runtimeToolDefinitions.find((definition) => definition.name === 'rh_status');
    const properties = rhStatus?.inputSchema.properties as Record<string, { description?: string }> | undefined;
    expect(properties?.include_maintenance?.description).toContain('defaults to false');
  });

  test('keeps controller round ownership and disposition out of the current model-facing rh_work contract', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties).toHaveProperty('checkout_id');
    expect(properties?.operation?.enum).not.toContain('controller_disposition');
    expect(properties).not.toHaveProperty('disposition');
    expect(properties).not.toHaveProperty('enroll_current_conversation');
    expect(properties).not.toHaveProperty('relay_scope_id');
    expect(properties).not.toHaveProperty('controller_authority_id');
    expect(allowedFacadeOperations('rh_work')).not.toContain('controller_disposition');
    expect(FROZEN_RH_WORK_TOOL_OPERATIONS).toContain('controller_disposition');
  });

  test('keeps cognition cadence model-owned without adding another lifecycle', () => {
    const rhContext = runtimeToolDefinitions.find((definition) => definition.name === 'rh_context');
    const properties = rhContext?.inputSchema.properties as Record<string, any> | undefined;
    expect(properties?.include_learning_recall?.type).toBe('boolean');
    expect(properties?.include_learning_recall?.description).toContain('model-owned attention/cadence choice');
    expect(FACADE_TOOLS).toHaveLength(5);
  });

  test('keeps controller learning drafts bounded and provenance server-owned', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, any> | undefined;
    const learning = properties?.learning_signals;
    // The per-call array bound is a transport envelope owned by one constant, not
    // an interaction quota and not a second schema-local policy.
    expect(learning?.maxItems).toBe(CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS);
    expect(learning?.items?.additionalProperties).toBe(false);
    expect(learning?.items?.properties?.scope_kind?.enum).toEqual(['work', 'requirement', 'project', 'workspace']);
    expect(learning?.items?.properties?.admission_source?.enum).toContain('explicit_human');
    expect(learning?.items?.properties?.portability?.enum).toContain('portable');
    expect(learning?.items?.properties).not.toHaveProperty('source_work_id');
    expect(learning?.items?.properties).not.toHaveProperty('source_round_id');
    expect(learning?.items?.properties).not.toHaveProperty('observed_at');
    expect(learning?.items?.properties).not.toHaveProperty('source_kind');
    expect(learning?.items?.properties).not.toHaveProperty('id');
    expect(properties?.operation?.enum).toContain('learning_record');
  });

  test('derives the current rh_work schema and suggested-action admission from one thin operation ABI', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.operation?.enum).toEqual([...allowedFacadeOperations('rh_work')]);
    expect(properties?.operation?.enum).not.toContain('review');
    expect(properties?.operation?.enum).not.toContain('verify');
    expect(properties?.operation?.enum).not.toContain('finalize');
    expect(properties?.operation?.enum).toContain('learning_record');
    expect(properties?.operation?.enum).toContain('outcome_record');
    expect(properties?.operation?.enum).toContain('experience_record');

    const retiredReview = validateSuggestedNextActions([
      { label: 'Review implementation', tool: 'rh_work', operation: 'review', risk: 'workspace_write' },
    ]);
    expect(retiredReview.actions).toHaveLength(0);
    expect(retiredReview.warnings[0]).toContain('unsupported rh_work.review');

    const invalid = validateSuggestedNextActions([
      { label: 'Impossible transition', tool: 'rh_work', operation: 'not_in_stable_schema', risk: 'workspace_write' },
    ]);
    expect(invalid.actions).toHaveLength(0);
    expect(invalid.warnings[0]).toContain('unsupported rh_work.not_in_stable_schema');
  });

  test('keeps frozen lifecycle vocabulary available for server compatibility without advertising its authority fields', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { description?: string; enum?: string[] }> | undefined;
    expect(FROZEN_RH_WORK_TOOL_OPERATIONS).toEqual(expect.arrayContaining([
      'controller_claim',
      'controller_release',
      'controller_disposition',
      'verify',
      'review',
      'finalize',
      'plan_accept_step',
    ]));
    expect(properties).not.toHaveProperty('controller_authority_id');
    expect(properties).not.toHaveProperty('relay_scope_id');
    expect(properties).not.toHaveProperty('plan_step_id');
    expect(properties?.capability_id?.description).toContain('server compatibility only');
  });

  test('exposes explicit Requirement bootstrap through rh_work without expanding the tool surface', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.operation?.enum).toContain('requirement_create');
    expect(properties?.operation?.enum).toContain('requirement_promote_candidate');
    expect(properties).toHaveProperty('requirement_candidate_id');
    expect(properties).toHaveProperty('requirement_title');
    expect(properties).toHaveProperty('requirement_outcome');
    expect(properties).toHaveProperty('requirement_acceptance_criteria');
    expect(allowedFacadeOperations('rh_work')).toContain('requirement_create');
    expect(FACADE_TOOLS).toHaveLength(5);
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

  test('keeps execution evidence shape out of semantic Work creation', () => {
    const rhWork = runtimeToolDefinitions.find((definition) => definition.name === 'rh_work');
    const properties = rhWork?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties).not.toHaveProperty('work_kind');
    expect(properties).not.toHaveProperty('review_findings');
    expect(properties).not.toHaveProperty('acceptance_evidence');
    expect(properties).toHaveProperty('work_state');
    expect(properties).toHaveProperty('work_result_refs');
    expect(properties).toHaveProperty('expected_revision');
  });

  test('classifies terminal handoff statuses', () => {
    expect(HANDOFF_STATUSES).toContain('pending');
    expect(isTerminalHandoffStatus('pending')).toBe(false);
    expect(isTerminalHandoffStatus('resolved')).toBe(true);
    expect(isTerminalHandoffStatus('expired')).toBe(true);
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

  test('drops retired lifecycle suggestions instead of normalizing them back into the model workflow', () => {
    const normalized = validateSuggestedNextActions([
      { label: 'Continue', tool: 'rh_work', operation: 'continue', risk: 'readonly' },
      { label: 'Finalize', tool: 'rh_work', operation: 'finalize', risk: 'readonly' },
      { label: 'Read context', tool: 'rh_context', operation: 'get', risk: 'readonly' },
    ]);

    expect(normalized.actions.map((action) => action.label)).toEqual(['Read context']);
    expect(normalized.actions.map((action) => action.risk)).toEqual(['readonly']);
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('unsupported rh_work.continue'),
      expect.stringContaining('unsupported rh_work.finalize'),
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

  test('suggested_next_actions cannot reference nonexistent tools, checks, or retired Work lifecycle operations', () => {
    const validation = validateSuggestedNextActions(
      [
        {
          label: 'Bad tool',
          tool: 'not_a_tool' as 'rh_work',
          operation: 'start',
          risk: 'readonly',
        },
        {
          label: 'Retired bad check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:does-not-exist' },
          risk: 'workspace_write',
        },
        {
          label: 'Retired good check',
          tool: 'rh_work',
          operation: 'verify',
          payload: { check_id: 'package:check:type' },
          risk: 'workspace_write',
        },
        {
          label: 'Read context',
          tool: 'rh_context',
          operation: 'get',
          risk: 'readonly',
        },
      ],
      { validCheckIds: ['package:check:type'] },
    );
    expect(validation.actions.map((action) => action.label)).toEqual(['Read context']);
    expect(validation.warnings.length).toBeGreaterThanOrEqual(3);
    expect(validation.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('unsupported rh_work.verify'),
    ]));
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
    expect(capabilities.some((entry) => entry.capabilityId === 'plugin.browser')).toBe(false);
    const iosGroup = summarizeCapabilityGroups([]).find((entry) => entry.group === 'ios');
    expect(iosGroup?.executionSurfaces).toEqual(['plugin_action_execute']);
    expect(iosGroup?.facadeTools).toEqual([]);
  });

  test('registers parallel internal capabilities without expanding facade tools', () => {
    const capabilities = listCapabilityDescriptors([]);
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('repository.direct_edit');
    expect(capabilities.map((entry) => entry.capabilityId)).not.toContain('controller.goal_workloop');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.self_healing');
    expect(capabilities.map((entry) => entry.capabilityId)).toContain('controller.external_controller');
    expect(new Set(capabilities.map((entry) => entry.exposedVia).filter((surface) => surface.startsWith('rh_')))).toEqual(new Set(['rh_context', 'rh_inbox', 'rh_status', 'rh_work']));
    expect(capabilities.some((entry) => entry.exposedVia === 'plugin_action_execute')).toBe(true);
    expect(new Set(capabilities.map((entry) => entry.group))).toEqual(new Set([
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

  test('ranks Apple development capabilities from natural-language intent without changing execution surfaces', () => {
    const matches = searchCapabilityDescriptors('configure Xcode Apple developer account provisioning', [], 8);
    const ids = matches.map((entry) => entry.capabilityId);
    expect(ids).toContain('platform.ios');
    expect(matches.find((entry) => entry.capabilityId === 'platform.ios')?.descriptor.exposedVia).toBe('plugin_action_execute');
    expect(matches[0]?.matchedTerms).toContain('apple-development');
  });

  test('ranks plugin-backed Apple and browser fallback capabilities without changing executor authority', () => {
    const manifests = [
      {
        pluginId: 'app_store_connect',
        displayName: 'App Store Connect API Plugin',
        actions: [
          { actionId: 'auth_status', title: 'Check App Store Connect auth', description: 'Report API readiness.', readOnly: true, risk: 'readonly' },
          { actionId: 'configure', title: 'Configure App Store Connect', description: 'Configure provider defaults.', readOnly: false, risk: 'workspace_write' },
        ],
      },
      {
        pluginId: 'native_computer',
        displayName: 'Native Computer Provider',
        capabilities: [
          { capabilityId: 'computer.observe.v1', title: 'Computer observe', description: 'Observe native UI.', scopes: [], actions: ['observe_ui'] },
          { capabilityId: 'computer.input.v1', title: 'Computer input', description: 'Interact with native UI.', scopes: [], actions: ['press_ui'] },
        ],
        actions: [
          { actionId: 'observe_ui', title: 'Observe native UI', description: 'Read current visual state.', readOnly: true, risk: 'readonly' },
          { actionId: 'press_ui', title: 'Press native UI', description: 'Perform bounded native input.', readOnly: false, risk: 'workspace_write' },
        ],
      },
    ] as unknown as Parameters<typeof searchCapabilityDescriptors>[1];

    const apple = searchCapabilityDescriptors('configure Xcode account Apple provisioning', manifests, 12);
    const appleIds = apple.map((entry) => entry.capabilityId);
    expect(appleIds).toEqual(expect.arrayContaining([
      'platform.ios',
      'plugin.app_store_connect.auth_status',
      'plugin.app_store_connect.configure',
      'plugin.native_computer.observe_ui',
      'plugin.native_computer.press_ui',
    ]));
    expect(apple.find((entry) => entry.capabilityId === 'plugin.native_computer.observe_ui')?.descriptor.semanticCapabilities).toContain('computer.observe.v1');
    expect(apple.every((entry) => entry.descriptor.exposedVia === 'plugin_action_execute' || entry.descriptor.exposedVia.startsWith('rh_'))).toBe(true);

    const browser = searchCapabilityDescriptors('browser login authentication', manifests, 12);
    const browserIds = browser.map((entry) => entry.capabilityId);
    expect(browserIds).not.toContain('plugin.browser');
    expect(browserIds).toContain('plugin.native_computer.observe_ui');
    expect(browserIds).toContain('plugin.native_computer.press_ui');
    expect(browser.find((entry) => entry.capabilityId === 'plugin.native_computer.observe_ui')?.descriptor.exposedVia).toBe('plugin_action_execute');
  });

  test('policy gate allows normal local writes without a task-size boundary and blocks raw secret access', () => {
    expect(evaluatePolicyGate({ risk: 'local_repo_write' })).toMatchObject({ decision: 'allowed' });
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
