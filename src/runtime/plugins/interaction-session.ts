import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export type InteractionProvider = 'browser' | 'ios-simulator' | 'ios-device';
export type InteractionEngine = 'agent-device' | 'coredevice';
export type InteractionSessionStatus =
  | 'starting'
  | 'waiting_for_user'
  | 'unknown'
  | 'closing'
  | 'completed'
  | 'closed'
  | 'failed';
export type InteractionCommandKind = 'resume' | 'cancel';

export interface InteractionSessionRecord {
  schemaVersion: 1;
  interactionId: string;
  provider: InteractionProvider;
  /** Execution engine inside the provider-owned resource domain. Optional for schema-v1 compatibility. */
  engine?: InteractionEngine;
  sessionId: string;
  targetId: string;
  /** Stable identifiers known to refer to the same provider resource. Immutable after creation. */
  targetAliases?: string[];
  status: InteractionSessionStatus;
  reason: string;
  instructions?: string;
  owner: {
    repoId: string;
    requestId: string;
    jobId?: string;
  };
  host?: {
    pid?: number;
    startedAt?: string;
    heartbeatAt?: string;
    foregroundPresented?: boolean;
  };
  result?: {
    url?: string;
    title?: string;
  };
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface InteractionCommand {
  schemaVersion: 1;
  interactionId: string;
  kind: InteractionCommandKind;
  requestedAt: string;
  requestedBy: string;
}

function providerRoot(repoRoot: string, provider: InteractionProvider): string {
  return join(repoRoot, '.repo-harness', 'interactions', sanitizeFileComponent(provider));
}

export function interactionSessionPath(repoRoot: string, provider: InteractionProvider, interactionId: string): string {
  return join(providerRoot(repoRoot, provider), 'sessions', `${sanitizeFileComponent(interactionId)}.json`);
}

export function interactionLaunchSpecPath(repoRoot: string, provider: InteractionProvider, interactionId: string): string {
  return join(providerRoot(repoRoot, provider), 'launch', `${sanitizeFileComponent(interactionId)}.json`);
}

export function interactionCommandPath(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
  kind: InteractionCommandKind,
): string {
  return join(providerRoot(repoRoot, provider), 'commands', `${sanitizeFileComponent(interactionId)}.${kind}.json`);
}

export function readInteractionSession(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
): InteractionSessionRecord | undefined {
  const path = interactionSessionPath(repoRoot, provider, interactionId);
  if (!existsSync(path)) return undefined;
  const value = readJsonFile<InteractionSessionRecord | undefined>(path, undefined);
  return value?.schemaVersion === 1 && value.interactionId === interactionId ? value : undefined;
}

export function interactionAutomationEngine(record: InteractionSessionRecord): InteractionEngine | undefined {
  if (record.engine !== undefined) {
    return record.engine === 'agent-device' || record.engine === 'coredevice'
      ? record.engine
      : undefined;
  }
  if ((record.provider === 'ios-device' || record.provider === 'ios-simulator')
    && record.interactionId.startsWith('ios_agent_device_')
    && (record.reason === 'ios_simulator_automation' || record.reason === 'ios_physical_device_automation')) {
    return 'agent-device';
  }
  if (record.provider === 'ios-device'
    && record.interactionId.startsWith('ios_device_')
    && record.reason === 'ios_physical_device_automation') {
    return 'coredevice';
  }
  return undefined;
}

export function interactionTargetIdentifiers(record: InteractionSessionRecord): string[] {
  return Array.from(new Set([
    record.targetId,
    ...(Array.isArray(record.targetAliases) ? record.targetAliases : []),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim())));
}

export function interactionTargetsOverlap(
  record: InteractionSessionRecord,
  candidates: Array<string | undefined>,
): boolean {
  const canonical = (value: string) => value.trim().toLocaleLowerCase('en-US');
  const expected = new Set(candidates
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(canonical));
  return interactionTargetIdentifiers(record).some((value) => expected.has(canonical(value)));
}

/**
 * Decide whether an active interaction may own one selected target.
 *
 * Pre-alias physical-device records cannot prove that their provider-internal
 * identifier names a different phone from a hardware UDID. During migration,
 * fail closed inside the shared ios-device domain rather than permitting a
 * second automation engine to acquire a potentially identical phone.
 */
export function interactionMayOwnTarget(
  record: InteractionSessionRecord,
  candidates: Array<string | undefined>,
): boolean {
  if (interactionTargetsOverlap(record, candidates)) return true;
  if (record.provider !== 'ios-device') return false;
  const hasTrustedAliases = Array.isArray(record.targetAliases)
    && record.targetAliases.some((value) => typeof value === 'string' && Boolean(value.trim()));
  return !hasTrustedAliases;
}

export function writeInteractionSession(repoRoot: string, record: InteractionSessionRecord): InteractionSessionRecord {
  writeJsonAtomic(interactionSessionPath(repoRoot, record.provider, record.interactionId), record);
  return record;
}

export function patchInteractionSession(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
  patch: Partial<Omit<InteractionSessionRecord,
    | 'schemaVersion'
    | 'interactionId'
    | 'provider'
    | 'engine'
    | 'sessionId'
    | 'targetId'
    | 'targetAliases'
    | 'owner'
    | 'createdAt'
  >>,
): InteractionSessionRecord | undefined {
  const current = readInteractionSession(repoRoot, provider, interactionId);
  if (!current) return undefined;
  return writeInteractionSession(repoRoot, {
    ...current,
    ...patch,
    host: patch.host ? { ...current.host, ...patch.host } : current.host,
    result: patch.result ? { ...current.result, ...patch.result } : current.result,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  });
}

export function listInteractionSessions(repoRoot: string, provider: InteractionProvider): InteractionSessionRecord[] {
  const root = join(providerRoot(repoRoot, provider), 'sessions');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile<InteractionSessionRecord | undefined>(join(root, name), undefined))
    .filter((entry): entry is InteractionSessionRecord => Boolean(entry?.schemaVersion === 1 && entry.interactionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function writeInteractionCommand(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
  kind: InteractionCommandKind,
  requestedBy: string,
): InteractionCommand {
  const command: InteractionCommand = {
    schemaVersion: 1,
    interactionId,
    kind,
    requestedAt: new Date().toISOString(),
    requestedBy,
  };
  writeJsonAtomic(interactionCommandPath(repoRoot, provider, interactionId, kind), command);
  return command;
}

export function readInteractionCommand(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
  kind: InteractionCommandKind,
): InteractionCommand | undefined {
  const path = interactionCommandPath(repoRoot, provider, interactionId, kind);
  if (!existsSync(path)) return undefined;
  return readJsonFile<InteractionCommand | undefined>(path, undefined);
}

export function removeInteractionCommand(
  repoRoot: string,
  provider: InteractionProvider,
  interactionId: string,
  kind: InteractionCommandKind,
): void {
  rmSync(interactionCommandPath(repoRoot, provider, interactionId, kind), { force: true });
}

export function removeInteractionSession(repoRoot: string, provider: InteractionProvider, interactionId: string): void {
  rmSync(interactionSessionPath(repoRoot, provider, interactionId), { force: true });
  rmSync(interactionLaunchSpecPath(repoRoot, provider, interactionId), { force: true });
  removeInteractionCommand(repoRoot, provider, interactionId, 'resume');
  removeInteractionCommand(repoRoot, provider, interactionId, 'cancel');
}

export function pruneInteractionSessions(
  repoRoot: string,
  provider: InteractionProvider,
  maxTerminalSessions = 100,
): number {
  const terminal = listInteractionSessions(repoRoot, provider)
    .filter((record) => !isInteractionSessionActive(record.status));
  const stale = terminal.slice(Math.max(0, Math.trunc(maxTerminalSessions)));
  for (const record of stale) removeInteractionSession(repoRoot, provider, record.interactionId);
  return stale.length;
}

export function isInteractionSessionActive(status: InteractionSessionStatus): boolean {
  return status === 'starting' || status === 'waiting_for_user' || status === 'unknown' || status === 'closing';
}
