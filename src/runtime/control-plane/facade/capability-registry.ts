import {
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
} from '../../../../packages/protocols/computer/index';
import type { AssistantPluginManifest } from '../../plugins/types';
import { EDIT_OPERATION_INPUT_SCHEMA } from '../../../cli/editing/edit-operation-contract';
import { FACADE_TOOLS, type CapabilityDescriptor, type CapabilityDomain, type CapabilityExecutionSurface, type CapabilityGroupSummary, type CapabilityOperationClass, type CapabilityRisk, type FacadeTool } from './types';

const CORE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    capabilityId: 'repository.direct_edit',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'write',
    risk: 'local_repo_write',
    exposedVia: 'capability_execute',
    schemaExposure: 'stable_static',
    summary: 'Plan and apply bounded repository edits through the existing Safe Patch/EditSession authority, with optional targeted validation and no second editing engine.',
  },
  {
    capabilityId: 'controller.handoff_inbox',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_inbox',
    schemaExposure: 'stable_static',
    summary: 'Persist pending decisions that need ChatGPT or user judgement without turning normal logs into inbox items.',
  },
  {
    capabilityId: 'controller.status',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_status',
    schemaExposure: 'stable_static',
    summary: 'Read bounded controller, queue, worker, projection, plugin, and readiness status.',
  },
  {
    capabilityId: 'controller.connection',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'capability_execute',
    schemaExposure: 'stable_static',
    summary: 'Read product-safe controller and tunnel connection state, and refresh the existing Forge Connector through setup authority without creating another configuration owner.',
  },
  {
    capabilityId: 'controller.local_conversation',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'capability_execute',
    schemaExposure: 'stable_static',
    summary: 'Run one Work-independent local controller conversation through the existing Codex provider and current Forge Runtime MCP capabilities; conversation transport never creates semantic Work implicitly.',
  },
  {
    capabilityId: 'repository.context',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    schemaExposure: 'stable_static',
    summary: 'Read bounded repository context, checks, project state, source structure, and execution evidence without choosing the model workflow.',
  },
  {
    capabilityId: 'evidence.read',
    domain: 'evidence',
    group: 'evidence',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    schemaExposure: 'stable_static',
    summary: 'Read bounded evidence and artifact references without returning raw logs by default.',
  },
  {
    capabilityId: 'maintenance.safe_repair',
    domain: 'maintenance',
    group: 'runtime-maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_status',
    schemaExposure: 'stable_static',
    summary: 'Run bounded runtime repair and maintenance only after policy gate approval.',
  },
  {
    capabilityId: 'controller.self_healing',
    domain: 'maintenance',
    group: 'runtime-maintenance',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Diagnose and dry-run repair stuck jobs, stale projections, invalid check pollution, and worker unavailability without treating infrastructure failure as acceptance failure.',
  },
  {
    capabilityId: 'controller.plan_contract',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Persist model-authored Plan working memory with stable identity and semantic revision/CAS; Plan items do not own execution, checks, or acceptance.',
  },
  {
    capabilityId: 'repository.git',
    domain: 'repository',
    group: 'git',
    operationClass: 'write',
    risk: 'local_repo_write',
    exposedVia: 'capability_execute',
    schemaExposure: 'stable_static',
    summary: 'Repository-native typed Git handlers own identity, dirty-path, CAS, lease, conflict, authorization, and idempotency fences; Work completion is not a Git admission gate.',
  },
  {
    capabilityId: 'platform.ios',
    domain: 'plugin',
    group: 'ios',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'plugin_action_execute',
    schemaExposure: 'stable_static',
    summary: 'Use typed Xcode, simulator, screenshot, log, and smoke-review actions through plugin_action_execute when the local iOS toolchain is ready.',
  },
];

function riskFromAction(actionRisk: string): CapabilityRisk {
  if (actionRisk === 'readonly') return 'readonly';
  if (actionRisk === 'remote_write') return 'remote_write';
  if (actionRisk === 'destructive') return 'destructive_remote';
  if (actionRisk === 'workspace_write') return 'workspace_write';
  return 'unknown';
}

function operationClassFromAction(readOnly: boolean, risk: string): CapabilityOperationClass {
  if (readOnly || risk === 'readonly') return 'read';
  if (risk === 'destructive') return 'finalize';
  if (risk === 'remote_write') return 'execute';
  return 'write';
}

function domainFromPlugin(pluginId: string): CapabilityDomain {
  if (pluginId === 'github') return 'repository';
  if (pluginId === 'browser') return 'plugin';
  return 'plugin';
}

function exposedViaFromPluginAction(_readOnly: boolean, _risk: string): CapabilityExecutionSurface {
  // rh_context exposes schema/policy. plugin_action_execute is the sole action executor.
  return 'plugin_action_execute';
}

function pluginCapabilityDescriptor(
  manifest: AssistantPluginManifest,
  action: AssistantPluginManifest['actions'][number],
): CapabilityDescriptor {
  const semanticCapabilities = (manifest.capabilities ?? [])
    .filter((capability) => capability.actions.includes(action.actionId))
    .map((capability) => capability.capabilityId)
    .sort();
  return {
    capabilityId: `plugin.${manifest.pluginId}.${action.actionId}`,
    domain: domainFromPlugin(manifest.pluginId),
    group: manifest.pluginId === 'browser' ? 'browser' : 'plugin',
    operationClass: operationClassFromAction(action.readOnly, action.risk),
    risk: riskFromAction(action.risk),
    exposedVia: exposedViaFromPluginAction(action.readOnly, action.risk),
    schemaExposure: 'plugin_manifest',
    summary: `${manifest.displayName}: ${action.title}. ${action.description}`,
    ...(semanticCapabilities.length > 0 ? { semanticCapabilities } : {}),
  } satisfies CapabilityDescriptor;
}

export function pluginCapabilities(manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor[] {
  return manifests.flatMap((manifest) => manifest.actions.map((action) => pluginCapabilityDescriptor(manifest, action)));
}

export function listCapabilityDescriptors(manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor[] {
  const byId = new Map<string, CapabilityDescriptor>();
  for (const descriptor of [...CORE_CAPABILITIES, ...pluginCapabilities(manifests)]) byId.set(descriptor.capabilityId, descriptor);
  return [...byId.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

export interface CapabilitySearchMatch {
  capabilityId: string;
  score: number;
  matchedTerms: string[];
  descriptor: CapabilityDescriptor;
}

function normalizedCapabilityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function capabilityIntentTokens(query: string): string[] {
  return [...new Set(normalizedCapabilityText(query).split(' ').filter((token) => token.length >= 2))];
}

function intentBoosts(query: string, descriptor: CapabilityDescriptor): Array<{ label: string; score: number }> {
  const normalized = normalizedCapabilityText(query);
  const capabilityId = descriptor.capabilityId;
  const semanticCapabilities = new Set(descriptor.semanticCapabilities ?? []);
  const boosts: Array<{ label: string; score: number }> = [];
  const appleDevelopmentIntent = /\b(xcode|provision|provisioning|signing|developer account|apple developer)\b/.test(normalized);
  if (appleDevelopmentIntent) {
    if (capabilityId === 'platform.ios') boosts.push({ label: 'apple-development', score: 90 });
    if (capabilityId.startsWith('plugin.ios.')) boosts.push({ label: 'apple-development', score: 72 });
    if (capabilityId === 'plugin.app_store_connect.auth_status') boosts.push({ label: 'apple-development', score: 88 });
    else if (capabilityId === 'plugin.app_store_connect.configure') boosts.push({ label: 'apple-development', score: 82 });
    else if (capabilityId.startsWith('plugin.app_store_connect.')) boosts.push({ label: 'apple-development', score: 28 });
    if (semanticCapabilities.has(COMPUTER_OBSERVE_CAPABILITY)) boosts.push({ label: 'xcode-computer-observe', score: 78 });
    if (semanticCapabilities.has(COMPUTER_INPUT_CAPABILITY)) boosts.push({ label: 'xcode-computer-input', score: 74 });
    if (semanticCapabilities.has(COMPUTER_CAPTURE_CAPABILITY)) boosts.push({ label: 'xcode-computer-capture', score: 44 });
  }

  const browserLoginIntent = normalized.includes('browser')
    && /\b(login|log in|signin|sign in|auth|authentication|session)\b/.test(normalized);
  if (browserLoginIntent) {
    if (semanticCapabilities.has(COMPUTER_OBSERVE_CAPABILITY)) boosts.push({ label: 'browser-computer-observe', score: 90 });
    if (semanticCapabilities.has(COMPUTER_INPUT_CAPABILITY)) boosts.push({ label: 'browser-computer-input', score: 82 });
  }
  return boosts;
}

export function searchCapabilityDescriptors(
  query: string,
  manifests: readonly AssistantPluginManifest[] = [],
  limit = 12,
): CapabilitySearchMatch[] {
  const normalizedQuery = normalizedCapabilityText(query);
  if (!normalizedQuery) return [];
  const tokens = capabilityIntentTokens(query);
  const boundedLimit = Math.max(1, Math.min(24, Math.floor(limit)));

  return listCapabilityDescriptors(manifests)
    .map((descriptor): CapabilitySearchMatch | undefined => {
      const haystack = normalizedCapabilityText([
        descriptor.capabilityId,
        descriptor.summary,
        descriptor.group,
        descriptor.domain,
        descriptor.operationClass,
        descriptor.exposedVia,
        ...(descriptor.semanticCapabilities ?? []),
      ].join(' '));
      let score = haystack.includes(normalizedQuery) ? 48 : 0;
      const matchedTerms = new Set<string>();
      for (const token of tokens) {
        if (!haystack.includes(token)) continue;
        matchedTerms.add(token);
        score += descriptor.capabilityId.toLowerCase().includes(token) ? 12 : 5;
      }
      for (const boost of intentBoosts(query, descriptor)) {
        score += boost.score;
        matchedTerms.add(boost.label);
      }
      if (score <= 0) return undefined;
      return {
        capabilityId: descriptor.capabilityId,
        score,
        matchedTerms: [...matchedTerms].sort(),
        descriptor,
      };
    })
    .filter((entry): entry is CapabilitySearchMatch => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.capabilityId.localeCompare(b.capabilityId))
    .slice(0, boundedLimit);
}

export function summarizeCapabilityGroups(manifests: readonly AssistantPluginManifest[] = []): CapabilityGroupSummary[] {
  const grouped = new Map<CapabilityDescriptor['group'], CapabilityDescriptor[]>();
  for (const descriptor of listCapabilityDescriptors(manifests)) {
    const entries = grouped.get(descriptor.group) ?? [];
    entries.push(descriptor);
    grouped.set(descriptor.group, entries);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, entries]) => ({
      group,
      capabilityCount: entries.length,
      domains: [...new Set(entries.map((entry) => entry.domain))].sort(),
      executionSurfaces: [...new Set(entries.map((entry) => entry.exposedVia))].sort(),
      facadeTools: [...new Set(entries.map((entry) => entry.exposedVia).filter((surface): surface is FacadeTool => FACADE_TOOLS.includes(surface as FacadeTool)))].sort(),
      operationClasses: [...new Set(entries.map((entry) => entry.operationClass))].sort(),
      risks: [...new Set(entries.map((entry) => entry.risk))].sort(),
      schemaExposures: [...new Set(entries.map((entry) => entry.schemaExposure))].sort(),
    }));
}

export function getCoreCapabilityExecutionSchema(capabilityId: string): Record<string, unknown> | undefined {
  if (capabilityId === 'controller.connection') {
    return {
      capabilityId,
      executeWith: 'capability_execute',
      actions: {
        get: {
          readOnly: true,
          risk: 'readonly',
          argumentsSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
        configure_initial: {
          readOnly: false,
          risk: 'workspace_write',
          argumentsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['controller'],
            properties: {
              controller: { type: 'string', enum: ['chatgpt', 'codex', 'claude', 'mcp'] },
              tunnel: { type: 'string', enum: ['auto', 'none'] },
            },
          },
        },
        repair_connector: {
          readOnly: false,
          risk: 'workspace_write',
          argumentsSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
      },
    };
  }
  if (capabilityId === 'controller.local_conversation') {
    return {
      capabilityId,
      executeWith: 'capability_execute',
      actions: {
        status: {
          readOnly: true,
          risk: 'readonly',
          argumentsSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
        models: {
          readOnly: true,
          risk: 'readonly',
          argumentsSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
        activity: {
          readOnly: true,
          risk: 'readonly',
          argumentsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['conversation_id'],
            properties: { conversation_id: { type: 'string', minLength: 1, maxLength: 160 } },
          },
        },
        cancel: {
          readOnly: false,
          risk: 'workspace_write',
          argumentsSchema: { type: 'object', additionalProperties: false,
            required: ['conversation_id'], properties: {
              conversation_id: { type: 'string', minLength: 1, maxLength: 160 },
            } },
        },
        send: {
          readOnly: false,
          risk: 'workspace_write',
          argumentsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['conversation_id', 'prompt'],
            properties: {
              conversation_id: { type: 'string', minLength: 1, maxLength: 160 },
              provider_session_id: { type: 'string', minLength: 1, maxLength: 160 },
              prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
              model: { type: 'string', minLength: 1, maxLength: 120 },
              reasoning_effort: { type: 'string', minLength: 1, maxLength: 32 },
              image_paths: {
                type: 'array', maxItems: 4,
                items: { type: 'string', minLength: 1, maxLength: 4096 },
              },
              timeout_ms: { type: 'number', minimum: 5_000, maximum: 600_000 },
            },
          },
        },
      },
    };
  }
  if (capabilityId === 'repository.direct_edit') {
    return {
      capabilityId,
      executeWith: 'capability_execute',
      actions: {
        plan: {
          readOnly: true,
          risk: 'readonly',
          argumentsSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['operations'],
            properties: {
              operations: { type: 'array', minItems: 1, maxItems: 100, items: EDIT_OPERATION_INPUT_SCHEMA },
              chunk_size: { type: 'number', minimum: 1, maximum: 100 },
            },
          },
        },
        apply: {
          readOnly: false,
          risk: 'local_repo_write',
          argumentsSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string', minLength: 1, maxLength: 256 },
              purpose: { type: 'string', maxLength: 2000 },
              operations: { type: 'array', minItems: 1, maxItems: 100, items: EDIT_OPERATION_INPUT_SCHEMA },
              chunk_size: { type: 'number', minimum: 1, maximum: 100 },
              expected_revision: { type: 'number', minimum: 0 },
              allowed_paths: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 1024 } },
              continue_on_error: { type: 'boolean' },
              refresh_fingerprints: { type: 'boolean' },
              recover_stale_session: { type: 'boolean' },
              check_ids: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
              check_timeout_ms: { type: 'number', minimum: 1 },
              lease_wait_ms: { type: 'number', minimum: 0 },
              validation_request_id: { type: 'string', minLength: 1, maxLength: 256 },
              validation_only: { type: 'boolean' },
            },
          },
        },
      },
    };
  }
  if (capabilityId !== 'repository.git') return undefined;
  return {
    capabilityId,
    executeWith: 'capability_execute',
    actions: {
      diff_paths: {
        readOnly: true,
        risk: 'readonly',
        argumentsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['paths'],
          properties: {
            paths: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } },
            staged: { type: 'boolean' },
            max_bytes: { type: 'number', minimum: 1024, maximum: 524288 },
          },
        },
      },
      stage_paths: {
        readOnly: false,
        risk: 'local_repo_write',
        argumentsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['paths'],
          properties: {
            paths: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } },
          },
        },
      },
      commit_paths: {
        readOnly: false,
        risk: 'local_repo_write',
        argumentsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['paths', 'message'],
          properties: {
            paths: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } },
            message: { type: 'string', minLength: 1 },
          },
        },
      },
      restore_paths: {
        readOnly: false,
        risk: 'destructive',
        argumentsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['paths', 'expected_head', 'expected_branch', 'expected_patch', 'confirm_authorization'],
          properties: {
            paths: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } },
            expected_head: { type: 'string', minLength: 1, maxLength: 128 },
            expected_branch: { type: 'string', minLength: 1, maxLength: 512 },
            expected_patch: { type: 'string', minLength: 1, maxLength: 20000 },
            confirm_authorization: { type: 'boolean', const: true },
          },
        },
      },
      delete_remote_branch: {
        readOnly: false,
        risk: 'destructive_remote',
        argumentsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['branch', 'expected_remote_sha'],
          properties: {
            branch: { type: 'string', minLength: 1, maxLength: 512 },
            expected_remote_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
            approval_request_id: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
  };
}

export function getPluginActionCapabilitySchema(
  capabilityId: string,
  manifests: readonly AssistantPluginManifest[] = [],
): Record<string, unknown> | undefined {
  for (const manifest of manifests) {
    for (const action of manifest.actions) {
      if (`plugin.${manifest.pluginId}.${action.actionId}` !== capabilityId) continue;
      return {
        capabilityId,
        pluginId: manifest.pluginId,
        pluginDisplayName: manifest.displayName,
        pluginVersion: manifest.pluginVersion,
        pluginEnabled: manifest.enabled,
        lifecycleState: manifest.lifecycle.state,
        healthState: manifest.health.state,
        actionId: action.actionId,
        title: action.title,
        description: action.description,
        readOnly: action.readOnly,
        risk: action.risk,
        confirmation: action.confirmation,
        ...(action.requiredConfirmationText ? { requiredConfirmationText: action.requiredConfirmationText } : {}),
        defaultTimeoutMs: action.defaultTimeoutMs,
        cancellable: action.cancellable,
        idempotent: action.idempotent,
        scopes: [...action.scopes],
        resourceClaims: structuredClone(action.resourceClaims),
        argumentsSchema: structuredClone(action.argumentsSchema),
        authorizationReuse: action.confirmation === 'authorization'
          ? {
              mode: 'exact_target_persistent_when_adapter_supported',
              hostPermissionBoundary: 'Tool invocation permission remains host-managed; reusable Forge grants never bypass strong_confirmation or destructive gates.',
            }
          : { mode: 'not_reusable' },
        executeWith: 'plugin_action_execute',
      };
    }
  }
  return undefined;
}

export function getCapabilityDescriptor(capabilityId: string, manifests: readonly AssistantPluginManifest[] = []): CapabilityDescriptor | undefined {
  const core = CORE_CAPABILITIES.find((descriptor) => descriptor.capabilityId === capabilityId);
  if (core) return core;
  for (const manifest of manifests) {
    for (const action of manifest.actions) {
      if (`plugin.${manifest.pluginId}.${action.actionId}` === capabilityId) {
        return pluginCapabilityDescriptor(manifest, action);
      }
    }
  }
  return undefined;
}
