import type { AssistantPluginManifest } from '../../plugins/types';
import type { CapabilityDescriptor, CapabilityDomain, CapabilityExecutionSurface, CapabilityGroupSummary, CapabilityOperationClass, CapabilityRisk, FacadeTool } from './types';

const CORE_CAPABILITIES: CapabilityDescriptor[] = [
  {
    capabilityId: 'repository.direct_edit',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'write',
    risk: 'local_repo_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Apply bounded direct edits, patches, selected-path staging, selected commits, and targeted checks for small supervised tasks.',
  },
  {
    capabilityId: 'controller.goal_workloop',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Run a recoverable multi-step work contract through isolated worktree, worker, approval, verification, and continuation handoff.',
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
    capabilityId: 'repository.context',
    domain: 'repository',
    group: 'repository-core',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_context',
    schemaExposure: 'stable_static',
    summary: 'Read bounded repository context, checks, project state, and execution-mode recommendations.',
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
    capabilityId: 'controller.external_controller',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Claim Work ownership and start an external Codex, Claude, or ChatGPT controller through controller_claim and launcher_start, with handoff decisions coordinated through rh_inbox; deprecated delegate is not an execution path.',
  },
  {
    capabilityId: 'controller.work_contract',
    domain: 'controller',
    group: 'controller',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Persist and advance WorkContract records for goal workloop start, continue, verify, finalize, and stop.',
  },
  {
    capabilityId: 'controller.plan_contract',
    domain: 'controller',
    group: 'controller',
    operationClass: 'read',
    risk: 'readonly',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Persist bounded pre-execution plans with frozen revisions, step acceptance criteria, explicit approval, and supersession before complex work creates an execution contract.',
  },
  {
    capabilityId: 'repository.git',
    domain: 'repository',
    group: 'git',
    operationClass: 'finalize',
    risk: 'local_repo_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Use typed Git status, diff, branch, commit, integration, and cleanup handlers without routing arbitrary Git text through a facade RPC.',
  },
  {
    capabilityId: 'workflow.issue_task',
    domain: 'controller',
    group: 'issue-task',
    operationClass: 'execute',
    risk: 'workspace_write',
    exposedVia: 'rh_work',
    schemaExposure: 'stable_static',
    summary: 'Plan, dispatch, review, verify, retry, and accept durable Issue and Task work through existing typed handlers.',
  },
  {
    capabilityId: 'plugin.browser',
    domain: 'plugin',
    group: 'browser',
    operationClass: 'execute',
    risk: 'unknown',
    exposedVia: 'plugin_action_execute',
    schemaExposure: 'stable_static',
    summary: 'Use typed HTTP(S) browser navigation, snapshot, and interaction actions through plugin_action_execute when browser capability is configured.',
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
  return {
    capabilityId: `plugin.${manifest.pluginId}.${action.actionId}`,
    domain: domainFromPlugin(manifest.pluginId),
    group: manifest.pluginId === 'browser' ? 'browser' : 'plugin',
    operationClass: operationClassFromAction(action.readOnly, action.risk),
    risk: riskFromAction(action.risk),
    exposedVia: exposedViaFromPluginAction(action.readOnly, action.risk),
    schemaExposure: 'plugin_manifest',
    summary: `${manifest.displayName}: ${action.title}. ${action.description}`,
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

function intentBoosts(query: string, capabilityId: string): Array<{ label: string; score: number }> {
  const normalized = normalizedCapabilityText(query);
  const boosts: Array<{ label: string; score: number }> = [];
  const appleDevelopmentIntent = /\b(xcode|provision|provisioning|signing|developer account|apple developer)\b/.test(normalized);
  if (appleDevelopmentIntent) {
    if (capabilityId === 'platform.ios') boosts.push({ label: 'apple-development', score: 90 });
    if (capabilityId.startsWith('plugin.ios.')) boosts.push({ label: 'apple-development', score: 72 });
    if (capabilityId === 'plugin.app_store_connect.auth_status') boosts.push({ label: 'apple-development', score: 88 });
    else if (capabilityId === 'plugin.app_store_connect.configure') boosts.push({ label: 'apple-development', score: 82 });
    else if (capabilityId.startsWith('plugin.app_store_connect.')) boosts.push({ label: 'apple-development', score: 28 });
    if (capabilityId === 'plugin.desktop_operator.desktop_session_open') boosts.push({ label: 'xcode-desktop-fallback', score: 86 });
    else if (capabilityId === 'plugin.desktop_operator.desktop_observe') boosts.push({ label: 'xcode-desktop-fallback', score: 78 });
    else if (capabilityId === 'plugin.desktop_operator.desktop_press') boosts.push({ label: 'xcode-desktop-fallback', score: 74 });
    else if (capabilityId.startsWith('plugin.desktop_operator.')) boosts.push({ label: 'xcode-desktop-fallback', score: 22 });
  }

  const browserLoginIntent = normalized.includes('browser')
    && /\b(login|log in|signin|sign in|auth|authentication|session)\b/.test(normalized);
  if (browserLoginIntent) {
    if (capabilityId === 'plugin.browser') boosts.push({ label: 'browser-auth', score: 90 });
    else if (capabilityId.startsWith('plugin.browser.')) boosts.push({ label: 'browser-auth', score: 62 });
    if (capabilityId === 'plugin.desktop_operator.desktop_session_open') boosts.push({ label: 'browser-desktop-fallback', score: 70 });
    else if (capabilityId === 'plugin.desktop_operator.desktop_observe') boosts.push({ label: 'browser-desktop-fallback', score: 62 });
    else if (capabilityId.startsWith('plugin.desktop_operator.')) boosts.push({ label: 'browser-desktop-fallback', score: 18 });
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
      ].join(' '));
      let score = haystack.includes(normalizedQuery) ? 48 : 0;
      const matchedTerms = new Set<string>();
      for (const token of tokens) {
        if (!haystack.includes(token)) continue;
        matchedTerms.add(token);
        score += descriptor.capabilityId.toLowerCase().includes(token) ? 12 : 5;
      }
      for (const boost of intentBoosts(query, descriptor.capabilityId)) {
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
      facadeTools: [...new Set(entries.map((entry) => entry.exposedVia).filter((surface): surface is FacadeTool => surface.startsWith('rh_')))].sort(),
      operationClasses: [...new Set(entries.map((entry) => entry.operationClass))].sort(),
      risks: [...new Set(entries.map((entry) => entry.risk))].sort(),
      schemaExposures: [...new Set(entries.map((entry) => entry.schemaExposure))].sort(),
    }));
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
