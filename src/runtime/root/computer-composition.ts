import {
  ComputerProviderError,
  ComputerProviderRegistry,
  computerProviderRegistrationSnapshot,
} from '../../../packages/plugin-runtime/computer/index';
import { randomUUID } from 'crypto';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
  COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  type ComputerBrowserAutomationRequest,
  type ComputerBrowserProduct,
  type ComputerConsoleUnlockCommandRequest,
  type ComputerConsoleUnlockProviderRequest,
  type ComputerRuntimeExecutionRequest,
  type ComputerRuntimeProviderExecutionRequest,
} from '../../../packages/protocols/computer/index';
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from '../../../adapters/computer/desktop-operator-contract';
import { createDesktopOperatorComputerProvider, type DesktopOperatorComputerProvider } from '../../../adapters/computer/index';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { currentComputerPlatform } from '../platform/computer-platform';
import { getExternalPluginAdapter } from '../plugins/external-adapter';
import { getExternalPluginRegistration } from '../plugins/external-registration';
import { AssistantPluginError } from '../plugins/errors';
import type { AssistantPluginActionExecutionInput } from '../plugins/types';

let computerProviders: ComputerProviderRegistry | undefined;
let computerProviderCompositionKey: string | undefined;
let desktopOperatorProvider: DesktopOperatorComputerProvider | undefined;
const NATIVE_BROWSER_BUNDLE_IDS: Record<ComputerBrowserProduct, string> = {
  chrome: 'com.google.Chrome',
  vivaldi: 'com.vivaldi.Vivaldi',
};
function currentDesktopOperatorRegistration(controllerHome: string) {
  return getExternalPluginRegistration(controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
}

function computerCompositionKey(controllerHome: string): string {
  const registration = currentDesktopOperatorRegistration(controllerHome);
  const fingerprint = registration
    ? `${registration.revision}:${registration.registrationFingerprint}:${registration.enabled ? 'enabled' : 'disabled'}`
    : 'desktop_operator:unregistered';
  return `${controllerHome}:${currentComputerPlatform()}:${fingerprint}`;
}

function ensureComputerComposition(controllerHome: string = resolveControllerHome()): ComputerProviderRegistry {
  const compositionKey = computerCompositionKey(controllerHome);
  if (computerProviders && computerProviderCompositionKey === compositionKey) return computerProviders;

  computerProviders?.dispose();
  const next = new ComputerProviderRegistry();
  if (currentComputerPlatform() === 'darwin') {
    const registration = currentDesktopOperatorRegistration(controllerHome);
    desktopOperatorProvider = createDesktopOperatorComputerProvider({
      lookupRegistration: (providerPluginId) => {
        if (providerPluginId !== DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID || !registration) return undefined;
        return computerProviderRegistrationSnapshot(registration);
      },
    });
    next.register(desktopOperatorProvider);
  }
  computerProviders = next;
  computerProviderCompositionKey = compositionKey;
  return next;
}

async function executeComputerProviderRequest(
  request: ComputerRuntimeProviderExecutionRequest,
  timeoutMs: number,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  const providers = ensureComputerComposition(controllerHome);
  try {
    return await providers.execute(request, timeoutMs);
  } catch (error) {
    if (error instanceof ComputerProviderError) {
      throw new AssistantPluginError(error.code, error.detailMessage, {
        retryable: error.retryable,
        effectOutcome: error.effectOutcome,
        details: error.details,
      });
    }
    throw error;
  }
}

export async function executeRuntimeComputer(
  request: ComputerRuntimeExecutionRequest,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  return await executeComputerProviderRequest(request, timeoutMs, controllerHome);
}

export interface RuntimeComputerConsoleUnlockAuthorization {
  kind: 'explicit_single_use';
  confirmed: true;
  invocationId: string;
}

/**
 * Protected Computer path. The caller must obtain explicit authorization for either
 * provider-local credential preparation or one handle-bound unlock attempt. Raw console
 * credential material never enters Runtime, generic Plugin actions, Jobs, or receipts.
 */
export async function executeRuntimeComputerConsoleUnlock(
  request: ComputerConsoleUnlockCommandRequest,
  authorization: RuntimeComputerConsoleUnlockAuthorization,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  if (request.capability !== COMPUTER_CONSOLE_UNLOCK_CAPABILITY
    || !['prepare_unlock_console', 'unlock_console', 'console_unlock_enroll', 'console_unlock_status', 'console_unlock_recover', 'console_unlock_revoke'].includes(request.action)) {
    throw new AssistantPluginError('COMPUTER_CONSOLE_UNLOCK_REQUEST_INVALID', 'Protected console unlock accepts only declared computer.console.unlock.v1 temporary or unattended-recovery commands.', { retryable: false });
  }
  if (authorization.kind !== 'explicit_single_use'
    || authorization.confirmed !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authorization.invocationId)) {
    throw new AssistantPluginError('COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED', 'Protected console unlock requires one explicit single-use authorization bound to this invocation.', { retryable: false });
  }
  if (request.action === 'unlock_console'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.credentialHandle)) {
    throw new AssistantPluginError('COMPUTER_CONSOLE_UNLOCK_CREDENTIAL_HANDLE_REQUIRED', 'Protected console unlock requires one provider-local opaque credential handle.', { retryable: false });
  }
  const providerRequest: ComputerConsoleUnlockProviderRequest = { ...request, authorization };
  return await executeComputerProviderRequest(providerRequest, timeoutMs, controllerHome);
}

export async function executeRuntimeComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  ensureComputerComposition(controllerHome);
  if (!desktopOperatorProvider) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_COMPATIBILITY_PROVIDER_UNAVAILABLE',
      'Native Browser compatibility requires the macOS Desktop Operator provider.',
      { retryable: true, details: { providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  return await desktopOperatorProvider.executeBrowserCompatibility(request, timeoutMs);
}

type BrowserTrustedInputSemanticProof = {
  domRole: string;
  accessibleName: string;
  editable: true;
  focused: true;
  multiline: boolean;
};
type BrowserTrustedInputRequest = Extract<ComputerBrowserAutomationRequest, { action: 'trusted_input' }> & {
  semanticTarget?: BrowserTrustedInputSemanticProof;
};
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringValue(record: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
function browserTrustedInputAction(
  controllerHome: string,
  actionId: string,
  args: Record<string, unknown>,
  requestId: string,
  timeoutMs: number,
): AssistantPluginActionExecutionInput {
  return {
    controllerHome,
    repoId: '__controller__',
    repoRoot: controllerHome,
    pluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    actionId,
    requestId,
    args,
    origin: { surface: 'system', actor: 'native-browser-trusted-input' },
    timeoutMs,
  };
}

/**
 * Trusted text/key input is a Unified Computer concern, not Browser compatibility.
 * Browser owns the exact tab and DOM identity; the Desktop Operator interaction is
 * a short-lived transport binding used only after that exact tab is already
 * foreground. No provider session is promoted into a second semantic authority.
 */
export async function executeRuntimeComputerBrowserTrustedInput(
  request: BrowserTrustedInputRequest,
  timeoutMs: number,
  controllerHome: string = resolveControllerHome(),
): Promise<Record<string, unknown>> {
  if (request.input.kind !== 'text' && request.input.kind !== 'key') {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_UNIFIED_INPUT_KIND_UNSUPPORTED',
      `Unified native Browser input handles text/key only, not ${request.input.kind}.`,
      { retryable: false, details: { browserProduct: request.product, inputKind: request.input.kind } },
    );
  }
  if (currentComputerPlatform() !== 'darwin') {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_TRUSTED_INPUT_UNSUPPORTED_PLATFORM',
      `Native Browser trusted input is unavailable on ${currentComputerPlatform()}.`,
      { retryable: false, details: { browserProduct: request.product } },
    );
  }
  const expectedBundleId = NATIVE_BROWSER_BUNDLE_IDS[request.product];
  const desktopOperator = getExternalPluginAdapter(controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  if (!desktopOperator) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_TRUSTED_INPUT_UNAVAILABLE',
      'Native Browser trusted input requires the Unified Computer provider.',
      { retryable: true, details: { browserProduct: request.product, providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  const invocationId = randomUUID();
  let interactionId = '';
  let effectCompleted = false;
  try {
    const opened = await desktopOperator.executeAction(browserTrustedInputAction(
      controllerHome,
      'desktop_session_open',
      { bundle_id: expectedBundleId, launch: false, activate: false },
      `native-browser-trusted-input:${invocationId}:open`,
      timeoutMs,
    ));
    interactionId = stringValue(opened, 'interactionId', 'interaction_id');
    const observedBundleId = stringValue(opened, 'bundleIdentifier', 'bundle_id');
    if (!interactionId || observedBundleId !== expectedBundleId) {
      throw new AssistantPluginError(
        observedBundleId ? 'PLUGIN_BROWSER_TRUSTED_INPUT_IDENTITY_MISMATCH' : 'PLUGIN_BROWSER_TRUSTED_INPUT_IDENTITY_UNVERIFIED',
        'Unified Computer did not bind the exact requested native browser application.',
        { retryable: false, details: { browserProduct: request.product, expectedBundleId, observedBundleId: observedBundleId || undefined } },
      );
    }

    if (request.input.kind === 'text') {
      if (request.input.text.length > 10_000) {
        throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'Trusted Browser text input must be at most 10000 characters.', { retryable: false });
      }
      const proof = request.semanticTarget;
      if (!proof || proof.editable !== true || proof.focused !== true || !proof.accessibleName.trim() || !proof.domRole.trim()) {
        throw new AssistantPluginError(
          'PLUGIN_BROWSER_TRUSTED_INPUT_SEMANTIC_TARGET_REQUIRED',
          'Unified Computer text input requires exact Browser-owned DOM semantic target proof.',
          { retryable: false, details: { browserProduct: request.product } },
        );
      }
      const expectedAxRole = proof.domRole === 'textbox'
        ? (proof.multiline ? 'AXTextArea' : 'AXTextField')
        : proof.domRole;
      const observed = await executeRuntimeComputer({
        capability: COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
        action: 'observe_elements',
        interactionId,
        maxDepth: 2,
        maxNodes: 16,
        includeValues: true,
        rootSelector: { role: expectedAxRole },
      }, timeoutMs, controllerHome);
      const root = objectValue(observed.root);
      const target = objectValue(root?.target);
      const ref = stringValue(root, 'ref');
      const targetInteractionId = stringValue(target, 'interactionId');
      const targetBundleId = stringValue(target, 'bundleIdentifier');
      const axAccessibleNames = [stringValue(root, 'description'), stringValue(root, 'name')].filter(Boolean);
      const semanticIdentityMatches = axAccessibleNames.includes(proof.accessibleName.trim());
      if (stringValue(root, 'role') !== expectedAxRole
        || !semanticIdentityMatches
        || !ref
        || targetInteractionId !== interactionId
        || targetBundleId !== expectedBundleId
        || typeof target?.pid !== 'number'
        || !Number.isInteger(target.pid)
        || typeof target?.appName !== 'string'
        || typeof target?.snapshotRevision !== 'number'
        || !Number.isInteger(target.snapshotRevision)) {
        throw new AssistantPluginError(
          'PLUGIN_BROWSER_TRUSTED_INPUT_SEMANTIC_TARGET_MISMATCH',
          'Unified Computer element identity no longer matches the Browser-owned active DOM target.',
          { retryable: true, details: { browserProduct: request.product, interactionId, expectedAxRole, accessibleName: proof.accessibleName, observedRole: root?.role, observedNames: axAccessibleNames, ref: ref || undefined } },
        );
      }
      // AX set_value can report success for Chromium contenteditable controls while
      // React immediately restores the DOM value. Keep element.observe.v2 as the
      // exact identity fence, then perform the actual text mutation through the
      // Unified Computer input capability bound to that exact observed AX ref.
      await executeRuntimeComputer({
        capability: COMPUTER_INPUT_CAPABILITY,
        action: 'type_text',
        interactionId: targetInteractionId,
        selector: { ref },
        text: request.input.text,
        replace: true,
      }, timeoutMs, controllerHome);
    } else {
      await desktopOperator.executeAction(browserTrustedInputAction(
        controllerHome,
        'desktop_key',
        { interaction_id: interactionId, keys: [request.input.key] },
        `native-browser-trusted-input:${invocationId}:key`,
        timeoutMs,
      ));
    }
    effectCompleted = true;
    return { performed: true, transport: 'computer', inputKind: request.input.kind };
  } finally {
    if (interactionId) {
      try {
        await desktopOperator.executeAction(browserTrustedInputAction(
          controllerHome,
          'desktop_session_close',
          { interaction_id: interactionId },
          `native-browser-trusted-input:${invocationId}:close`,
          timeoutMs,
        ));
      } catch (error) {
        // Provider-session cleanup is transport hygiene, never external-effect
        // outcome authority. In particular, do not convert a confirmed text/key
        // mutation into a replayable failure because session retirement failed.
        process.stderr.write(`[computer-browser-trusted-input] cleanup_failed effect_completed=${effectCompleted} ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}

export async function activateRuntimeComputerBrowserApplication(
  input: AssistantPluginActionExecutionInput,
  product: ComputerBrowserProduct,
): Promise<void> {
  const platform = currentComputerPlatform();
  if (platform !== 'darwin') {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNSUPPORTED_PLATFORM',
      `Native browser foreground activation is unavailable on ${platform} until a platform Computer provider is registered.`,
      { retryable: false, details: { browserProduct: product, platform } },
    );
  }
  const desktopOperator = getExternalPluginAdapter(input.controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  if (!desktopOperator) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
      'Native browser foreground activation requires an available Computer application provider.',
      { retryable: true, details: { browserProduct: product, providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  await desktopOperator.executeAction({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    pluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    actionId: 'desktop_session_open',
    requestId: `${input.requestId}:native-browser-foreground:${product}`,
    args: { bundle_id: NATIVE_BROWSER_BUNDLE_IDS[product], launch: false, activate: true },
    origin: input.origin,
    jobId: input.jobId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
  });
}

export function runtimeComputerProviderSnapshot(controllerHome: string = resolveControllerHome()): Array<{ providerId: string; capabilities: string[] }> {
  return ensureComputerComposition(controllerHome).snapshot();
}

export function disposeRuntimeComputerComposition(): void {
  computerProviders?.dispose();
  computerProviders = undefined;
  computerProviderCompositionKey = undefined;
  desktopOperatorProvider = undefined;
}
