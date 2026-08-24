/**
 * Host adapter "managed entry" helpers — shared between Codex and Claude
 * targets because the entry shape is identical:
 *
 *   { matcher?: string, hooks: [{ type: 'command', command: string }] }
 *
 * The `MANAGED_TAG` substring inside each command string identifies entries
 * the forge installer wrote, so install can be idempotent and uninstall
 * can remove only its own entries (leaving sibling user hooks intact —
 * verified for Claude in Phase 0: `~/.claude/settings.json` already had a
 * non-forge `rtk hook claude` entry that must survive install).
 *
 * Command shape includes the `command -v forge || exit 0` shim
 * (Codex consult constraint #5: CLI-missing fallback — adapter must not
 * fail when CLI is uninstalled or not on PATH).
 */

import { ROUTES, type Route } from '../hook/route-registry';

export const MANAGED_TAG = 'forge hook';
const LEGACY_REPO_HARNESS_TAGS = ['repo-harness-hook', 'repo-harness hook'] as const;

export interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksByEvent = Record<string, HookEntry[]>;
export type HookHost = 'claude' | 'codex';

export function buildHookCommand(route: Route, host: HookHost): string {
  return `if command -v forge-hook >/dev/null 2>&1; then HOOK_HOST=${host} forge-hook ${route.event} --route ${route.routeId} && exit 0; fi; command -v forge >/dev/null 2>&1 || exit 0; HOOK_HOST=${host} exec forge hook ${route.event} --route ${route.routeId}`;
}

export function buildHookEntry(route: Route, host: HookHost): HookEntry {
  const entry: HookEntry = {
    hooks: [{ type: 'command', command: buildHookCommand(route, host), timeout: 30 }],
  };
  if (route.matcher !== undefined) entry.matcher = route.matcher;
  return entry;
}

export function isManagedEntry(entry: HookEntry): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MANAGED_TAG));
}

/** Legacy adapters are installer-owned migration input, never user hooks. */
export function isLegacyRepoHarnessEntry(entry: HookEntry): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => (
    typeof hook?.command === 'string'
    && LEGACY_REPO_HARNESS_TAGS.some((tag) => hook.command.includes(tag))
  ));
}

export function isLegacyRepoHarnessCommand(command: string): boolean {
  return LEGACY_REPO_HARNESS_TAGS.some((tag) => command.includes(tag));
}

export function buildManagedHooks(host: HookHost): HooksByEvent {
  const out: HooksByEvent = {};
  for (const route of ROUTES) {
    if (!out[route.event]) out[route.event] = [];
    out[route.event].push(buildHookEntry(route, host));
  }
  return out;
}

export function stripManagedEntries(existing: HooksByEvent | undefined): HooksByEvent {
  if (!existing) return {};
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(existing)) {
    const kept = (entries ?? []).filter((e) => !isManagedEntry(e) && !isLegacyRepoHarnessEntry(e));
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

export function mergeHooks(existing: HooksByEvent, managed: HooksByEvent): HooksByEvent {
  const out: HooksByEvent = { ...existing };
  for (const [event, managedEntries] of Object.entries(managed)) {
    out[event] = [...(out[event] ?? []), ...managedEntries];
  }
  return out;
}
