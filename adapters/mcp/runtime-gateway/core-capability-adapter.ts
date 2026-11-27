import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { callRepositoryTool } from '../../../src/runtime/control-plane/facade/repository-tool-dispatch';
import {
  commitSelectedPaths,
  restoreSelectedPaths,
  selectedPathDiff,
  stageSelectedPaths,
} from '../../../src/runtime/repositories/selected-path-actions';
import { repositoryGitDiff } from '../../../src/runtime/repositories/structured-git';
import { result } from './result-adapter';
import {
  executeRepositorySafePatchComposite,
  requestsRepositorySafePatchValidation,
} from './gateway-execution-adapter';
import { selected } from './shared-adapter';
import {
  configureInitialControllerConnection,
  readControllerConnectionSnapshot,
  repairControllerConnection,
} from './controller-connection';
import { installControllerOfficialPlugin, readControllerPluginManagement } from './controller-plugins';
import {
  getWorkflowCatalogEntry,
  listWorkflowCatalog,
  prepareWorkflowInvocation,
  previewWorkflowGraph,
  type WorkflowInvocationOriginKind,
} from '../../../src/runtime/workflows/catalog';
import {
  readWorkflowRegistryEntry,
  type WorkflowRegistryScope,
} from '../../../src/runtime/control-plane/persistence/workflow-registry-store';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import { applyEventRuleProposal, preflightEventRuleProposal } from '../../../src/runtime/events/event-rule-authoring';
import {
  evaluatePersistedEventRules,
  listEventRules,
  readEventRule,
} from '../../../src/runtime/events/event-rule-store';
import {
  listEventActionDefinitions,
  readEventActionDefinition,
} from '../../../src/runtime/events/event-action-registry-store';
import { validateEventEnvelopeV1, type EventRuleScalar } from '../../../packages/kernel/events';
import { preflightWorkflowProposal } from '../../../src/runtime/workflows/authoring';
import { applyPackagedWorkflowProposal } from '../../../src/runtime/workflows/packaged-authoring';
import { setWorkflowLifecycle } from '../../../src/runtime/workflows/lifecycle';
import { FORGE_VERSION } from '../../../src/runtime/shared/runtime-config';
import { executeRegisteredWorkflowFeature } from '../../../src/runtime/workflows/feature-runtime';
import { resumeDueWorkflowGraphWaits } from '../../../src/runtime/workflows/timeout-resume';
import { executionIdentityForRepository } from '../../../src/runtime/control-plane/execution/execution-identity';
import { currentPermissionSnapshotVersion } from '../../../src/runtime/control-plane/execution/session-repository-binding';
import { principalFor } from '../../../src/runtime/control-plane/execution/session-execution-support';
import { startOrResumeSession } from './execution-tools';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function workflowScope(input: Record<string, unknown>): WorkflowRegistryScope {
  const projectId = typeof input.project_id === 'string' ? input.project_id.trim() : '';
  return projectId ? { kind: 'project', projectId } : { kind: 'controller' };
}

function workflowId(input: Record<string, unknown>): string {
  const value = typeof input.workflow_id === 'string' ? input.workflow_id.trim() : '';
  if (!value) throw new Error('WORKFLOW_CAPABILITY_ID_REQUIRED');
  return value;
}

function workflowInputs(input: Record<string, unknown>): Record<string, WorkflowJsonValue> {
  const value = input.inputs;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('WORKFLOW_CAPABILITY_INPUTS_INVALID');
  return value as Record<string, WorkflowJsonValue>;
}

function eventId(input: Record<string, unknown>, field: 'rule_id' | 'action_ref'): string {
  const value = typeof input[field] === 'string' ? input[field].trim() : '';
  if (!value || value.length > 128) throw new Error('EVENT_AUTOMATION_ID_INVALID');
  return value;
}

function eventFacts(input: Record<string, unknown>): Record<string, EventRuleScalar> {
  const value = input.facts;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EVENT_CAPABILITY_FACTS_INVALID');
  const facts: Record<string, EventRuleScalar> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error('EVENT_CAPABILITY_FACT_VALUE_INVALID');
    }
    facts[key] = item as EventRuleScalar;
  }
  return facts;
}

function eventLimit(input: Record<string, unknown>): number {
  return typeof input.limit === 'number' ? Math.max(1, Math.min(Math.trunc(input.limit), 256)) : 256;
}

function approvedSensitiveActionRefs(input: Record<string, unknown>): string[] {
  if (input.approved_sensitive_action_refs === undefined) return [];
  if (
    !Array.isArray(input.approved_sensitive_action_refs) ||
    input.approved_sensitive_action_refs.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('EVENT_CAPABILITY_SENSITIVE_ACTION_REFS_INVALID');
  }
  return [...new Set(input.approved_sensitive_action_refs.map((value) => String(value).trim()))];
}

export async function callCoreCapabilityAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'capability_execute') return undefined;
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const input = object(args.arguments);

  try {
    if (capabilityId === 'controller.connection') {
      if (action === 'get') return result({ ...readControllerConnectionSnapshot(ctx.controllerHome) });
      if (action === 'configure_initial') {
        return result(
          configureInitialControllerConnection(ctx.controllerHome, {
            controller: String(input.controller ?? ''),
            tunnel: input.tunnel == null ? undefined : String(input.tunnel),
          }),
        );
      }
      if (action === 'repair_connector') return result(repairControllerConnection(ctx.controllerHome));
      return result(
        {
          error: {
            code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
            message: `Unsupported controller.connection action: ${action || '<empty>'}`,
          },
        },
        true,
      );
    }
    if (capabilityId === 'controller.plugins') {
      if (action === 'get') return result({ ...readControllerPluginManagement(ctx.controllerHome) });
      if (action === 'install_official') {
        return result(installControllerOfficialPlugin(ctx.controllerHome, String(input.plugin_id ?? '')));
      }
      return result(
        {
          error: {
            code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
            message: 'Unsupported controller.plugins action: ' + (action || '<empty>'),
          },
        },
        true,
      );
    }
    if (capabilityId === 'event.automation') {
      if (action === 'list_rules') return result({ rules: listEventRules(ctx.controllerHome, eventLimit(input)) });
      if (action === 'get_rule') {
        const ruleId = typeof input.rule_id === 'string' ? input.rule_id.trim() : '';
        if (!ruleId) throw new Error('EVENT_CAPABILITY_RULE_ID_REQUIRED');
        return result({ rule: readEventRule(ctx.controllerHome, ruleId) ?? null });
      }
      if (action === 'list_actions')
        return result({ actions: listEventActionDefinitions(ctx.controllerHome, eventLimit(input)) });
      if (action === 'get_action') {
        const definition = readEventActionDefinition(ctx.controllerHome, eventId(input, 'action_ref'));
        return result({ action: definition ?? null });
      }
      if (action === 'authoring_preflight')
        return result({ preflight: preflightEventRuleProposal(ctx.controllerHome, input.proposal) });
      if (action === 'authoring_apply') {
        return result({
          rule: applyEventRuleProposal(ctx.controllerHome, input.proposal, {
            canWriteRules: true,
            canEnableRules: false,
            approvedSensitiveActionRefs: [],
          }),
        });
      }
      if (action === 'evaluate') {
        const event = validateEventEnvelopeV1(input.event ?? input.envelope);
        return result({
          event,
          matches: evaluatePersistedEventRules(ctx.controllerHome, event, { facts: eventFacts(input) }),
          execution: 'not_executed',
        });
      }
      if (action === 'apply') {
        return result({
          rule: applyEventRuleProposal(ctx.controllerHome, input.proposal, {
            canWriteRules: true,
            canEnableRules: input.allow_enable === true,
            approvedSensitiveActionRefs: approvedSensitiveActionRefs(input),
          }),
        });
      }
      return result(
        {
          error: {
            code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
            message: `Unsupported event.automation action: ${action || '<empty>'}`,
          },
        },
        true,
      );
    }
    if (capabilityId === 'workflow.control') {
      const scope = workflowScope(input);
      if (action === 'list') return result({ workflows: listWorkflowCatalog(ctx.controllerHome, scope) });
      if (action === 'get') {
        const entry = getWorkflowCatalogEntry(ctx.controllerHome, scope, workflowId(input));
        return result(entry ? { workflow: entry } : { workflow: null });
      }
      if (action === 'prepare') {
        const originKind = typeof input.origin_kind === 'string' ? input.origin_kind.trim() : '';
        if (!['user', 'event', 'model', 'plugin', 'workflow', 'system'].includes(originKind))
          throw new Error('WORKFLOW_CAPABILITY_ORIGIN_KIND_INVALID');
        return result({
          plan: prepareWorkflowInvocation({
            controllerHome: ctx.controllerHome,
            scope,
            workflowId: workflowId(input),
            origin: {
              kind: originKind as WorkflowInvocationOriginKind,
              ...(typeof input.origin_id === 'string' && input.origin_id.trim() ? { id: input.origin_id.trim() } : {}),
            },
            inputs: workflowInputs(input),
          }),
        });
      }
      if (action === 'preview') {
        return result({
          preview: previewWorkflowGraph({
            controllerHome: ctx.controllerHome,
            scope,
            workflowId: workflowId(input),
            inputs: workflowInputs(input),
          }),
        });
      }
      if (action === 'authoring_preflight') {
        return result({ preflight: preflightWorkflowProposal(ctx.controllerHome, input.proposal) });
      }
      if (action === 'install') {
        const preflight = preflightWorkflowProposal(ctx.controllerHome, input.proposal);
        if (preflight.scope.kind !== 'controller')
          throw new Error('WORKFLOW_CAPABILITY_PROJECT_INSTALL_REQUIRES_PROJECT_CONTENT_AUTHORITY');
        // Public authoring must not create a bare legacy Workflow. Unknown
        // effects default to approval-required until explicitly reviewed.
        applyPackagedWorkflowProposal({
          controllerHome: ctx.controllerHome,
          proposal: input.proposal,
          destination: { kind: 'controller', controllerHome: ctx.controllerHome },
          runtimeVersion: FORGE_VERSION,
          package: { risk: { level: 'external_write', requiresApproval: true } },
          authorization: { canInstallWorkflows: true, canUpdateWorkflows: true },
        });
        return result({
          workflow: readWorkflowRegistryEntry(ctx.controllerHome, scope, preflight.descriptor.workflowId),
        });
      }
      if (action === 'resume_due') {
        const now = typeof input.now === 'string' && input.now.trim() ? new Date(input.now.trim()) : new Date();
        if (!Number.isFinite(now.getTime())) throw new Error('WORKFLOW_CAPABILITY_RESUME_DUE_TIME_INVALID');
        const limit = typeof input.limit === 'number' ? Math.trunc(input.limit) : undefined;
        return result({
          results: await resumeDueWorkflowGraphWaits(ctx.controllerHome, now, {}, limit),
        });
      }
      if (action === 'execute') {
        const repository = selected(ctx, args);
        const executionIdentity = executionIdentityForRepository(repository);
        const session = startOrResumeSession(ctx);
        const id = workflowId(input);
        const runId = typeof input.run_id === 'string' ? input.run_id.trim() : '';
        if (!runId) throw new Error('WORKFLOW_CAPABILITY_RUN_ID_REQUIRED');
        const originKind = typeof input.origin_kind === 'string' ? input.origin_kind.trim() : '';
        if (!['user', 'event', 'model', 'plugin', 'workflow', 'system'].includes(originKind))
          throw new Error('WORKFLOW_CAPABILITY_ORIGIN_KIND_INVALID');
        return result({
          workflow: await executeRegisteredWorkflowFeature({
            controllerHome: ctx.controllerHome,
            repository,
            executionIdentity,
            scopeId: `repository:${repository.repoId}:checkout:${repository.activeCheckoutId}:workflow:${id}`,
            ...(typeof input.requirement_id === 'string' && input.requirement_id.trim()
              ? { requirementId: input.requirement_id.trim() }
              : {}),
            runId,
            registryScope: scope,
            workflowId: id,
            inputs: workflowInputs(input),
            ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {}),
            origin: {
              kind: originKind as WorkflowInvocationOriginKind,
              ...(typeof input.origin_id === 'string' && input.origin_id.trim() ? { id: input.origin_id.trim() } : {}),
            },
            approvalContext: {
              sessionId: session.sessionId,
              principalId: principalFor(ctx),
              permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
            },
          }),
        });
      }
      if (action === 'activate' || action === 'deactivate') {
        const expectedRevision =
          typeof input.expected_revision === 'number' ? Math.trunc(input.expected_revision) : undefined;
        const id = workflowId(input);
        setWorkflowLifecycle({
          controllerHome: ctx.controllerHome,
          scope,
          workflowId: id,
          status: action === 'activate' ? 'active' : 'inactive',
          runtimeVersion: FORGE_VERSION,
          ...(expectedRevision === undefined ? {} : { expectedRegistryRevision: expectedRevision }),
          authorization: { canActivateWorkflows: true },
        });
        return result({ workflow: readWorkflowRegistryEntry(ctx.controllerHome, scope, id) });
      }
      return result(
        {
          error: {
            code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
            message: `Unsupported workflow.control action: ${action || '<empty>'}`,
          },
        },
        true,
      );
    }
    if (capabilityId === 'repository.direct_edit') {
      const toolName =
        action === 'plan'
          ? 'repository_safe_patch_plan'
          : action === 'apply'
            ? 'repository_safe_patch_apply'
            : undefined;
      if (!toolName) {
        return result(
          {
            error: {
              code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
              message: `Unsupported repository.direct_edit action: ${action || '<empty>'}`,
            },
          },
          true,
        );
      }
      // The canonical repository dispatcher owns the sessionless edit engine.
      // Process validation is transport orchestration, so reuse the same composite
      // as the compatibility top-level tool instead of silently dropping check_ids.
      const forwardedArgs = {
        ...input,
        ...(typeof args.repo_id === 'string' && args.repo_id.trim() ? { repo_id: args.repo_id.trim() } : {}),
        ...(typeof args.checkout_id === 'string' && args.checkout_id.trim()
          ? { checkout_id: args.checkout_id.trim() }
          : {}),
        ...(typeof args.request_id === 'string' && args.request_id.trim()
          ? { request_id: args.request_id.trim() }
          : {}),
      };
      if (action === 'apply' && requestsRepositorySafePatchValidation(forwardedArgs)) {
        return executeRepositorySafePatchComposite(ctx, forwardedArgs);
      }
      const forwarded = await callRepositoryTool(ctx.controllerHome, toolName, forwardedArgs, {
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
        controllerInstanceId: ctx.controllerInstanceId,
      });
      return (
        forwarded ??
        result(
          {
            error: {
              code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE',
              message: 'Repository direct-edit capability route is unavailable.',
            },
          },
          true,
        )
      );
    }
    if (capabilityId === 'repository.validation') {
      return result(
        {
          error: {
            code: 'WORK_LIFECYCLE_RETIRED',
            message:
              'repository.validation.validate_work is retired; run registered checks directly against repo_id/checkout_id.',
          },
        },
        true,
      );
    }
    if (capabilityId !== 'repository.git') {
      return result(
        {
          error: {
            code: 'CORE_CAPABILITY_UNSUPPORTED',
            message: `Unsupported core capability: ${capabilityId || '<empty>'}`,
          },
        },
        true,
      );
    }
    if (action === 'status') {
      const forwarded = await callRepositoryTool(
        ctx.controllerHome,
        'repository_git_status',
        {
          ...(typeof args.repo_id === 'string' && args.repo_id.trim() ? { repo_id: args.repo_id.trim() } : {}),
          ...(typeof args.checkout_id === 'string' && args.checkout_id.trim()
            ? { checkout_id: args.checkout_id.trim() }
            : {}),
          ...(typeof input.refresh === 'boolean' ? { refresh: input.refresh } : {}),
        },
        {
          sessionId: ctx.sessionId,
          principalId: ctx.principalId,
          controllerInstanceId: ctx.controllerInstanceId,
        },
      );
      return (
        forwarded ??
        result(
          {
            error: {
              code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE',
              message: 'Repository Git status capability route is unavailable.',
            },
          },
          true,
        )
      );
    }
    const repository = selected(ctx, args);
    switch (action) {
      case 'diff':
        return result({
          diff: repositoryGitDiff(repository, {
            paths: input.paths,
            staged: input.staged === true,
            maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : undefined,
          }),
        });
      case 'diff_paths':
        return result({
          ...selectedPathDiff(repository, {
            paths: input.paths,
            staged: input.staged === true,
            maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : undefined,
          }),
        });
      case 'stage_paths': {
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: input.paths });
        return result(
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            ...staged,
          },
          staged.execution.ok !== true,
        );
      }
      case 'commit_paths': {
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          message: input.message,
        });
        return result(
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            ...committed,
          },
          Boolean(committed.error),
        );
      }
      case 'restore_paths': {
        const restored = restoreSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          expectedHead: input.expected_head,
          expectedBranch: input.expected_branch,
          expectedPatch: input.expected_patch,
          confirmAuthorization: input.confirm_authorization,
        });
        return result(
          {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
            ...restored,
          },
          Boolean(restored.error),
        );
      }
      case 'delete_remote_branch': {
        const forwarded = await callRepositoryTool(ctx.controllerHome, 'repository_git_delete_branch', {
          repo_id: repository.repoId,
          checkout_id: repository.activeCheckoutId,
          branch: input.branch,
          remote: true,
          expected_remote_sha: input.expected_remote_sha,
          ...(typeof input.approval_request_id === 'string' && input.approval_request_id.trim()
            ? { approval_request_id: input.approval_request_id.trim() }
            : {}),
        });
        return (
          forwarded ??
          result(
            {
              error: {
                code: 'CORE_CAPABILITY_ROUTE_UNAVAILABLE',
                message: 'Repository remote-branch delete route is unavailable.',
              },
            },
            true,
          )
        );
      }
      case 'deliver_work':
      case 'discard_work':
        return result(
          {
            error: {
              code: 'WORK_LIFECYCLE_RETIRED',
              message: `repository.git.${action} is retired; use ordinary Git/checkout capabilities. Historical Work cleanup is maintenance-owned.`,
            },
          },
          true,
        );
      default:
        return result(
          {
            error: {
              code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED',
              message: `Unsupported repository.git action: ${action || '<empty>'}`,
            },
          },
          true,
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'CORE_CAPABILITY_FAILED', message } }, true);
  }
}
