import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, extname, relative, resolve, sep } from 'path';
import { LanguageServerClient } from './lsp-client';
import type {
  SemanticNavigationAccess,
  SemanticNavigationOutcome,
  SemanticNavigationProvider,
  SemanticNavigationRequest,
} from './semantic-navigation';

export interface GenericLspProviderDescriptor {
  id: string;
  language: string;
  languageId: string;
  command: readonly string[];
  extensions: readonly string[];
  rootMarkers: readonly string[];
  identityFiles?: readonly string[];
  initializationOptions?: unknown;
  workspaceConfiguration?: unknown;
}

type GenericLspWorkspace = {
  root: string;
  relativeRoot: string;
  rootMarker: string;
  configurationFingerprint: string;
};

type GenericLspSession = {
  client: LanguageServerClient;
  initializeMs: number;
  generationIdentity: string;
  lastUsedAt: number;
  queue: Promise<void>;
  holders: number;
  retiring: boolean;
  expiryTimer?: NodeJS.Timeout;
};

type GenericLspSessionSlot = {
  current?: Promise<GenericLspSession>;
};

const GENERIC_LSP_SESSION_TTL_MS = 120_000;
const GENERIC_LSP_COLD_TIMEOUT_MS = 8_000;
const GENERIC_LSP_WARM_TIMEOUT_MS = 2_500;
const genericSessionSlots = new Map<string, GenericLspSessionSlot>();

function normalizedRelative(root: string, absolute: string): string | undefined {
  const value = relative(root, absolute).split(sep).join('/');
  if (!value || value === '.' || value === '..' || value.startsWith('../')) return undefined;
  return value;
}

function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return 'not-file';
    if (stat.size <= 2 * 1024 * 1024) {
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return 'missing';
  }
}

function descriptorFingerprint(descriptor: GenericLspProviderDescriptor): string {
  return createHash('sha256').update(JSON.stringify({
    id: descriptor.id,
    language: descriptor.language,
    languageId: descriptor.languageId,
    command: descriptor.command,
    extensions: descriptor.extensions,
    rootMarkers: descriptor.rootMarkers,
    identityFiles: descriptor.identityFiles ?? [],
    initializationOptions: descriptor.initializationOptions,
    workspaceConfiguration: descriptor.workspaceConfiguration,
  })).digest('hex').slice(0, 24);
}

export function resolveGenericLspWorkspace(
  repoRoot: string,
  requestPath: string,
  descriptor: GenericLspProviderDescriptor,
): GenericLspWorkspace {
  const root = resolve(repoRoot);
  const target = resolve(root, requestPath);
  const targetRelative = normalizedRelative(root, target);
  if (!targetRelative) throw new Error(`LSP_SEMANTIC_TARGET_INVALID: target must stay inside the repository: ${requestPath}`);
  if (!existsSync(target)) throw new Error(`LSP_SEMANTIC_TARGET_MISSING: ${targetRelative}`);

  let current = dirname(target);
  while (current === root || current.startsWith(`${root}${sep}`)) {
    const marker = descriptor.rootMarkers.find((candidate) => existsSync(resolve(current, candidate)));
    if (marker) {
      const identityNames = [...new Set([...descriptor.rootMarkers, ...(descriptor.identityFiles ?? [])])].sort();
      const hash = createHash('sha256').update(`generic-lsp-v1\0${descriptorFingerprint(descriptor)}\0`);
      for (const name of identityNames) hash.update(`${name}\0${fileIdentity(resolve(current, name))}\0`);
      return {
        root: current,
        relativeRoot: normalizedRelative(root, current) ?? '.',
        rootMarker: marker,
        configurationFingerprint: hash.digest('hex').slice(0, 24),
      };
    }
    if (current === root) break;
    current = dirname(current);
  }
  throw new Error(`LSP_SEMANTIC_WORKSPACE_UNAVAILABLE: ${descriptor.id} requires one of ${descriptor.rootMarkers.join(', ')}.`);
}

function errorOutcome(error: unknown): SemanticNavigationOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return { ok: false, code: match?.[1] ?? 'LSP_SEMANTIC_NAVIGATION_FAILED', message };
}

function sessionSlotKey(
  repoRoot: string,
  workspace: GenericLspWorkspace,
  descriptor: GenericLspProviderDescriptor,
): string {
  return [descriptor.id, resolve(repoRoot), workspace.root].join('\0');
}

function sessionGenerationIdentity(
  workspace: GenericLspWorkspace,
  sourceIdentity: string | undefined,
): string {
  // Generic servers do not yet receive a complete repository file-change delta.
  // Source and project/build identity therefore define one server generation.
  return `${workspace.configurationFingerprint}\0${sourceIdentity ?? 'unbound-source'}`;
}

async function retireSession(session: GenericLspSession): Promise<void> {
  session.retiring = true;
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  // holders covers requests that acquired this generation even before they enter
  // its serialized queue. Never close until every holder has left.
  if (session.holders > 0 || session.client.pendingRequestCount() > 0) return;
  await session.queue.catch(() => undefined);
  if (session.holders === 0 && session.client.pendingRequestCount() === 0) await session.client.close();
}

function scheduleExpiry(slotKey: string, promise: Promise<GenericLspSession>, session: GenericLspSession): void {
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => {
    const slot = genericSessionSlots.get(slotKey);
    if (slot?.current !== promise) return;
    const idleMs = Date.now() - session.lastUsedAt;
    if (idleMs < GENERIC_LSP_SESSION_TTL_MS || session.holders > 0 || session.client.pendingRequestCount() > 0) {
      scheduleExpiry(slotKey, promise, session);
      return;
    }
    genericSessionSlots.delete(slotKey);
    void retireSession(session);
  }, GENERIC_LSP_SESSION_TTL_MS);
  session.expiryTimer.unref?.();
}

async function acquireSession(
  repoRoot: string,
  workspace: GenericLspWorkspace,
  descriptor: GenericLspProviderDescriptor,
  sourceIdentity: string | undefined,
): Promise<{ session: GenericLspSession; reused: boolean; slotKey: string }> {
  const slotKey = sessionSlotKey(repoRoot, workspace, descriptor);
  const generationIdentity = sessionGenerationIdentity(workspace, sourceIdentity);
  const slot = genericSessionSlots.get(slotKey) ?? {};
  genericSessionSlots.set(slotKey, slot);
  const existingPromise = slot.current;
  if (existingPromise) {
    const existing = await existingPromise;
    if (existing.generationIdentity === generationIdentity && !existing.retiring) {
      existing.holders += 1;
      existing.lastUsedAt = Date.now();
      scheduleExpiry(slotKey, existingPromise, existing);
      return { session: existing, reused: true, slotKey };
    }
    void retireSession(existing);
  }
  const promise = (async () => {
    const client = new LanguageServerClient({
      repoRoot,
      workspaceRoot: workspace.root,
      command: descriptor.command,
      languageId: descriptor.languageId,
      serverName: descriptor.id,
      initializationOptions: descriptor.initializationOptions,
      workspaceConfiguration: descriptor.workspaceConfiguration,
      errorCodes: {
        unavailable: 'LSP_SEMANTIC_SERVER_UNAVAILABLE',
        exited: 'LSP_SEMANTIC_SERVER_EXITED',
        protocol: 'LSP_SEMANTIC_PROTOCOL_ERROR',
        requestFailed: 'LSP_SEMANTIC_REQUEST_FAILED',
        timeout: 'LSP_SEMANTIC_TIMEOUT',
      },
    });
    try {
      const initializeMs = await client.initialize(GENERIC_LSP_COLD_TIMEOUT_MS);
      return {
        client,
        initializeMs,
        generationIdentity,
        lastUsedAt: Date.now(),
        queue: Promise.resolve(),
        holders: 1,
        retiring: false,
      } satisfies GenericLspSession;
    } catch (error) {
      await client.close();
      throw error;
    }
  })();
  slot.current = promise;
  try {
    const session = await promise;
    scheduleExpiry(slotKey, promise, session);
    return { session, reused: false, slotKey };
  } catch (error) {
    if (slot.current === promise) {
      genericSessionSlots.delete(slotKey);
      slot.current = undefined;
    }
    throw error;
  }
}

async function withSessionLock<T>(session: GenericLspSession, action: () => Promise<T>): Promise<T> {
  const previous = session.queue;
  let release!: () => void;
  session.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous.catch(() => undefined);
  try {
    session.lastUsedAt = Date.now();
    return await action();
  } finally {
    session.lastUsedAt = Date.now();
    release();
  }
}

export class GenericLspSemanticProvider implements SemanticNavigationProvider {
  readonly id: string;
  readonly languages: readonly string[];

  constructor(readonly descriptor: GenericLspProviderDescriptor) {
    this.id = `lsp:${descriptor.id}`;
    this.languages = [descriptor.language];
  }

  supports(request: SemanticNavigationRequest): boolean {
    const extensionSupported = this.descriptor.extensions.includes(extname(request.path).toLowerCase());
    return extensionSupported && (!request.language || request.language.toLowerCase() === this.descriptor.language.toLowerCase());
  }

  async navigate(
    repoRoot: string,
    requests: SemanticNavigationRequest[],
    access: SemanticNavigationAccess,
  ): Promise<SemanticNavigationOutcome[]> {
    if (access.profile !== 'controller') {
      return requests.map(() => ({
        ok: false,
        code: 'LSP_SEMANTIC_READ_SCOPE_UNSUPPORTED',
        message: `External ${this.descriptor.id} navigation is restricted to the controller read profile; use lexical/CodeGraph evidence under narrower read policies.`,
      }));
    }
    const outcomes: Array<SemanticNavigationOutcome | undefined> = new Array(requests.length);
    const groups = new Map<string, Array<{ index: number; request: SemanticNavigationRequest; workspace: GenericLspWorkspace; workspaceRelativePath: string }>>();
    requests.forEach((request, index) => {
      try {
        if (request.tsconfigPath) throw new Error('LSP_SEMANTIC_TSCONFIG_UNSUPPORTED: tsconfig_path applies only to the TypeScript provider.');
        if (!access.allowRepositoryPath(request.path)) throw new Error(`LSP_SEMANTIC_POLICY_DENIED: ${request.path}`);
        const workspace = resolveGenericLspWorkspace(repoRoot, request.path, this.descriptor);
        const workspaceRelativePath = relative(workspace.root, resolve(repoRoot, request.path)).split(sep).join('/');
        const key = `${workspace.root}\0${workspace.configurationFingerprint}`;
        const group = groups.get(key) ?? [];
        group.push({ index, request, workspace, workspaceRelativePath });
        groups.set(key, group);
      } catch (error) {
        outcomes[index] = errorOutcome(error);
      }
    });

    for (const group of groups.values()) {
      const first = group[0]!;
      try {
        const acquired = await acquireSession(repoRoot, first.workspace, this.descriptor, access.sourceIdentity);
        try {
          await withSessionLock(acquired.session, async () => {
            for (const path of new Set(group.map((entry) => entry.workspaceRelativePath))) acquired.session.client.syncDocument(path);
            for (const entry of group) {
              try {
                const navigated = await acquired.session.client.navigate(entry.request, entry.workspaceRelativePath, acquired.reused ? GENERIC_LSP_WARM_TIMEOUT_MS : GENERIC_LSP_COLD_TIMEOUT_MS);
                outcomes[entry.index] = {
                ok: true,
                result: {
                  providerId: this.id,
                  providerIdentity: first.workspace.configurationFingerprint,
                  language: this.descriptor.language,
                  navigation: entry.request.navigation,
                  target: { path: entry.request.path, line: entry.request.line, column: entry.request.column },
                  locations: navigated.locations.filter((location) => access.allowRepositoryPath(location.path)),
                  details: {
                    workspace: {
                      root: first.workspace.relativeRoot,
                      kind: 'lsp',
                      rootMarker: first.workspace.rootMarker,
                      configurationFingerprint: first.workspace.configurationFingerprint,
                    },
                    timingsMs: {
                      initialize: acquired.session.initializeMs,
                      navigation: navigated.navigationMs,
                      sessionReused: acquired.reused,
                    },
                  },
                },
              };
              } catch (error) {
                outcomes[entry.index] = errorOutcome(error);
              }
            }
          });
        } finally {
          acquired.session.holders = Math.max(0, acquired.session.holders - 1);
          if (acquired.session.retiring) await retireSession(acquired.session);
        }
      } catch (error) {
        for (const entry of group) if (!outcomes[entry.index]) outcomes[entry.index] = errorOutcome(error);
      }
    }
    return outcomes.map((outcome) => outcome ?? ({ ok: false, code: 'LSP_SEMANTIC_NAVIGATION_FAILED', message: 'Language server produced no outcome.' }));
  }
}

export async function disposeGenericLspSessions(): Promise<void> {
  const sessions = [...new Set([...genericSessionSlots.values()].map((slot) => slot.current).filter((value): value is Promise<GenericLspSession> => Boolean(value)))];
  genericSessionSlots.clear();
  await Promise.all(sessions.map(async (promise) => {
    try {
      const session = await promise;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      session.retiring = true;
      session.holders = 0;
      await session.queue.catch(() => undefined);
      await session.client.close();
    } catch {
      // Initialization failure already tears down the client.
    }
  }));
}
