import { decideRoute } from '../routing/route-policy';
import type { RoutingIntentKey } from './config-types';
import type {
  ExecutorRouteDecision,
  ExecutorRouteInput,
  ProviderDescriptor,
  ProviderStatus,
  TaskIntent,
} from './types';

export function intentToRoutingKey(intent: TaskIntent): RoutingIntentKey {
  switch (intent) {
    case 'deterministic_edit': return 'deterministic_edit';
    case 'code_repair':
    case 'verification_repair': return 'repair';
    case 'architecture_planning': return 'planning';
    case 'review': return 'review';
    case 'browser_automation': return 'browser_planning';
    case 'ios_build_or_sim': return 'ios_analysis';
    case 'code_implementation':
    case 'unknown':
    default: return 'implementation';
  }
}

function defaults(input: ExecutorRouteInput): Record<string, string | undefined> {
  const config = input.routingConfig;
  return {
    implementation: config?.defaultImplementationProvider,
    repair: config?.defaultRepairProvider,
    planning: config?.defaultPlanningProvider,
    review: config?.defaultReviewProvider,
    browser_planning: config?.defaultBrowserPlanningProvider,
    ios_analysis: config?.defaultIosAnalysisProvider,
  };
}

/** @deprecated Compatibility adapter. Route Policy is the sole routing authority. */
export function routeExecutor(input: ExecutorRouteInput): ExecutorRouteDecision {
  const routeDecision = decideRoute(input.routePolicyInput ?? {
    intent: {
      objective: input.goal.objective,
      scopeClear: true,
      mutation: input.risk !== 'readonly',
      taskIntent: input.taskIntent,
      preferredProviderId: input.userConstraints?.preferProvider,
      allowedProviderIds: input.goal.allowedExecutors,
      forbiddenProviderIds: [...input.goal.forbiddenExecutors, ...(input.userConstraints?.forbidProvider ?? [])],
      lastProviderId: input.goal.lastProviderId,
      lastFailureClass: input.goal.lastFailureClass,
      agentRequested: true,
    },
    workspace: {},
    policy: {
      risk: input.risk,
      policyBlocked: input.policyBlocked,
      requiresApproval: input.requiresApproval,
      approvalConfirmed: input.requiresApproval === false,
      remoteWrite: input.externalWrite,
    },
    capabilities: {
      requiresWorker: true,
      requiredProviderCapabilities: input.requiredCapabilities,
      providers: input.providers,
      routingOrders: input.routingConfig?.orders,
      defaultProviders: defaults(input),
    },
    recovery: { required: true },
  });
  const selectedProvider = routeDecision.selectedProviderId
    ? input.providers.find((provider) => provider.providerId === routeDecision.selectedProviderId)
    : undefined;
  return {
    selectedProviderId: routeDecision.selectedProviderId,
    ...(selectedProvider ? { selectedProvider } : {}),
    reason: routeDecision.reasons.map((reason) => reason.message).join(' '),
    directDispatch: Boolean(selectedProvider?.directDispatch && selectedProvider.kind !== 'handoff_only'),
    handoffOnly: routeDecision.executionMode === 'handoff_only' || routeDecision.executorKind === 'handoff_only',
    waitForUser: routeDecision.waitForUser,
    approvalState: routeDecision.approvalState,
    alternatives: routeDecision.alternatives,
    routeDecision,
  };
}

export function previewExecutorRoute(input: ExecutorRouteInput): ExecutorRouteDecision {
  return routeExecutor(input);
}

export function providerReadyForDirectDispatch(
  status: ProviderStatus,
  kind: ProviderDescriptor['kind'],
  directDispatch: boolean,
): boolean {
  return directDispatch && status === 'ready' && kind !== 'handoff_only';
}

export function validateRoutingOrder(order: string[], options: { allowHandoffOnlyAsLast?: boolean } = {}): {
  ok: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const direct = order.filter((id) => id !== 'chatgpt_handoff');
  if (direct.length === 0) warnings.push('Order contains only handoff-only providers; direct dispatch will not run.');
  if (order.includes('chatgpt_handoff') && order[0] === 'chatgpt_handoff' && options.allowHandoffOnlyAsLast !== true) {
    warnings.push('chatgpt_handoff is first; no direct provider will be tried before handoff.');
  }
  return { ok: true, warnings };
}
