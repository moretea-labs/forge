import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BrowserSessionAuthorityContext,
  BrowserSessionAuthorityPort,
} from '../../../packages/plugin-runtime/browser/session-authority';
import { createBrowserSessionAuthority } from '../../../adapters/browser/index';
import { createRuntimeBrowserSessionPersistence } from './browser-session-persistence';

const browserSessionAuthorityContext = new AsyncLocalStorage<BrowserSessionAuthorityContext>();
const browserSessionAuthority = createBrowserSessionAuthority(createRuntimeBrowserSessionPersistence());

export function withRuntimeBrowserSessionAuthorityContext<T>(
  context: BrowserSessionAuthorityContext,
  operation: () => T,
): T {
  return browserSessionAuthorityContext.run(context, operation);
}

export function currentRuntimeBrowserSessionAuthorityContext(): BrowserSessionAuthorityContext | undefined {
  return browserSessionAuthorityContext.getStore();
}

export function runtimeBrowserSessionAuthority(): BrowserSessionAuthorityPort {
  return browserSessionAuthority;
}
