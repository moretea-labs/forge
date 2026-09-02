import { createHash } from 'crypto';
import { AssistantPluginError } from './errors';
import type { ExternalPluginRegistration } from './external-registration';
import type { DesktopApplicationIdentity, VerifiedDesktopApplicationActivation } from './local-system-adapter';
import type { AssistantPluginActionExecutionInput, AssistantPluginAuthorizationContext } from './types';

export interface DesktopOperatorExternalPolicyContext {
  callProvider(
    requestId: string,
    actionId: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  verifyProviderIdentity(requestId: string, signal?: AbortSignal): Promise<void>;
  activateAndVerifyFrontmostApplication(identity: DesktopApplicationIdentity): Promise<VerifiedDesktopApplicationActivation>;
}

export interface DesktopOperatorPolicyExecutionResult {
  handled: boolean;
  result?: Record<string, unknown>;
}

function providerError(code: string, message: string, retryable = false): AssistantPluginError {
  return new AssistantPluginError(code, message, { retryable });
}

export function desktopOperatorAllowsMissingProviderAction(actionId: string): boolean {
  return actionId === 'desktop_pointer_click' || actionId === 'desktop_foreground_pointer_click';
}

function externalProviderAuthorizationContext(registration: ExternalPluginRegistration): AssistantPluginAuthorizationContext {
  return {
    target: {
      kind: 'external-provider',
      id: registration.pluginId,
      identityFingerprint: registration.registrationFingerprint,
    },
    expiresInMinutes: 30 * 24 * 60,
  };
}

function desktopApplicationAuthorizationContext(
  registration: ExternalPluginRegistration,
  stableApplicationId: string,
): AssistantPluginAuthorizationContext {
  const normalized = stableApplicationId.trim();
  return {
    target: {
      kind: 'desktop-application',
      id: normalized,
      identityFingerprint: createHash('sha256')
        .update(`${registration.registrationFingerprint}\0${normalized}`)
        .digest('hex'),
    },
    expiresInMinutes: 30 * 24 * 60,
  };
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function desktopSession(status: Record<string, unknown>, interactionId: string): Record<string, unknown> | undefined {
  return recordArray(status.sessions).find((session) => firstString(session, 'interactionId', 'interaction_id') === interactionId);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactFocusedDesktopWindowId(observation: Record<string, unknown>): number | undefined {
  const snapshot = recordValue(observation.snapshot);
  const root = recordValue(snapshot?.root);
  const focusedAxWindows = recordArray(root?.children).filter((window) =>
    firstString(window, 'role') === 'AXWindow' && window.focused === true);
  if (focusedAxWindows.length !== 1) return undefined;

  const focusedTitle = firstString(focusedAxWindows[0]!, 'title');
  if (!focusedTitle) return undefined;
  const matches = recordArray(observation.windows).filter((window) => {
    const windowId = firstNumber(window, 'windowId', 'window_id');
    return Boolean(windowId)
      && Number.isInteger(windowId)
      && window.onScreen === true
      && firstString(window, 'title') === focusedTitle;
  });
  if (matches.length !== 1) return undefined;
  return firstNumber(matches[0]!, 'windowId', 'window_id');
}

function desktopSessionApplicationIsActive(status: Record<string, unknown>, session: Record<string, unknown>): boolean {
  const pid = firstNumber(session, 'pid');
  const bundleId = firstString(session, 'bundleIdentifier', 'bundle_id');
  const appName = firstString(session, 'appName', 'app_name');
  return recordArray(status.applications).some((application) => {
    if (application.active !== true || application.terminated === true) return false;
    if (pid !== undefined) return firstNumber(application, 'pid') === pid;
    if (bundleId) return firstString(application, 'bundle_id', 'bundleIdentifier') === bundleId;
    return Boolean(appName) && firstString(application, 'name', 'appName') === appName;
  });
}

async function observeExactDesktopWindow(
  requestId: string,
  interactionId: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  context: DesktopOperatorExternalPolicyContext,
): Promise<number> {
  const observation = await context.callProvider(
    requestId,
    'desktop_observe',
    {
      interaction_id: interactionId,
      max_depth: 3,
      max_nodes: 500,
      include_values: false,
      include_actions: false,
      include_windows: true,
    },
    timeoutMs,
    signal,
  );
  const windowId = exactFocusedDesktopWindowId(observation);
  if (!windowId) {
    throw providerError(
      'DESKTOP_EXACT_WINDOW_UNAVAILABLE',
      `Desktop session ${interactionId} does not expose one uniquely focused AX window that maps to one on-screen CGWindow.`,
      true,
    );
  }
  return windowId;
}

async function verifyExactForegroundDesktopSession(
  requestId: string,
  interactionId: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  context: DesktopOperatorExternalPolicyContext,
): Promise<number> {
  const sourceStatus = await context.callProvider(
    `${requestId}:source-status`,
    'desktop_status',
    { limit: 500 },
    timeoutMs,
    signal,
  );
  const sourceSession = desktopSession(sourceStatus, interactionId);
  if (!sourceSession) {
    throw providerError('DESKTOP_EXACT_WINDOW_SESSION_NOT_FOUND', `Desktop session ${interactionId} is no longer available.`, true);
  }
  const expectedWindowId = await observeExactDesktopWindow(
    `${requestId}:source-window`,
    interactionId,
    timeoutMs,
    signal,
    context,
  );
  const foregroundStatus = await context.callProvider(
    `${requestId}:foreground-status`,
    'desktop_status',
    { limit: 500 },
    timeoutMs,
    signal,
  );
  const foregroundSession = desktopSession(foregroundStatus, interactionId);
  if (!foregroundSession || !desktopSessionApplicationIsActive(foregroundStatus, foregroundSession)) {
    throw providerError(
      'DESKTOP_EXACT_WINDOW_FOREGROUND_REQUIRED',
      `Desktop session ${interactionId} is not the system-frontmost application; Forge will not reactivate the bundle because that can steal focus from another window.`,
      true,
    );
  }
  let confirmedWindowId: number;
  try {
    confirmedWindowId = await observeExactDesktopWindow(
      `${requestId}:confirmed-window`,
      interactionId,
      timeoutMs,
      signal,
      context,
    );
  } catch (error) {
    if (error instanceof AssistantPluginError && error.code === 'DESKTOP_EXACT_WINDOW_UNAVAILABLE') {
      throw new AssistantPluginError(
        'DESKTOP_EXACT_WINDOW_FOCUS_CHANGED',
        `Desktop session ${interactionId} no longer exposes the previously verified exact focused window.`,
        { retryable: true, details: { expectedWindowId } },
      );
    }
    throw error;
  }
  if (confirmedWindowId !== expectedWindowId) {
    throw new AssistantPluginError(
      'DESKTOP_EXACT_WINDOW_FOCUS_CHANGED',
      `Desktop session ${interactionId} changed focused windows while Forge was verifying exact foreground authority.`,
      { retryable: true, details: { expectedWindowId, observedWindowId: confirmedWindowId } },
    );
  }
  return expectedWindowId;
}

function normalizeDesktopKeys(keys: unknown[]): unknown[] {
  return keys.map((key) => typeof key === 'string' && ['enter', 'return'].includes(key.trim().toLowerCase()) ? 'return' : key);
}

function normalizeDesktopBatchArguments(args: Record<string, unknown>): { args: Record<string, unknown>; foregroundInteractionId?: string } {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  const foregroundInteractionIds = new Set<string>();
  const stepActions: string[] = [];
  const keyStepIndexes: number[] = [];
  let hasExplicitActivation = false;
  const steps = rawSteps.map((value, index) => {
    const step = recordValue(value);
    if (!step) return value;
    const action = firstString(step, 'action');
    stepActions.push(action);
    const argumentsValue = recordValue(step.arguments) ?? {};
    if (action === 'desktop_session_open' && argumentsValue.activate === true) hasExplicitActivation = true;
    if (['desktop_key', 'desktop_paste', 'desktop_copy'].includes(action)) {
      const interactionId = firstString(argumentsValue, 'interaction_id');
      if (interactionId) foregroundInteractionIds.add(interactionId);
    }
    if (action === 'desktop_key') {
      keyStepIndexes.push(index);
      if (Array.isArray(argumentsValue.keys)) {
        return { ...step, arguments: { ...argumentsValue, keys: normalizeDesktopKeys(argumentsValue.keys) } };
      }
    }
    return value;
  });
  if (foregroundInteractionIds.size > 1) {
    throw providerError(
      'DESKTOP_BATCH_EXACT_WINDOW_AMBIGUOUS',
      'desktop_batch cannot safely target multiple foreground desktop sessions because one exact window can own keyboard focus at a time.',
    );
  }
  if (foregroundInteractionIds.size === 1 && hasExplicitActivation) {
    throw providerError(
      'DESKTOP_BATCH_EXACT_WINDOW_ACTIVATION_CONFLICT',
      'desktop_batch cannot mix explicit application activation with key/copy/paste input because activation can move focus to another window in the same bundle.',
    );
  }
  if (foregroundInteractionIds.size === 1) {
    const exactWindowSafeActions = new Set([
      'desktop_clipboard_read', 'desktop_clipboard_write', 'desktop_copy', 'desktop_paste', 'desktop_key', 'desktop_observe',
    ]);
    const unsafeAction = stepActions.find((action) => !exactWindowSafeActions.has(action));
    if (unsafeAction) {
      throw providerError(
        'DESKTOP_BATCH_EXACT_WINDOW_FOCUS_MUTATION_CONFLICT',
        `desktop_batch cannot mix ${unsafeAction} with exact-window key/copy/paste input because that step can invalidate foreground window authority after verification.`,
      );
    }
    if (keyStepIndexes.length > 1) {
      throw providerError(
        'DESKTOP_BATCH_EXACT_WINDOW_MULTIPLE_KEY_STEPS',
        'desktop_batch allows at most one desktop_key step when exact-window authority is required; a synthetic key can itself change focused windows.',
      );
    }
    const keyIndex = keyStepIndexes[0];
    if (keyIndex !== undefined) {
      const laterForegroundInput = rawSteps.slice(keyIndex + 1).some((value) => {
        const action = firstString(recordValue(value) ?? {}, 'action');
        return ['desktop_key', 'desktop_paste', 'desktop_copy'].includes(action);
      });
      if (laterForegroundInput) {
        throw providerError(
          'DESKTOP_BATCH_EXACT_WINDOW_INPUT_AFTER_KEY',
          'desktop_batch cannot send key/copy/paste input after desktop_key because the key may have changed the focused window.',
        );
      }
    }
  }
  return { args: { ...args, steps }, foregroundInteractionId: [...foregroundInteractionIds][0] };
}

async function independentlyEnsureExactFrontmostDesktopApplication(
  bundleId: string,
  appName: string,
  context: DesktopOperatorExternalPolicyContext,
): Promise<void> {
  const proof = await context.activateAndVerifyFrontmostApplication({ bundleId: bundleId || undefined, appName: appName || undefined });
  const proofBundleId = typeof proof.bundleId === 'string' ? proof.bundleId.trim() : '';
  const proofAppName = typeof proof.appName === 'string' ? proof.appName.trim() : '';
  const proofMatches = bundleId ? proofBundleId === bundleId : proofAppName === appName;
  if (proof.activated !== true || proof.verified !== true || !proofMatches) {
    throw new AssistantPluginError(
      'DESKTOP_ACTIVATION_FALLBACK_IDENTITY_MISMATCH',
      `Forge did not prove the exact requested application ${bundleId || appName} as frontmost.`,
      { retryable: true, details: { target: { bundleId, appName }, observed: { bundleId: proofBundleId, appName: proofAppName } } },
    );
  }
}

async function openVerifiedDesktopSession(
  requestId: string,
  args: Record<string, unknown>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  context: DesktopOperatorExternalPolicyContext,
): Promise<Record<string, unknown>> {
  const bundleId = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
  const appName = typeof args.app_name === 'string' ? args.app_name.trim() : '';
  if (!bundleId && !appName) {
    throw providerError('DESKTOP_ACTIVATION_TARGET_UNAVAILABLE', 'Activated desktop sessions require an exact bundle id or application name.');
  }

  let result: Record<string, unknown>;
  let providerActivationError: AssistantPluginError | undefined;
  try {
    result = await context.callProvider(requestId, 'desktop_session_open', args, timeoutMs, signal);
  } catch (error) {
    if (!(error instanceof AssistantPluginError) || error.code !== 'APP_ACTIVATION_FAILED') throw error;
    providerActivationError = error;
    result = await context.callProvider(
      `${requestId}:fallback-session`,
      'desktop_session_open',
      { ...(bundleId ? { bundle_id: bundleId } : { app_name: appName }), launch: false, activate: false },
      timeoutMs,
      signal,
    );
  }

  try {
    await independentlyEnsureExactFrontmostDesktopApplication(bundleId, appName, context);
  } catch (verificationError) {
    const wrappedCode = providerActivationError ? 'DESKTOP_ACTIVATION_FALLBACK_FAILED' : 'DESKTOP_ACTIVATION_NOT_CONFIRMED';
    const wrappedMessage = providerActivationError
      ? `Desktop Operator activation failed and Forge could not independently verify ${bundleId || appName} as frontmost.`
      : `Desktop Operator returned an activated session, but Forge could not independently verify ${bundleId || appName} as frontmost.`;
    if (verificationError instanceof AssistantPluginError) {
      throw new AssistantPluginError(wrappedCode, wrappedMessage, {
        retryable: verificationError.retryable,
        details: {
          ...(providerActivationError ? { providerErrorCode: providerActivationError.code } : {}),
          verificationErrorCode: verificationError.code,
          verificationErrorMessage: verificationError.message,
          target: bundleId || appName,
        },
      });
    }
    throw new AssistantPluginError(wrappedCode, wrappedMessage, {
      retryable: true,
      details: {
        ...(providerActivationError ? { providerErrorCode: providerActivationError.code } : {}),
        verificationErrorMessage: String(verificationError),
        target: bundleId || appName,
      },
    });
  }

  return result;
}

export async function resolveDesktopOperatorAuthorizationContext(
  registration: ExternalPluginRegistration,
  input: AssistantPluginActionExecutionInput,
  context: DesktopOperatorExternalPolicyContext,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (input.actionId === 'desktop_permissions_request') {
    return externalProviderAuthorizationContext(registration);
  }
  if (input.actionId === 'desktop_session_open') {
    const bundleId = typeof input.args.bundle_id === 'string' ? input.args.bundle_id.trim() : '';
    return bundleId ? desktopApplicationAuthorizationContext(registration, bundleId) : undefined;
  }

  const interactionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
  if (!interactionId) return undefined;

  await context.verifyProviderIdentity(`${input.requestId}:authorization-target:manifest`, input.signal);
  const status = await context.callProvider(
    `${input.requestId}:authorization-target:desktop-status`,
    'desktop_status',
    { limit: 500 },
    input.timeoutMs,
    input.signal,
  );
  const session = desktopSession(status, interactionId);
  if (!session) {
    throw providerError('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE', `Desktop session ${interactionId} was not found while resolving its stable authorization target.`, false);
  }
  const bundleId = firstString(session, 'bundleIdentifier', 'bundle_identifier');
  const appName = firstString(session, 'appName', 'app_name');
  const stableApplicationId = bundleId || (appName ? `name:${appName.toLowerCase()}` : '');
  if (!stableApplicationId) {
    throw providerError('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE', `Desktop session ${interactionId} has no stable application identity.`, false);
  }
  return desktopApplicationAuthorizationContext(registration, stableApplicationId);
}

export async function executeDesktopOperatorPolicyAction(
  input: AssistantPluginActionExecutionInput,
  context: DesktopOperatorExternalPolicyContext,
): Promise<DesktopOperatorPolicyExecutionResult> {
  if (input.actionId === 'desktop_foreground_pointer_click') {
    const sourceInteractionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
    const requestedWindowId = typeof input.args.window_id === 'number' && Number.isInteger(input.args.window_id) ? input.args.window_id : undefined;
    const x = typeof input.args.x === 'number' && Number.isFinite(input.args.x) ? input.args.x : undefined;
    const y = typeof input.args.y === 'number' && Number.isFinite(input.args.y) ? input.args.y : undefined;
    if (!sourceInteractionId || !requestedWindowId || x === undefined || y === undefined) {
      throw providerError('DESKTOP_FOREGROUND_POINTER_ARGUMENT_INVALID', 'desktop_foreground_pointer_click requires interaction_id, window_id, x, and y.');
    }

    const sourceStatus = await context.callProvider(`${input.requestId}:source-status`, 'desktop_status', { limit: 500 }, input.timeoutMs, input.signal);
    const sourceSession = desktopSession(sourceStatus, sourceInteractionId);
    if (!sourceSession) {
      throw providerError('DESKTOP_FOREGROUND_POINTER_SESSION_NOT_FOUND', `Desktop session ${sourceInteractionId} is no longer available.`, true);
    }
    const bundleId = firstString(sourceSession, 'bundleIdentifier', 'bundle_id');
    const appName = firstString(sourceSession, 'appName', 'app_name');
    if (!bundleId && !appName) {
      throw providerError('DESKTOP_FOREGROUND_POINTER_TARGET_UNAVAILABLE', `Desktop session ${sourceInteractionId} has no stable application identity.`);
    }

    const activation = await openVerifiedDesktopSession(
      `${input.requestId}:activate`,
      { ...(bundleId ? { bundle_id: bundleId } : { app_name: appName }), launch: false, activate: true },
      input.timeoutMs,
      input.signal,
      context,
    );
    const activationInteractionId = firstString(activation, 'interactionId', 'interaction_id');
    if (!activationInteractionId) {
      throw providerError('DESKTOP_ACTIVATION_SESSION_MISSING', 'Desktop Operator activated the application without returning a bound interaction session.', true);
    }

    const screenshot = await context.callProvider(
      `${input.requestId}:screenshot`,
      'desktop_screenshot',
      {
        interaction_id: activationInteractionId,
        scope: 'window',
        window_id: requestedWindowId,
        ...(typeof input.args.label === 'string' && input.args.label.trim() ? { label: input.args.label.trim() } : {}),
      },
      input.timeoutMs,
      input.signal,
    );
    const visualRevision = firstNumber(screenshot, 'visual_revision', 'visualRevision');
    const capturedWindowId = firstNumber(screenshot, 'windowId', 'window_id') ?? requestedWindowId;
    if (!visualRevision || !capturedWindowId) {
      throw providerError('DESKTOP_FOREGROUND_CAPTURE_INVALID', 'Desktop Operator did not return a fresh visual revision for the foreground window.', true);
    }

    const click = await context.callProvider(
      `${input.requestId}:click`,
      'desktop_pointer_click',
      {
        interaction_id: activationInteractionId,
        window_id: capturedWindowId,
        visual_revision: visualRevision,
        x,
        y,
      },
      input.timeoutMs,
      input.signal,
    );
    return {
      handled: true,
      result: {
        interactionId: activationInteractionId,
        activationVerified: true,
        windowId: capturedWindowId,
        visualRevision,
        screenshot,
        click,
      },
    };
  }

  if (input.actionId === 'desktop_key') {
    const sourceInteractionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
    const keys = Array.isArray(input.args.keys) ? input.args.keys : [];
    if (!sourceInteractionId || keys.length === 0) {
      throw providerError('DESKTOP_FOREGROUND_KEY_ARGUMENT_INVALID', 'desktop_key requires interaction_id and at least one key.');
    }
    await verifyExactForegroundDesktopSession(input.requestId, sourceInteractionId, input.timeoutMs, input.signal, context);
    return {
      handled: true,
      result: await context.callProvider(`${input.requestId}:key`, 'desktop_key', { interaction_id: sourceInteractionId, keys: normalizeDesktopKeys(keys) }, input.timeoutMs, input.signal),
    };
  }

  if (input.actionId === 'desktop_paste') {
    const sourceInteractionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
    if (!sourceInteractionId) {
      throw providerError('DESKTOP_FOREGROUND_PASTE_ARGUMENT_INVALID', 'desktop_paste requires interaction_id.');
    }
    await verifyExactForegroundDesktopSession(input.requestId, sourceInteractionId, input.timeoutMs, input.signal, context);
    return {
      handled: true,
      result: await context.callProvider(`${input.requestId}:paste`, 'desktop_paste', { interaction_id: sourceInteractionId }, input.timeoutMs, input.signal),
    };
  }

  if (input.actionId === 'desktop_batch') {
    const normalized = normalizeDesktopBatchArguments(input.args);
    if (normalized.foregroundInteractionId) {
      await verifyExactForegroundDesktopSession(input.requestId, normalized.foregroundInteractionId, input.timeoutMs, input.signal, context);
    }
    return {
      handled: true,
      result: await context.callProvider(`${input.requestId}:batch`, 'desktop_batch', normalized.args, input.timeoutMs, input.signal),
    };
  }

  if (input.actionId === 'desktop_session_open' && input.args.activate === true) {
    return {
      handled: true,
      result: await openVerifiedDesktopSession(input.requestId, input.args, input.timeoutMs, input.signal, context),
    };
  }

  return { handled: false };
}
