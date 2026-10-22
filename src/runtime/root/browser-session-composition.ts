import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrowserSessionExecutionContext } from '../../../packages/plugin-runtime/browser/session-authority';

const browserSessionExecutionContext = new AsyncLocalStorage<BrowserSessionExecutionContext>();

export function withRuntimeBrowserSessionExecutionContext<T>(
  context: BrowserSessionExecutionContext,
  operation: () => T,
): T {
  return browserSessionExecutionContext.run(context, operation);
}

export function currentRuntimeBrowserSessionExecutionContext(): BrowserSessionExecutionContext | undefined {
  return browserSessionExecutionContext.getStore();
}
