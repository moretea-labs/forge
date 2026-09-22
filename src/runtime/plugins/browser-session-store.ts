import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { basename, join, resolve } from 'path';
import type {
  ComputerSurfaceProviderBinding,
  ComputerSurfaceTarget,
  ComputerSurfaceVisibility,
} from '../../../packages/plugin-runtime/computer/target-authority';
import type { BrowserSessionState } from '../../../packages/protocols/browser/index';
import { currentRuntimeBrowserSessionExecutionContext } from '../root/browser-session-composition';
import { runtimeComputerInteractionTargetAuthority } from '../root/computer-target-composition';
import {
  cleanupLegacyBrowserSessionJson,
  readLegacyBrowserSessionMigrationEntries,
} from './browser-session-legacy-migration';
import { writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError } from './errors';

const BROWSER_STATE_ROOT = '.forge/browser';
const BROWSER_SESSION_COMPATIBILITY_NAMESPACE = 'browser.session.v1';
const BROWSER_SESSION_COMPUTER_MIGRATION_ID = 'browser-session-authority-v1-to-computer-surface-v1';

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function exactNativeSession(session: BrowserSessionState): boolean {
  return session.browser?.provider === 'macos-apple-events'
    && Boolean(session.browser.browserProduct && session.browser.tab?.windowId && session.browser.tab.tabId);
}

function surfaceOwnership(session: BrowserSessionState): 'plugin_owned' | 'user_owned' | 'provider_owned' {
  const ownership = session.browser?.tab?.ownership;
  if (ownership === 'plugin_owned' || ownership === 'user_owned') return ownership;
  return session.browser?.provider === 'playwright-persistent-context' || session.browser?.activeMode === 'managed_persistent'
    ? 'plugin_owned'
    : 'provider_owned';
}

function surfaceProviderBinding(session: BrowserSessionState): ComputerSurfaceProviderBinding | undefined {
  const browser = session.browser;
  if (!browser?.provider) return undefined;
  const tab = browser.tab;
  return {
    providerId: browser.provider,
    observedAt: tab?.capturedAt ?? session.updatedAt,
    ...(browser.browserProduct ? { browserProduct: browser.browserProduct } : {}),
    ...(tab?.windowId ? { windowId: tab.windowId } : {}),
    ...(tab?.tabId ? { tabId: tab.tabId } : {}),
    ...(tab?.ownerToken ? { ownerToken: tab.ownerToken } : {}),
  };
}

function browserCompatibilityRecord(session: BrowserSessionState) {
  return {
    namespace: BROWSER_SESSION_COMPATIBILITY_NAMESPACE,
    schemaVersion: 1,
    value: structuredClone(session) as unknown as Record<string, unknown>,
    updatedAt: session.updatedAt,
  };
}

function browserSessionFromSurface(target: ComputerSurfaceTarget): BrowserSessionState | undefined {
  const record = target.compatibilityRecords.find((entry) => entry.namespace === BROWSER_SESSION_COMPATIBILITY_NAMESPACE);
  if (!record) return undefined;
  const session = structuredClone(record.value) as unknown as BrowserSessionState;
  if (session?.schemaVersion !== 1 || typeof session.sessionId !== 'string' || typeof session.url !== 'string'
    || typeof session.createdAt !== 'string' || typeof session.updatedAt !== 'string') {
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Computer browser surface contains malformed compatibility session metadata.', {
      retryable: false,
      details: { targetId: target.targetId },
    });
  }
  const canonicalSessionId = target.compatibilityAliases[0] ?? session.sessionId;
  session.sessionId = canonicalSessionId;
  if (session.browser?.sessionResume) session.browser.sessionResume.sessionId = canonicalSessionId;
  return session;
}

function surfaceInput(
  session: BrowserSessionState,
  input: {
    aliases?: string[];
    repositoryIds?: string[];
    visibility?: ComputerSurfaceVisibility;
    includeCompatibility?: boolean;
    initialStatus?: 'active' | 'tombstoned';
    reactivate?: boolean;
  } = {},
) {
  const providerBinding = surfaceProviderBinding(session);
  return {
    stableIdentity: {
      surfaceType: session.browser?.tab ? 'browser-tab' as const : 'browser-page' as const,
      ownership: surfaceOwnership(session),
    },
    compatibilityAliases: unique([session.sessionId, ...(input.aliases ?? [])]),
    visibility: input.visibility ?? (exactNativeSession(session) ? 'controller' : 'repositories'),
    repositoryIds: unique(input.repositoryIds ?? []),
    ...(input.includeCompatibility === false ? {} : { compatibilityRecords: [browserCompatibilityRecord(session)] }),
    ...(providerBinding ? { providerBinding } : {}),
    ...(input.initialStatus ? { initialStatus: input.initialStatus } : {}),
    ...(input.reactivate !== undefined ? { reactivate: input.reactivate } : {}),
  };
}

/**
 * One-way compatibility cutover. The old Browser authority is only an import
 * source here. Once the per-repository Computer marker is closed, steady-state
 * Browser actions never read or write Browser-owned durable session state.
 */
export function ensureBrowserSessionsMigratedToComputer(repoRoot: string): number {
  const context = currentRuntimeBrowserSessionExecutionContext();
  if (!context) return 0;
  const computer = runtimeComputerInteractionTargetAuthority();
  if (computer.compatibilityMigrationMarker(context.controllerHome, BROWSER_SESSION_COMPUTER_MIGRATION_ID, context.repoId)) {
    cleanupLegacyBrowserSessionJson(context.controllerHome, context.repoId, repoRoot);
    return 0;
  }

  const legacyEntries = readLegacyBrowserSessionMigrationEntries({
    controllerHome: context.controllerHome,
    repoId: context.repoId,
    repoRoot,
  });
  let importedRecordCount = 0;
  for (const entry of legacyEntries) {
    const visible = Boolean(entry.nativeIdentity) || entry.repositoryIds.includes(context.repoId);
    if (!visible) continue;
    const visibility: ComputerSurfaceVisibility = entry.nativeIdentity ? 'controller' : 'repositories';
    computer.upsertSurface(context.controllerHome, surfaceInput(entry.session, {
      aliases: entry.aliases,
      repositoryIds: entry.repositoryIds,
      visibility,
      initialStatus: entry.status,
      reactivate: false,
    }));
    importedRecordCount += 1;
  }
  computer.closeCompatibilityMigration(context.controllerHome, {
    migrationId: BROWSER_SESSION_COMPUTER_MIGRATION_ID,
    scopeId: context.repoId,
    importedRecordCount,
  });
  cleanupLegacyBrowserSessionJson(context.controllerHome, context.repoId, repoRoot);
  return importedRecordCount;
}

/** Move legacy provider files out of the repository and retire the old path after migration. */
export function ensureBrowserStateInControllerHome(controllerHome: string, repoId: string, repoRoot: string): string {
  const targetRoot = join(controllerHome, 'repositories', repoId, 'browser');
  const compatibilityParent = join(repoRoot, '.forge');
  const compatibilityRoot = join(compatibilityParent, 'browser');
  mkdirSync(targetRoot, { recursive: true });

  let stat;
  try {
    stat = lstatSync(compatibilityRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (!stat) return targetRoot;

  if (stat.isSymbolicLink()) {
    const linked = readlinkSync(compatibilityRoot);
    const resolvedLinked = resolve(compatibilityParent, linked);
    if (resolvedLinked !== resolve(targetRoot)) {
      throw new Error(`BROWSER_STATE_COMPATIBILITY_LINK_MISMATCH: ${compatibilityRoot} -> ${linked}`);
    }
    rmSync(compatibilityRoot, { force: true });
    return targetRoot;
  }
  if (!stat.isDirectory()) throw new Error(`BROWSER_STATE_COMPATIBILITY_PATH_INVALID: ${compatibilityRoot}`);
  cpSync(compatibilityRoot, targetRoot, { recursive: true, force: false, errorOnExist: false });
  rmSync(compatibilityRoot, { recursive: true, force: true });
  return targetRoot;
}

/**
 * Browser semantic identity belongs to Computer SurfaceTarget authority. Provider
 * working state (profiles, screenshots, downloads, diagnostics) remains
 * repository-scoped under Controller Home. Repo-local session JSON exists only
 * for standalone compatibility when no Controller execution context is present.
 */
export function browserStateDir(
  repoRoot: string,
  name: 'sessions' | 'screenshots' | 'profiles' | 'downloads' | 'diagnostics',
): string {
  const context = currentRuntimeBrowserSessionExecutionContext();
  return context
    ? join(ensureBrowserStateInControllerHome(context.controllerHome, context.repoId, repoRoot), name)
    : join(repoRoot, BROWSER_STATE_ROOT, name);
}

function sessionPath(repoRoot: string, sessionId: string): string {
  return join(browserStateDir(repoRoot, 'sessions'), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function readLegacyBrowserSessionJson(path: string): BrowserSessionState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_READ_FAILED', 'Saved browser session metadata could not be read.', {
      retryable: true,
      details: { fileName: basename(path), cause: error instanceof Error ? error.message : String(error) },
    });
  }
  try {
    return JSON.parse(raw) as BrowserSessionState;
  } catch (error) {
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_CORRUPT', 'Saved browser session metadata is malformed; refusing to treat corrupt state as a missing session.', {
      retryable: false,
      details: { fileName: basename(path), cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function saveBrowserSession(repoRoot: string, session: BrowserSessionState): BrowserSessionState {
  const context = currentRuntimeBrowserSessionExecutionContext();
  if (!context) {
    writeJsonAtomic(sessionPath(repoRoot, session.sessionId), session);
    return session;
  }
  ensureBrowserSessionsMigratedToComputer(repoRoot);
  const computer = runtimeComputerInteractionTargetAuthority();
  const binding = surfaceProviderBinding(session);
  let existing = binding?.windowId && binding.tabId
    ? computer.findSurfaceByProviderBinding(context.controllerHome, binding)
    : undefined;
  existing ??= computer.findSurfaceByAlias(context.controllerHome, session.sessionId, context.repoId);

  // A tombstoned target is intentionally hidden from find*. Probe without a
  // Browser payload so reactivation preserves its canonical alias/createdAt.
  if (!existing) {
    existing = computer.upsertSurface(context.controllerHome, surfaceInput(session, {
      aliases: [session.sessionId],
      repositoryIds: [context.repoId],
      includeCompatibility: false,
      reactivate: true,
    })).target;
  }
  const previous = browserSessionFromSurface(existing);
  const canonicalSessionId = existing.compatibilityAliases[0] ?? session.sessionId;
  const normalized = structuredClone(session);
  normalized.sessionId = canonicalSessionId;
  if (previous?.createdAt) normalized.createdAt = previous.createdAt;
  if (normalized.browser?.sessionResume) normalized.browser.sessionResume.sessionId = canonicalSessionId;
  const saved = computer.upsertSurface(context.controllerHome, surfaceInput(normalized, {
    aliases: [session.sessionId, canonicalSessionId],
    repositoryIds: [context.repoId],
    reactivate: true,
  }));
  return browserSessionFromSurface(saved.target) ?? normalized;
}

export function findBrowserSession(repoRoot: string, sessionId?: string): BrowserSessionState | undefined {
  if (!sessionId) return undefined;
  const context = currentRuntimeBrowserSessionExecutionContext();
  if (!context) return readLegacyBrowserSessionJson(sessionPath(repoRoot, sessionId));
  ensureBrowserSessionsMigratedToComputer(repoRoot);
  const target = runtimeComputerInteractionTargetAuthority().findSurfaceByAlias(context.controllerHome, sessionId, context.repoId);
  return target ? browserSessionFromSurface(target) : undefined;
}

export function listSavedBrowserSessions(repoRoot: string): BrowserSessionState[] {
  const context = currentRuntimeBrowserSessionExecutionContext();
  if (context) {
    ensureBrowserSessionsMigratedToComputer(repoRoot);
    return runtimeComputerInteractionTargetAuthority().listAllSurfaces(context.controllerHome, { repoId: context.repoId })
      .map(browserSessionFromSurface)
      .filter((session): session is BrowserSessionState => Boolean(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId));
  }
  const root = browserStateDir(repoRoot, 'sessions');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw new AssistantPluginError('PLUGIN_BROWSER_SESSION_STATE_READ_FAILED', 'Saved browser session directory could not be read.', {
      retryable: true,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readLegacyBrowserSessionJson(join(root, name)))
    .filter((session): session is BrowserSessionState => Boolean(session));
}

export function removeBrowserSession(repoRoot: string, sessionId: string): void {
  const context = currentRuntimeBrowserSessionExecutionContext();
  if (context) {
    ensureBrowserSessionsMigratedToComputer(repoRoot);
    const computer = runtimeComputerInteractionTargetAuthority();
    const target = computer.findSurfaceByAlias(context.controllerHome, sessionId, context.repoId);
    if (target) computer.tombstoneSurface(context.controllerHome, target.targetId);
    return;
  }
  rmSync(sessionPath(repoRoot, sessionId), { force: true });
}

export function loadBrowserSession(repoRoot: string, sessionId?: string): BrowserSessionState | undefined {
  return sessionId ? findBrowserSession(repoRoot, sessionId) : undefined;
}

export function requireBrowserSession(repoRoot: string, sessionId: string): BrowserSessionState {
  const session = findBrowserSession(repoRoot, sessionId);
  if (!session) {
    throw new AssistantPluginError('PLUGIN_SESSION_NOT_FOUND', `Browser session not found: ${sessionId}`, { retryable: false });
  }
  return session;
}
