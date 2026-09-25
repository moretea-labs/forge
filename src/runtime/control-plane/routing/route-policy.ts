import { createHash } from 'crypto';

export const ROUTE_POLICY_VERSION = 'route-policy-v5' as const;

export type RouteExecutionMode = 'direct_control' | 'goal_workloop' | 'handoff_only';
export type RouteWorkMode = 'direct_edit' | 'bounded_work' | 'quick_agent' | 'issue_task';
export type RouteExecutionPath = 'fast' | 'durable';
export type RouteExecutorKind = 'direct_edit' | 'local_cli' | 'remote_api' | 'cloud_agent' | 'external_controller' | 'handoff_only';
export type RouteApprovalState = 'approval_not_required' | 'normal_authorization_required' | 'strong_confirmation_required' | 'blocked_by_policy';
export type ExplicitTaskMode = 'direct' | 'plan' | 'debug' | 'review' | 'release' | 'scale';

export interface RouteReason {
  code: string;
  message: string;
}

export interface RouteContextHints {
  preferredProviderId?: string;
  allowedProviderIds?: readonly string[];
  forbiddenProviderIds?: readonly string[];
}

export interface RouteProviderSnapshot {
  providerId: string;
  kind: 'direct_edit' | 'local_cli' | 'remote_api' | 'cloud_agent' | 'handoff_only';
  status: string;
  capabilities: readonly string[];
  directDispatch: boolean;
}

export interface RoutePolicyInput {
  intent: {
    objective: string;
    scopeClear: boolean;
    mutation?: boolean;
    /**
     * Operator-configured routing-preference key used only to match authored
     * Context Plane `routing_preference` records. Forge never derives this key
     * from task semantics, size, method, or failure class.
     */
    preferredProviderId?: string;
    allowedProviderIds?: readonly string[];
    forbiddenProviderIds?: readonly string[];
  };
  workspace: {
    knownPaths?: readonly string[];
    dirty?: boolean;
    checkoutId?: string;
    fingerprint?: string;
    /** Canonical typed placement constraint resolved before routing. */
    placement?: 'current' | 'isolated' | 'auto';
    /** Admission fence: Direct Control/current-main mutation is not permitted. */
    directMainProhibited?: boolean;
  };
  policy: {
    risk?: string;
    policyBlocked?: boolean;
    requiresApproval?: boolean;
    requiresUserApproval?: boolean;
    approvalConfirmed?: boolean;
    destructive?: boolean;
    remoteWrite?: boolean;
    secretAccess?: boolean;
  };
  capabilities: {
    requiresWorker?: boolean;
    requiresExternalEffect?: boolean;
    requiredProviderCapabilities?: readonly string[];
    providers?: readonly RouteProviderSnapshot[];
  };
  recovery: {
    required?: boolean;
    isolationRequired?: boolean;
  };
}

export interface RouteDecision {
  executionMode: RouteExecutionMode;
  executorKind: RouteExecutorKind;
  selectedProviderId: string | null;
  workMode: RouteWorkMode;
  executionPath: RouteExecutionPath;
  requiresWork: boolean;
  requiresApproval: boolean;
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  createHandoff: boolean;
  waitForUser: boolean;
  approvalState: RouteApprovalState;
  alternatives: string[];
  reasons: RouteReason[];
  inputFingerprint: string;
  policyVersion: typeof ROUTE_POLICY_VERSION;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function routePolicyInputFingerprint(input: RoutePolicyInput): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function applyRouteContextHints(input: RoutePolicyInput, hints: RouteContextHints | undefined): RoutePolicyInput {
  if (!hints) return input;
  return {
    ...input,
    intent: {
      ...input.intent,
      preferredProviderId: input.intent.preferredProviderId ?? hints.preferredProviderId,
      allowedProviderIds: input.intent.allowedProviderIds ?? hints.allowedProviderIds,
      forbiddenProviderIds: input.intent.forbiddenProviderIds ?? hints.forbiddenProviderIds,
    },
  };
}

function ready(provider: RouteProviderSnapshot, required: readonly string[]): boolean {
  return provider.directDispatch
    && provider.status === 'ready'
    && provider.kind !== 'handoff_only'
    && provider.providerId !== 'chatgpt_handoff'
    && required.every((capability) => provider.capabilities.includes(capability));
}

function selectProvider(input: RoutePolicyInput): { provider: RouteProviderSnapshot | null; alternatives: string[]; key: 'preferred' | 'unique' | 'multiple' | 'none' } {
  const providers = input.capabilities.providers;
  if (!providers) return { provider: null, alternatives: [], key: 'none' };
  const required = input.capabilities.requiredProviderCapabilities ?? [];
  const allowed = new Set(input.intent.allowedProviderIds ?? []);
  const forbidden = new Set(input.intent.forbiddenProviderIds ?? []);
  const eligible = providers
    .filter((provider) => ready(provider, required))
    .filter((provider) => !forbidden.has(provider.providerId))
    .filter((provider) => allowed.size === 0 || allowed.has(provider.providerId))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  const alternatives = eligible.map((provider) => provider.providerId);
  const preferredProviderId = input.intent.preferredProviderId?.trim();
  if (preferredProviderId) {
    const preferred = eligible.find((provider) => provider.providerId === preferredProviderId);
    if (preferred) return { provider: preferred, alternatives, key: 'preferred' };
  }
  if (eligible.length === 1) return { provider: eligible[0]!, alternatives, key: 'unique' };
  if (eligible.length > 1) return { provider: null, alternatives, key: 'multiple' };
  return { provider: null, alternatives, key: 'none' };
}

function decisionBase(input: RoutePolicyInput, reasons: RouteReason[]): Pick<RouteDecision, 'inputFingerprint' | 'policyVersion' | 'reasons'> {
  return { inputFingerprint: routePolicyInputFingerprint(input), policyVersion: ROUTE_POLICY_VERSION, reasons };
}

export function decideRoute(input: RoutePolicyInput): RouteDecision {
  const reasons: RouteReason[] = [];
  const objective = input.intent.objective.trim();
  const risk = input.policy.risk ?? (input.intent.mutation === false ? 'readonly' : 'local_repo_write');
  const mutation = input.intent.mutation ?? risk !== 'readonly';
  const destructive = input.policy.destructive === true || risk === 'destructive' || risk === 'destructive_remote';
  const remoteWrite = input.policy.remoteWrite === true || risk === 'remote_write' || risk === 'destructive_remote';
  const secretAccess = input.policy.secretAccess === true || risk === 'raw_secret_config';
  const approvalRequired = input.policy.requiresApproval === true || input.policy.requiresUserApproval === true || destructive || remoteWrite || secretAccess;
  const approvalConfirmed = input.policy.approvalConfirmed === true;
  const requiresIsolation = input.workspace.placement === 'isolated'
    || input.workspace.directMainProhibited === true
    || input.recovery.isolationRequired === true;
  const requiresRecovery = input.recovery.required === true;

  if (input.policy.policyBlocked === true) {
    reasons.push({ code: 'policy_blocked', message: 'Policy blocks execution until authorization or scope changes.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresApproval: true,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: 'blocked_by_policy', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if (!objective) {
    reasons.push({ code: 'objective_missing', message: 'A non-empty objective is required before execution.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresApproval: false,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: 'approval_not_required', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if (input.policy.requiresUserApproval === true && !approvalConfirmed) {
    reasons.push({ code: 'user_decision_required', message: 'The architecture or execution strategy change requires an explicit user decision.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresApproval: true,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: 'normal_authorization_required', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if ((!input.intent.scopeClear && (destructive || remoteWrite || secretAccess)) || (approvalRequired && !approvalConfirmed)) {
    reasons.push({
      code: !input.intent.scopeClear ? 'high_risk_scope_incomplete' : 'authorization_required',
      message: !input.intent.scopeClear
        ? 'High-risk work requires a complete scope before execution.'
        : 'The requested side effect requires explicit authorization before execution.',
    });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'fast', requiresWork: false, requiresApproval: true,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: destructive || secretAccess ? 'strong_confirmation_required' : 'normal_authorization_required',
      alternatives: [], ...decisionBase(input, reasons),
    };
  }

  if (input.workspace.dirty && mutation) {
    reasons.push({
      code: 'dirty_workspace_preserve_existing_changes',
      message: 'The checkout is already dirty; preserve unrelated changes and treat inspected/actual scope as evidence instead of creating Work solely for adoption.',
    });
  }
  if (requiresRecovery) reasons.push({ code: 'recovery_required', message: 'The operation needs resumable Work and bounded recovery.' });
  if (input.workspace.placement === 'isolated') reasons.push({ code: 'placement_isolated', message: 'Typed Work admission requires an isolated workspace.' });
  if (input.workspace.directMainProhibited === true) reasons.push({ code: 'direct_main_prohibited', message: 'Typed Work admission forbids the Direct Control/current-main mutation lane.' });
  if (requiresIsolation) reasons.push({ code: 'isolation_required', message: 'The operation requires an isolated checkout or serialized lane.' });
  // Compatibility projections only. Route Policy no longer chooses whether a
  // Work exists or which engineering method the model must use. Calling rh_work
  // is the explicit durable-Work choice; direct domain capabilities bypass it.
  const executionMode: RouteExecutionMode = 'direct_control';
  const workMode: RouteWorkMode = 'direct_edit';
  const executionPath: RouteExecutionPath = 'fast';
  const providerSelection = selectProvider(input);
  const providersWereSupplied = input.capabilities.providers !== undefined;
  if (providersWereSupplied && !providerSelection.provider && providerSelection.alternatives.length === 0) {
    reasons.push({ code: 'provider_unavailable', message: 'No allowed provider with the required capabilities is ready.' });
    return {
      executionMode, executorKind: 'handoff_only', selectedProviderId: null,
      workMode, executionPath, requiresWork: false, requiresApproval: false,
      requiresIsolation, requiresRecovery, createHandoff: false, waitForUser: false,
      approvalState: 'approval_not_required', alternatives: providerSelection.alternatives,
      ...decisionBase(input, reasons),
    };
  }
  const selectedProvider = providerSelection.provider;
  if (!selectedProvider && providerSelection.key === 'multiple') {
    reasons.push({ code: 'provider_choice_available', message: 'Multiple eligible providers are available; caller/model may select one explicitly with preferredProviderId.' });
  }
  const executorKind: RouteExecutorKind = selectedProvider?.kind
    ?? (input.capabilities.requiresWorker ? 'external_controller' : 'direct_edit');
  if (selectedProvider) reasons.push({ code: 'provider_selected', message: `Selected ${selectedProvider.providerId} from ${providerSelection.key} mechanical placement.` });
  if (reasons.length === 0) reasons.push({ code: 'capability_ready', message: 'Policy and provider eligibility permit the requested capability; the model owns workflow and Work choice.' });

  return {
    executionMode,
    executorKind,
    selectedProviderId: selectedProvider?.providerId ?? null,
    workMode,
    executionPath,
    // Direct Control is intentionally contract-free. Persistence belongs to
    // Goal Workloop/Agent tiers; bounded direct edits rely on the
    // existing permission, patch, Process, and evidence boundaries instead.
    requiresWork: false,
    requiresApproval: approvalRequired,
    requiresIsolation,
    requiresRecovery,
    createHandoff: false,
    waitForUser: false,
    approvalState: 'approval_not_required',
    alternatives: providerSelection.alternatives,
    ...decisionBase(input, reasons),
  };
}
