#!/usr/bin/env bun
import { randomUUID } from 'crypto';
import { resolveControllerHome } from '../src/cli/repositories/controller-home';
import { isWslWindowsRuntime } from '../src/cli/chatgpt-browser/bridge-provider';
import { createChatgptBrowserDeliveryHost } from '../adapters/chatgpt/browser-delivery-host';
import { createChatgptWslBridgeDeliveryHost } from '../adapters/chatgpt/wsl-bridge-delivery-host';
import {
  ensureChatgptExecutionPreference,
  ensureControllerChatgptBrowser,
  navigateWorkConversation,
  submitChatgptPrompt,
} from '../adapters/chatgpt/browser-delivery-runtime';
import type { ChatgptProviderDeliveryHost } from '../adapters/chatgpt/provider-delivery';

type ProviderMode = 'auto' | 'browser' | 'wsl-bridge';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${value ?? ''} is not a positive integer`);
  return parsed;
}

function providerMode(): ProviderMode {
  const value = (arg('--provider') ?? 'auto').trim();
  if (value === 'auto' || value === 'browser' || value === 'wsl-bridge') return value;
  throw new Error(`Unsupported --provider ${value}; expected auto, browser, or wsl-bridge.`);
}

function nativeBrowserHost(): ChatgptProviderDeliveryHost {
  return createChatgptBrowserDeliveryHost({
    ensureBrowser: ensureControllerChatgptBrowser,
    navigate: navigateWorkConversation,
    ensureExecutionPreference: ensureChatgptExecutionPreference,
    submitPrompt: submitChatgptPrompt,
  });
}

async function main(): Promise<void> {
  const requested = providerMode();
  const detectedWsl = isWslWindowsRuntime();
  const provider = requested === 'auto' ? (detectedWsl ? 'wsl-bridge' : 'browser') : requested;
  if (provider === 'wsl-bridge' && !detectedWsl) {
    throw new Error('STAGE3B_WSL_CANARY_REQUIRES_WSL: run the wsl-bridge canary from the WSL Forge instance.');
  }

  const controllerHome = resolveControllerHome(arg('--controller-home'));
  const timeoutMs = positiveInt(arg('--timeout-ms'), 60_000);
  const nonce = randomUUID();
  const targetUrl = arg('--target-url')?.trim() || 'https://chatgpt.com/';
  const prompt = arg('--prompt')?.trim()
    || `Forge Stage3B provider delivery canary ${nonce}. Reply with ACK only. Do not invoke tools or modify external state.`;
  const browserSessionId = arg('--browser-session-id')?.trim() || `forge-stage3b-canary-${nonce.slice(0, 12)}`;
  const workId = arg('--work-id')?.trim() || `stage3b-provider-canary-${nonce.slice(0, 12)}`;
  const host = provider === 'wsl-bridge' ? createChatgptWslBridgeDeliveryHost() : nativeBrowserHost();

  const startedAt = new Date().toISOString();
  const result = await host.dispatch({
    controllerHome,
    repoId: 'controller',
    repoRoot: process.cwd(),
    workId,
    prompt,
    browserSessionId,
    targetUrl,
    model: 'gpt-5.6',
    reasoning: 'high',
    timeoutMs,
  });
  const receipt = {
    schemaVersion: 1,
    canary: 'forge-v2-stage3b-provider-delivery',
    provider,
    requestedProvider: requested,
    detectedWsl,
    controllerHome,
    workId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: result.status,
    browserSessionId: result.browserSessionId,
    conversationUrl: result.conversationUrl,
    executionPreferenceVerified: result.executionPreferenceVerified,
    error: result.error,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (result.status !== 'dispatch_confirmed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
