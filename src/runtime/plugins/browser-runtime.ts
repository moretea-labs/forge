import { AssistantPluginError } from './errors';
import type { AssistantPluginActionExecutionInput } from './types';
import {
  validateBrowserTransaction,
  type BrowserActionReplaySafety,
  type BrowserForegroundRequirement,
  type BrowserProviderCapability,
  type BrowserTargetIdentity,
  type BrowserTransaction,
} from './browser-runtime-contract';
import {
  BrowserProviderRegistry,
  BrowserProviderUnavailableBeforeActionError,
  type BrowserRuntimeProvider,
} from './browser-provider-registry';

export const ALL_BROWSER_PROVIDER_CAPABILITIES = [
  'dom.read',
  'dom.interact',
  'browser.internal_resources',
  'browser.screenshot',
  'browser.trusted_input',
  'browser.foreground',
  'browser.transaction',
  'browser.persistent_handle',
] as const satisfies readonly BrowserProviderCapability[];

const READ_ACTIONS = new Set([
  'list_sessions', 'reconcile_sessions', 'get_handoff_status',
  'get_text', 'get_html', 'query_selector', 'query_all', 'get_attribute', 'list_frames', 'verify_state',
  'extract_links', 'extract_tables', 'extract_forms', 'snapshot_interactive', 'get_console_errors', 'get_failed_requests',
  'wait_for_load_state', 'wait_for_selector', 'await_file_transfer',
]);
const SCREENSHOT_ACTIONS = new Set(['screenshot']);
const TRUSTED_INPUT_ACTIONS = new Set(['trusted_input', 'activate_page']);
const DOM_INTERACTION_ACTIONS = new Set([
  'create_session', 'open_page', 'navigate', 'reload', 'go_back',
  'click', 'click_text', 'double_click', 'hover', 'focus', 'type', 'fill', 'select_option', 'check', 'uncheck',
  'press', 'keyboard_shortcut', 'dispatch_event', 'attach_local_file', 'close_page',
]);
const IDEMPOTENT_ACTIONS = new Set(['configure', 'close_session', 'clear_session', 'request_human_handoff', 'resolve_handoff']);

interface BrowserRuntimeActionPolicy {
  requiredCapabilities: readonly BrowserProviderCapability[];
  foreground: BrowserForegroundRequirement;
  replaySafety: BrowserActionReplaySafety;
}

const registries = new Map<string, BrowserProviderRegistry<AssistantPluginActionExecutionInput, Record<string, unknown>>>();

function registryFor(runtimeKey: string): BrowserProviderRegistry<AssistantPluginActionExecutionInput, Record<string, unknown>> {
  let registry = registries.get(runtimeKey);
  if (!registry) {
    registry = new BrowserProviderRegistry();
    registries.set(runtimeKey, registry);
  }
  return registry;
}

export function invalidateBrowserRuntime(runtimeKey: string, reason: string): void {
  registries.get(runtimeKey)?.invalidateAll(reason);
}

export function browserRuntimeActionPolicy(actionId: string): BrowserRuntimeActionPolicy {
  if (SCREENSHOT_ACTIONS.has(actionId)) {
    return { requiredCapabilities: ['browser.screenshot', 'browser.transaction'], foreground: 'none', replaySafety: 'read_only' };
  }
  if (TRUSTED_INPUT_ACTIONS.has(actionId)) {
    return {
      requiredCapabilities: ['browser.trusted_input', 'browser.foreground', 'browser.transaction'],
      foreground: 'explicit_required',
      replaySafety: 'non_idempotent',
    };
  }
  if (READ_ACTIONS.has(actionId)) {
    return { requiredCapabilities: ['dom.read', 'browser.transaction'], foreground: 'none', replaySafety: 'read_only' };
  }
  if (DOM_INTERACTION_ACTIONS.has(actionId)) {
    return { requiredCapabilities: ['dom.interact', 'browser.transaction'], foreground: 'none', replaySafety: 'non_idempotent' };
  }
  return {
    requiredCapabilities: ['browser.transaction'],
    foreground: 'none',
    replaySafety: IDEMPOTENT_ACTIONS.has(actionId) ? 'idempotent' : 'non_idempotent',
  };
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stableTargetFor(input: AssistantPluginActionExecutionInput, providerId: string): BrowserTargetIdentity {
  const sessionId = stringArgument(input.args, 'session_id');
  const nativeProduct = stringArgument(input.args, 'native_browser_product');
  const nativeWindowId = stringArgument(input.args, 'native_window_id');
  const nativeTabId = stringArgument(input.args, 'native_tab_id');
  if (nativeWindowId && nativeTabId) {
    return {
      providerId,
      resourceKind: 'tab',
      resourceId: `window:${nativeWindowId}/tab:${nativeTabId}`,
      ...(nativeProduct ? { browserProduct: nativeProduct } : {}),
      ownership: 'user_owned',
    };
  }
  if (sessionId) {
    return {
      providerId,
      resourceKind: 'page',
      resourceId: `session:${sessionId}`,
      ownership: 'provider_owned',
    };
  }
  return {
    providerId,
    resourceKind: 'page',
    resourceId: `request:${input.requestId}:${input.actionId}`,
    ownership: 'plugin_owned',
  };
}

function transactionFor(
  input: AssistantPluginActionExecutionInput,
  providerId: string,
  policy: BrowserRuntimeActionPolicy,
): BrowserTransaction {
  return {
    transactionId: input.requestId,
    target: stableTargetFor(input, providerId),
    requiredCapabilities: policy.requiredCapabilities,
    foreground: policy.foreground,
    replaySafety: policy.replaySafety,
    action: {
      kind: policy.replaySafety === 'read_only' ? 'read' : policy.foreground === 'explicit_required' ? 'trusted_input' : 'dom',
      operation: input.actionId,
      arguments: input.args,
    },
    ...(policy.replaySafety === 'read_only'
      ? {}
      : { postconditions: [{ kind: 'provider_assertion', assertion: 'semantic_action_result', expected: true }] as const }),
    timeoutMs: typeof input.args.timeout_ms === 'number' && Number.isFinite(input.args.timeout_ms)
      ? Math.max(1, Math.trunc(input.args.timeout_ms))
      : 60_000,
  };
}

export async function executeBrowserRuntimeAction(options: {
  runtimeKey: string;
  input: AssistantPluginActionExecutionInput;
  providers: readonly BrowserRuntimeProvider<AssistantPluginActionExecutionInput, Record<string, unknown>>[];
}): Promise<Record<string, unknown>> {
  const registry = registryFor(options.runtimeKey);
  for (const provider of options.providers) registry.register(provider);

  const policy = browserRuntimeActionPolicy(options.input.actionId);
  const excluded = new Set<string>();
  while (true) {
    const selection = await registry.select({
      input: options.input,
      requiredCapabilities: policy.requiredCapabilities,
      foreground: policy.foreground,
      excludedProviderIds: excluded,
    });
    const transaction = transactionFor(options.input, selection.provider.providerId, policy);
    const validationErrors = validateBrowserTransaction(transaction);
    if (validationErrors.length > 0) {
      throw new AssistantPluginError('PLUGIN_BROWSER_TRANSACTION_INVALID', validationErrors[0]!, {
        retryable: false,
        details: { transactionId: transaction.transactionId, errors: validationErrors },
      });
    }

    try {
      return await selection.provider.execute(options.input);
    } catch (error) {
      if (!(error instanceof BrowserProviderUnavailableBeforeActionError)) throw error;
      excluded.add(selection.provider.providerId);
      // This is provider reselection, not action replay: the typed error proves the rejected provider
      // never attempted the action. Unknown outcomes from non-idempotent actions always propagate.
    }
  }
}
