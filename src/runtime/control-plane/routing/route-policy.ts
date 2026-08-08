import { createHash } from 'crypto';

export const ROUTE_POLICY_VERSION = 'route-policy-v2' as const;

export type RouteExecutionMode = 'direct_control' | 'goal_workloop' | 'handoff_only';
export type RouteWorkMode = 'direct_edit' | 'bounded_work' | 'quick_agent' | 'issue_task' | 'campaign';
export type RouteExecutionPath = 'fast' | 'durable' | 'campaign';
export type RouteExecutorKind = 'direct_edit' | 'local_cli' | 'remote_api' | 'cloud_agent' | 'external_controller' | 'handoff_only';
export type RouteApprovalState = 'approval_not_required' | 'normal_authorization_required' | 'strong_confirmation_required' | 'blocked_by_policy';

export interface RouteReason {
  code: string;
  message: string;
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
    taskIntent?: string;
    expectedFiles?: number;
    expectedChangedLines?: number;
    requiresInvestigation?: boolean;
    requiresLongRunningChecks?: boolean;
    requiresParallelism?: boolean;
    needsDependencies?: boolean;
    requiresIndependentDeliverables?: boolean;
    independentTaskCount?: number;
    agentRequested?: boolean;
    preferredProviderId?: string;
    allowedProviderIds?: readonly string[];
    forbiddenProviderIds?: readonly string[];
    lastProviderId?: string;
    lastFailureClass?: string;
  };
  workspace: {
    knownPaths?: readonly string[];
    dirty?: boolean;
    checkoutId?: string;
    fingerprint?: string;
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
    routingOrders?: Readonly<Record<string, readonly string[] | undefined>>;
    defaultProviders?: Readonly<Record<string, string | undefined>>;
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

const PROTECTED_PATH = /(^|\/)(\.github|\.git|.*\.xcodeproj|.*\.xcworkspace)(\/|$)/;

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

function ready(provider: RouteProviderSnapshot, required: readonly string[]): boolean {
  return provider.directDispatch
    && provider.status === 'ready'
    && provider.kind !== 'handoff_only'
    && provider.providerId !== 'chatgpt_handoff'
    && required.every((capability) => provider.capabilities.includes(capability));
}

function routingKey(input: RoutePolicyInput): string {
  const taskIntent = input.intent.taskIntent ?? 'implementation';
  const failure = input.intent.lastFailureClass;
  const repair = taskIntent === 'code_repair'
    || taskIntent === 'verification_repair'
    || failure === 'test_failure'
    || failure === 'typecheck_failure'
    || failure === 'source_defect'
    || (input.intent.lastProviderId === 'codex_cli' && (failure === 'provider_unavailable' || failure === 'unknown'));
  if (taskIntent === 'deterministic_edit') return 'deterministic_edit';
  if (repair) return 'repair';
  if (taskIntent === 'architecture_planning') return 'planning';
  if (taskIntent === 'review') return 'review';
  if (taskIntent === 'browser_automation') return 'browser_planning';
  if (taskIntent === 'ios_build_or_sim') return 'ios_analysis';
  return 'implementation';
}

const KIND_RANK: Record<RouteProviderSnapshot['kind'], number> = {
  direct_edit: 0,
  local_cli: 10,
  remote_api: 20,
  cloud_agent: 30,
  handoff_only: 90,
};

const PREFERRED_CAPABILITY: Record<string, string | undefined> = {
  deterministic_edit: 'code_patch',
  implementation: 'code_patch',
  repair: 'test_failure_repair',
  planning: 'architecture_planning',
  review: 'code_review',
  browser_planning: 'browser_planning',
  ios_analysis: 'ios_log_analysis',
};

function providerOrder(input: RoutePolicyInput, key: string, providers: readonly RouteProviderSnapshot[]): string[] {
  const configured = input.capabilities.routingOrders?.[key];
  let order = configured?.length
    ? [...configured]
    : providers
      .map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => provider.kind !== 'handoff_only' && provider.providerId !== 'chatgpt_handoff')
      .filter(({ provider }) => key === 'deterministic_edit' || provider.kind !== 'direct_edit')
      .sort((left, right) => {
        const preferred = PREFERRED_CAPABILITY[key];
        const leftSupports = preferred ? left.provider.capabilities.includes(preferred) : true;
        const rightSupports = preferred ? right.provider.capabilities.includes(preferred) : true;
        if (leftSupports !== rightSupports) return leftSupports ? -1 : 1;
        return KIND_RANK[left.provider.kind] - KIND_RANK[right.provider.kind]
          || left.index - right.index
          || left.provider.providerId.localeCompare(right.provider.providerId);
      })
      .map(({ provider }) => provider.providerId);
  const configuredDefault = input.capabilities.defaultProviders?.[key];
  if (configuredDefault && configuredDefault !== 'chatgpt_handoff') {
    order = [configuredDefault, ...order.filter((providerId) => providerId !== configuredDefault)];
  }
  if (input.intent.preferredProviderId) {
    order = [input.intent.preferredProviderId, ...order.filter((providerId) => providerId !== input.intent.preferredProviderId)];
  }
  if (key === 'repair' && input.intent.lastProviderId) {
    order = [...order.filter((providerId) => providerId !== input.intent.lastProviderId), input.intent.lastProviderId];
  }
  return [...new Set([...order, 'chatgpt_handoff'])];
}

function selectProvider(input: RoutePolicyInput): { provider: RouteProviderSnapshot | null; alternatives: string[]; key: string } {
  const providers = input.capabilities.providers;
  if (!providers) return { provider: null, alternatives: [], key: routingKey(input) };
  const required = input.capabilities.requiredProviderCapabilities ?? [];
  const allowed = new Set(input.intent.allowedProviderIds ?? []);
  const forbidden = new Set(input.intent.forbiddenProviderIds ?? []);
  const alternatives = providers
    .filter((provider) => ready(provider, required))
    .filter((provider) => !forbidden.has(provider.providerId))
    .filter((provider) => allowed.size === 0 || allowed.has(provider.providerId))
    .map((provider) => provider.providerId)
    .sort();
  const key = routingKey(input);
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
  for (const providerId of providerOrder(input, key, providers)) {
    if (providerId === 'chatgpt_handoff' || forbidden.has(providerId)) continue;
    if (allowed.size > 0 && !allowed.has(providerId)) continue;
    const provider = byId.get(providerId);
    if (provider && ready(provider, required)) return { provider, alternatives, key };
  }
  const fallback = input.capabilities.routingOrders?.fallback ?? [];
  for (const providerId of fallback) {
    if (forbidden.has(providerId) || (allowed.size > 0 && !allowed.has(providerId))) continue;
    const provider = byId.get(providerId);
    if (provider && ready(provider, required)) return { provider, alternatives, key: 'fallback' };
  }
  return { provider: null, alternatives, key };
}

function decisionBase(input: RoutePolicyInput, reasons: RouteReason[]): Pick<RouteDecision, 'inputFingerprint' | 'policyVersion' | 'reasons'> {
  return { inputFingerprint: routePolicyInputFingerprint(input), policyVersion: ROUTE_POLICY_VERSION, reasons };
}

export function decideRoute(input: RoutePolicyInput): RouteDecision {
  const reasons: RouteReason[] = [];
  const objective = input.intent.objective.trim();
  const paths = [...new Set((input.workspace.knownPaths ?? []).map((path) => path.trim()).filter(Boolean))].sort();
  const expectedFiles = Math.max(0, Math.trunc(input.intent.expectedFiles ?? paths.length));
  const expectedChangedLines = Math.max(0, Math.trunc(input.intent.expectedChangedLines ?? 0));
  const independentTaskCount = Math.max(0, Math.trunc(input.intent.independentTaskCount ?? 0));
  const risk = input.policy.risk ?? (input.intent.mutation === false ? 'readonly' : 'local_repo_write');
  const mutation = input.intent.mutation ?? risk !== 'readonly';
  const destructive = input.policy.destructive === true || risk === 'destructive' || risk === 'destructive_remote';
  const remoteWrite = input.policy.remoteWrite === true || risk === 'remote_write' || risk === 'destructive_remote';
  const secretAccess = input.policy.secretAccess === true || risk === 'raw_secret_config';
  const approvalRequired = input.policy.requiresApproval === true || input.policy.requiresUserApproval === true || destructive || remoteWrite || secretAccess;
  const approvalConfirmed = input.policy.approvalConfirmed === true;
  const protectedPath = paths.some((path) => PROTECTED_PATH.test(path));
  const requiresIsolation = input.recovery.isolationRequired === true || input.intent.requiresParallelism === true;
  const requiresRecovery = input.recovery.required === true || input.intent.requiresLongRunningChecks === true;
  const campaignEligible = input.intent.requiresIndependentDeliverables === true
    || independentTaskCount >= 3
    || (input.intent.requiresParallelism === true && independentTaskCount >= 2);

  if (input.policy.policyBlocked === true) {
    reasons.push({ code: 'policy_blocked', message: 'Policy blocks execution until authorization or scope changes.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'durable', requiresWork: false, requiresApproval: true,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: 'blocked_by_policy', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if (!objective) {
    reasons.push({ code: 'objective_missing', message: 'A non-empty objective is required before execution.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'durable', requiresWork: false, requiresApproval: false,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: 'approval_not_required', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if (input.policy.requiresUserApproval === true && !approvalConfirmed) {
    reasons.push({ code: 'user_decision_required', message: 'The architecture or execution strategy change requires an explicit user decision.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'durable', requiresWork: false, requiresApproval: true,
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
      workMode: 'direct_edit', executionPath: 'durable', requiresWork: false, requiresApproval: true,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: true,
      approvalState: destructive || secretAccess ? 'strong_confirmation_required' : 'normal_authorization_required',
      alternatives: [], ...decisionBase(input, reasons),
    };
  }

  if (input.workspace.dirty && mutation) {
    reasons.push({ code: 'dirty_workspace_requires_explicit_adoption', message: 'Mutation against a dirty workspace requires an exact reviewed adoption or a clean isolated checkout.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: null,
      workMode: 'direct_edit', executionPath: 'durable', requiresWork: true, requiresApproval: false,
      requiresIsolation: true, requiresRecovery: true, createHandoff: true, waitForUser: false,
      approvalState: 'approval_not_required', alternatives: [], ...decisionBase(input, reasons),
    };
  }
  if (protectedPath) reasons.push({ code: 'protected_path', message: 'The predicted scope includes a protected or release-sensitive path.' });
  if (requiresRecovery) reasons.push({ code: 'recovery_required', message: 'The operation needs resumable Work and bounded recovery.' });
  if (requiresIsolation) reasons.push({ code: 'isolation_required', message: 'The operation requires an isolated checkout or serialized lane.' });
  if (input.intent.requiresLongRunningChecks) reasons.push({ code: 'long_checks', message: 'Long-running checks require durable continuation.' });
  if (input.intent.requiresInvestigation) reasons.push({ code: 'investigation', message: 'Investigation is required before or during implementation.' });
  if (input.intent.needsDependencies) reasons.push({ code: 'dependencies', message: 'Dependency ordering requires durable Work.' });
  if (campaignEligible) reasons.push({ code: 'independent_deliverables', message: 'Multiple independent deliverables require campaign-level coordination.' });

  const complex = campaignEligible
    || requiresRecovery
    || requiresIsolation
    || input.intent.agentRequested === true
    || input.capabilities.requiresWorker === true
    || input.capabilities.requiresExternalEffect === true
    || input.intent.requiresInvestigation === true
    || input.intent.needsDependencies === true
    || protectedPath
    || destructive
    || remoteWrite
    || secretAccess
    || expectedFiles > 4
    || expectedChangedLines > 200;
  const executionMode: RouteExecutionMode = complex ? 'goal_workloop' : 'direct_control';
  // Work topology is independent from executor/provider choice. Campaign is
  // selected only for genuinely independent/parallel deliverables; Agent
  // preference may choose an executor inside a tier but must not create the tier.
  const workMode: RouteWorkMode = campaignEligible
    ? 'campaign'
    : input.intent.agentRequested
      ? expectedFiles > 10 || expectedChangedLines > 1_500 ? 'issue_task' : 'quick_agent'
      : complex
        ? 'bounded_work'
        : 'direct_edit';
  const executionPath: RouteExecutionPath = workMode === 'campaign' ? 'campaign' : complex ? 'durable' : 'fast';
  const providerSelection = selectProvider(input);
  const providersWereSupplied = input.capabilities.providers !== undefined;
  if (providersWereSupplied && !providerSelection.provider) {
    reasons.push({ code: 'provider_unavailable', message: 'No allowed provider with the required capabilities is ready.' });
    return {
      executionMode: 'handoff_only', executorKind: 'handoff_only', selectedProviderId: 'chatgpt_handoff',
      workMode, executionPath: 'durable', requiresWork: mutation || requiresRecovery, requiresApproval: false,
      requiresIsolation, requiresRecovery, createHandoff: true, waitForUser: false,
      approvalState: 'approval_not_required', alternatives: providerSelection.alternatives,
      ...decisionBase(input, reasons),
    };
  }
  const selectedProvider = providerSelection.provider;
  const executorKind: RouteExecutorKind = selectedProvider?.kind
    ?? (input.capabilities.requiresWorker ? 'external_controller' : 'direct_edit');
  if (selectedProvider) reasons.push({ code: 'provider_selected', message: `Selected ${selectedProvider.providerId} using ${providerSelection.key} order.` });
  if (reasons.length === 0) reasons.push({ code: executionMode === 'direct_control' ? 'bounded_direct' : 'durable_work', message: executionMode === 'direct_control' ? 'Bounded supervised work stays on Direct Control.' : 'The operation requires a durable Goal Workloop.' });

  return {
    executionMode,
    executorKind,
    selectedProviderId: selectedProvider?.providerId ?? null,
    workMode,
    executionPath,
    requiresWork: mutation || complex,
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
