import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'fs';
import { basename, join } from 'path';
import { writeJsonAtomic } from '../shared/json-files';
import { AssistantPluginError } from './errors';
import {
  currentRuntimeBrowserSessionAuthorityContext,
  runtimeBrowserSessionAuthority,
} from '../root/browser-session-composition';

const BROWSER_STATE_ROOT = '.forge/browser';

import type { BrowserSessionState } from '../../../packages/protocols/browser/index';

/** Move legacy provider files out of the repository and keep the old path as a compatibility link only. */
export function ensureBrowserStateCompatibilityLink(controllerHome: string, repoId: string, repoRoot: string): string {
  const targetRoot = join(controllerHome, 'repositories', repoId, 'browser');
  const compatibilityParent = join(repoRoot, '.forge');
  const compatibilityRoot = join(compatibilityParent, 'browser');
  mkdirSync(targetRoot, { recursive: true });
  if (existsSync(compatibilityRoot)) {
    const stat = lstatSync(compatibilityRoot);
    if (stat.isSymbolicLink()) {
      const linked = readlinkSync(compatibilityRoot);
      if (linked !== targetRoot) throw new Error(`BROWSER_STATE_COMPATIBILITY_LINK_MISMATCH: ${compatibilityRoot} -> ${linked}`);
      return targetRoot;
    }
    if (!stat.isDirectory()) throw new Error(`BROWSER_STATE_COMPATIBILITY_PATH_INVALID: ${compatibilityRoot}`);
    cpSync(compatibilityRoot, targetRoot, { recursive: true, force: false, errorOnExist: false });
    rmSync(compatibilityRoot, { recursive: true, force: true });
  }
  mkdirSync(compatibilityParent, { recursive: true });
  if (!existsSync(compatibilityRoot)) symlinkSync(targetRoot, compatibilityRoot, process.platform === 'win32' ? 'junction' : 'dir');
  return targetRoot;
}

/**
 * Browser session semantics are durable SQLite authority. Provider working state
 * (profiles, screenshots, downloads, diagnostics) is repository-scoped but lives
 * under Controller Home when an authority context exists. The repo-local path is
 * legacy compatibility storage only for migration/tests/standalone helpers.
 */
export function browserStateDir(
  repoRoot: string,
  name: 'sessions' | 'screenshots' | 'profiles' | 'downloads' | 'diagnostics',
): string {
  const authority = currentRuntimeBrowserSessionAuthorityContext();
  return authority
    ? join(ensureBrowserStateCompatibilityLink(authority.controllerHome, authority.repoId, repoRoot), name)
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
  const authority = currentRuntimeBrowserSessionAuthorityContext();
  if (!authority) {
    writeJsonAtomic(sessionPath(repoRoot, session.sessionId), session);
    return session;
  }
  const saved = runtimeBrowserSessionAuthority().save<BrowserSessionState>(authority, repoRoot, session);
  if (saved.sessionId === session.sessionId || !saved.browser?.sessionResume) return saved;
  return {
    ...saved,
    browser: {
      ...saved.browser,
      sessionResume: { ...saved.browser.sessionResume, sessionId: saved.sessionId },
    },
  };
}

export function findBrowserSession(repoRoot: string, sessionId?: string): BrowserSessionState | undefined {
  if (!sessionId) return undefined;
  const authority = currentRuntimeBrowserSessionAuthorityContext();
  return authority
    ? runtimeBrowserSessionAuthority().find<BrowserSessionState>(authority, repoRoot, sessionId)
    : readLegacyBrowserSessionJson(sessionPath(repoRoot, sessionId));
}

export function listSavedBrowserSessions(repoRoot: string): BrowserSessionState[] {
  const authority = currentRuntimeBrowserSessionAuthorityContext();
  if (authority) {
    return runtimeBrowserSessionAuthority().listAll<BrowserSessionState>(authority, repoRoot);
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
  const authority = currentRuntimeBrowserSessionAuthorityContext();
  if (authority) {
    runtimeBrowserSessionAuthority().tombstone(authority, repoRoot, sessionId);
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
