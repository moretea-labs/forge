import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';

export type LegacyRuntimeSlot = 'blue' | 'green';

export interface RuntimeReleaseAuthority {
  instanceId: string;
  releasePath?: string;
  releaseRevision?: string;
  sourceCommit?: string;
  manifestHash?: string;
  publishedAt: string;
}

export interface RuntimePreviousAuthority extends RuntimeReleaseAuthority {
  rollbackUntil: string;
}

/**
 * The only primary Runtime authority. Slot, writer and active-runtime files are
 * compatibility projections and may never be selected when this record is
 * absent, invalid or inconsistent.
 */
export interface RuntimeAuthority {
  schemaVersion: 2;
  status: 'committed';
  authorityTerm: string;
  activationId: string;
  generation: string;
  configRevision: string;
  configHash: string;
  fencingToken: string;
  active: RuntimeReleaseAuthority;
  previous?: RuntimePreviousAuthority;
  ingress: { host: string; port: number };
  daemon: { port: number };
  gateway: { host: string; port: number };
  legacySlot: LegacyRuntimeSlot;
  previousLegacySlot?: LegacyRuntimeSlot;
  rollbackUntil?: string;
  operationId?: string;
  committedAt: string;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  controllerHome: string;
  configRevision: string;
  ingress: { host: string; port: number };
  daemon: { port: number; enabled: boolean; autoOpen: boolean };
  gateway: { host: string; port: number; auth: string };
  primaryPublicEndpoint?: string;
  primaryTunnelService?: string;
  profile: string;
  toolset: string;
  toolsetExplicit: boolean;
  accessMode: string;
  devMode?: { agentRunner?: boolean; allowedAgents?: string[]; timeoutMs?: number; maxTimeoutMs?: number };
}

export interface LegacyMcpConfig {
  server?: { host?: string; port?: number; transport?: string };
  auth?: { mode?: string };
  chatgpt?: { endpoint?: string };
  profile?: string;
  toolset?: string;
  toolsetExplicit?: boolean;
  accessMode?: string;
  devMode?: { agentRunner?: boolean; allowedAgents?: string[]; timeoutMs?: number; maxTimeoutMs?: number };
  localController?: { enabled?: boolean; mode?: string; host?: string; port?: number; autoOpen?: boolean };
}

interface LegacyActivationAuthority {
  schemaVersion?: number;
  status?: string;
  activeSlot?: LegacyRuntimeSlot;
  generation?: string;
  releaseRevision?: string;
  releasePath?: string;
  writerEpoch?: string;
  fencingToken?: string;
  daemonPort?: number;
  gatewayPort?: number;
  previousSlot?: LegacyRuntimeSlot;
  rollbackUntil?: string;
  committedAt?: string;
  transactionId?: string;
  reason?: string;
}

export function runtimeAuthorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'bootstrap', 'runtime-authority.json');
}

export function runtimeConfigPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'bootstrap', 'runtime-config.json');
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validPort(port: number | undefined): boolean {
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

function validEndpoint(endpoint: { host: string; port: number } | undefined): boolean {
  return Boolean(endpoint && typeof endpoint.host === 'string' && endpoint.host.length > 0 && validPort(endpoint.port));
}

function validRelease(release: RuntimeReleaseAuthority | undefined): release is RuntimeReleaseAuthority {
  if (!release || typeof release.instanceId !== 'string' || !release.instanceId || typeof release.publishedAt !== 'string') return false;
  return ['releasePath', 'releaseRevision', 'sourceCommit', 'manifestHash']
    .every((key) => release[key as keyof RuntimeReleaseAuthority] === undefined || typeof release[key as keyof RuntimeReleaseAuthority] === 'string');
}

export function runtimeConfigHash(controllerHome: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(runtimeConfigPath(controllerHome))).digest('hex');
  } catch {
    return undefined;
  }
}

export function readRuntimeConfig(controllerHome: string): RuntimeConfig | undefined {
  const value = readJson<RuntimeConfig>(runtimeConfigPath(controllerHome));
  if (!value || value.schemaVersion !== 1 || resolve(value.controllerHome) !== resolve(controllerHome)) return undefined;
  if (!value.configRevision || !validEndpoint(value.ingress) || !validPort(value.daemon?.port) || !validEndpoint(value.gateway)) return undefined;
  if (typeof value.daemon.enabled !== 'boolean' || typeof value.daemon.autoOpen !== 'boolean') return undefined;
  if (!value.gateway.auth || !value.profile || !value.toolset || typeof value.toolsetExplicit !== 'boolean' || !value.accessMode) return undefined;
  return value;
}

function assertRuntimeConfig(controllerHome: string, config: RuntimeConfig): void {
  if (
    config.schemaVersion !== 1
    || !config.configRevision
    || resolve(config.controllerHome) !== resolve(controllerHome)
    || !validEndpoint(config.ingress)
    || !validPort(config.daemon?.port)
    || !validEndpoint(config.gateway)
    || typeof config.daemon.enabled !== 'boolean'
    || typeof config.daemon.autoOpen !== 'boolean'
    || !config.gateway.auth
    || !config.profile
    || !config.toolset
    || typeof config.toolsetExplicit !== 'boolean'
    || !config.accessMode
  ) throw new Error('RUNTIME_CONFIG_INVALID');
}

export function writeRuntimeConfig(controllerHome: string, config: RuntimeConfig): void {
  assertRuntimeConfig(controllerHome, config);
  atomicWrite(runtimeConfigPath(controllerHome), { ...config, controllerHome: resolve(controllerHome) });
}

/** Commit a primary config update and immediately rebind/fence the authority. */
export function commitRuntimeConfig(controllerHome: string, config: RuntimeConfig): RuntimeConfig {
  const home = ensureControllerHome(controllerHome);
  assertRuntimeConfig(home, config);
  const existing = readRuntimeAuthority(home);
  writeRuntimeConfig(home, config);
  if (existing) {
    const committedAt = new Date().toISOString();
    writeRuntimeAuthority(home, {
      ...existing,
      authorityTerm: `wa-config-${Date.now()}-${randomUUID().slice(0, 8)}`,
      activationId: `config-${randomUUID()}`,
      configRevision: config.configRevision,
      configHash: runtimeConfigHash(home)!,
      fencingToken: randomUUID(),
      ingress: config.ingress,
      daemon: config.daemon,
      gateway: { host: config.gateway.host, port: config.gateway.port },
      operationId: 'runtime-config-commit',
      committedAt,
    });
  }
  return config;
}

function normalizedConfigBody(controllerHome: string, legacy: LegacyMcpConfig): Omit<RuntimeConfig, 'configRevision'> {
  const host = legacy.server?.host?.trim() || '127.0.0.1';
  const port = validPort(legacy.server?.port) ? legacy.server!.port! : 8765;
  const daemonPort = validPort(legacy.localController?.port) ? legacy.localController!.port! : 8766;
  return {
    schemaVersion: 1,
    controllerHome: resolve(controllerHome),
    ingress: { host, port },
    daemon: {
      port: daemonPort,
      enabled: legacy.localController?.enabled !== false && legacy.localController?.mode !== 'disabled',
      autoOpen: legacy.localController?.autoOpen === true,
    },
    gateway: { host, port, auth: legacy.auth?.mode?.trim() || 'oauth' },
    ...(legacy.chatgpt?.endpoint ? { primaryPublicEndpoint: legacy.chatgpt.endpoint } : {}),
    profile: legacy.profile?.trim() || 'controller',
    toolset: legacy.toolset?.trim() || 'core',
    toolsetExplicit: legacy.toolsetExplicit === true,
    accessMode: legacy.accessMode?.trim() || 'request',
    ...(legacy.devMode ? { devMode: legacy.devMode } : {}),
  };
}

export function defaultRuntimeConfig(controllerHome: string): RuntimeConfig {
  const body = normalizedConfigBody(controllerHome, {});
  const digest = createHash('sha256').update(stableJson(body)).digest('hex');
  return { ...body, configRevision: `runtime-config-${digest.slice(0, 16)}` };
}

export function runtimeConfigFromLegacyMcp(controllerHome: string, legacy: LegacyMcpConfig): RuntimeConfig {
  const body = normalizedConfigBody(controllerHome, legacy);
  const digest = createHash('sha256').update(stableJson(body)).digest('hex');
  return { ...body, configRevision: `runtime-config-${digest.slice(0, 16)}` };
}

export function runtimeConfigToLegacyMcp(config: RuntimeConfig): LegacyMcpConfig {
  return {
    server: { host: config.ingress.host, port: config.ingress.port, transport: 'http' },
    auth: { mode: config.gateway.auth },
    ...(config.primaryPublicEndpoint ? { chatgpt: { endpoint: config.primaryPublicEndpoint } } : {}),
    profile: config.profile,
    toolset: config.toolset,
    toolsetExplicit: config.toolsetExplicit,
    accessMode: config.accessMode,
    ...(config.devMode ? { devMode: config.devMode } : {}),
    localController: {
      enabled: config.daemon.enabled,
      mode: config.daemon.enabled ? 'standalone' : 'disabled',
      host: '127.0.0.1',
      port: config.daemon.port,
      autoOpen: config.daemon.autoOpen,
    },
  };
}

export function migrateRuntimeConfig(
  controllerHome: string,
  options: { legacyRepoRoots?: string[]; createDefault?: boolean } = {},
): RuntimeConfig {
  const existing = readRuntimeConfig(controllerHome);
  if (existing) return existing;
  if (existsSync(runtimeConfigPath(controllerHome))) {
    throw new Error('MIGRATION_REQUIRED: primary runtime-config.json exists but is invalid');
  }
  const home = ensureControllerHome(controllerHome);
  const paths = [
    join(home, 'mcp', 'mcp.local.json'),
    join(home, 'runtime-slots', 'blue', 'mcp', 'mcp.local.json'),
    join(home, 'runtime-slots', 'green', 'mcp', 'mcp.local.json'),
    ...(options.legacyRepoRoots ?? []).map((root) => join(resolve(root), '.repo-harness', 'mcp.local.json')),
  ];
  const candidates = paths.flatMap((path) => {
    const value = readJson<LegacyMcpConfig>(path);
    return value ? [{ path, config: runtimeConfigFromLegacyMcp(home, value) }] : [];
  });
  if (candidates.length === 0) {
    if (options.createDefault === false) throw new Error('RUNTIME_CONFIG_MISSING');
    const created = defaultRuntimeConfig(home);
    writeRuntimeConfig(home, created);
    return created;
  }
  const byBody = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const { configRevision: _revision, ...configBody } = candidate.config;
    const body = stableJson(configBody);
    const group = byBody.get(body) ?? [];
    group.push(candidate);
    byBody.set(body, group);
  }
  if (byBody.size !== 1) {
    throw new Error(`MIGRATION_REQUIRED: conflicting runtime config candidates: ${candidates.map((item) => item.path).join(', ')}`);
  }
  const migrated = candidates[0]!.config;
  writeRuntimeConfig(home, migrated);
  return migrated;
}

export function readRuntimeAuthority(controllerHome: string): RuntimeAuthority | undefined {
  const value = readJson<RuntimeAuthority>(runtimeAuthorityPath(controllerHome));
  if (
    !value
    || value.schemaVersion !== 2
    || value.status !== 'committed'
    || !value.authorityTerm
    || !value.activationId
    || !value.generation
    || !value.configRevision
    || !value.configHash
    || !value.fencingToken
    || (value.legacySlot !== 'blue' && value.legacySlot !== 'green')
    || !value.committedAt
  ) return undefined;
  if (!validRelease(value.active) || !validEndpoint(value.ingress) || !validPort(value.daemon?.port) || !validEndpoint(value.gateway)) return undefined;
  if (value.previous && (!validRelease(value.previous) || !value.previous.rollbackUntil)) return undefined;
  const config = readRuntimeConfig(controllerHome);
  const configHash = runtimeConfigHash(controllerHome);
  if (!config || config.configRevision !== value.configRevision || configHash !== value.configHash) return undefined;
  return value;
}

export function writeRuntimeAuthority(controllerHome: string, authority: RuntimeAuthority): void {
  if (
    authority.schemaVersion !== 2
    || authority.status !== 'committed'
    || !authority.authorityTerm
    || !authority.activationId
    || !authority.generation
    || !authority.fencingToken
    || !authority.committedAt
    || !validRelease(authority.active)
    || !validEndpoint(authority.ingress)
    || !validPort(authority.daemon?.port)
    || !validEndpoint(authority.gateway)
    || (authority.legacySlot !== 'blue' && authority.legacySlot !== 'green')
    || (authority.previous !== undefined && !validRelease(authority.previous))
  ) throw new Error('RUNTIME_AUTHORITY_INVALID');
  const config = readRuntimeConfig(controllerHome);
  const configHash = runtimeConfigHash(controllerHome);
  if (!config || config.configRevision !== authority.configRevision || configHash !== authority.configHash) {
    throw new Error('RUNTIME_AUTHORITY_CONFIG_MISMATCH');
  }
  atomicWrite(runtimeAuthorityPath(controllerHome), authority);
}

function legacyStatePaths(home: string): string[] {
  return [
    join(home, 'bootstrap', 'activation-authority.json'),
    join(home, 'bootstrap', 'writer-authority.json'),
    join(home, 'bootstrap', 'active-runtime.json'),
    join(home, 'active-slot.json'),
  ];
}

export function hasLegacyRuntimeAuthorityState(controllerHome: string): boolean {
  const home = ensureControllerHome(controllerHome);
  return legacyStatePaths(home).some((path) => existsSync(path));
}

export function migrateRuntimeAuthority(
  controllerHome: string,
  options: { legacyRepoRoots?: string[] } = {},
): RuntimeAuthority {
  const existing = readRuntimeAuthority(controllerHome);
  if (existing) return existing;
  if (existsSync(runtimeAuthorityPath(controllerHome))) {
    throw new Error('MIGRATION_REQUIRED: primary runtime-authority.json exists but is invalid');
  }
  const home = ensureControllerHome(controllerHome);
  const config = migrateRuntimeConfig(home, { legacyRepoRoots: options.legacyRepoRoots });
  const activation = readJson<LegacyActivationAuthority>(join(home, 'bootstrap', 'activation-authority.json'));
  const writer = readJson<{ epoch?: string; activeSlot?: LegacyRuntimeSlot; fencingToken?: string; generation?: string; releaseRevision?: string; releasePath?: string }>(join(home, 'bootstrap', 'writer-authority.json'));
  const pointer = readJson<{ activeSlot?: LegacyRuntimeSlot; generation?: string; releaseRevision?: string; releasePath?: string; writerEpoch?: string; fencingToken?: string; daemonPort?: number; gatewayPort?: number }>(join(home, 'bootstrap', 'active-runtime.json'));
  const slot = readJson<{ activeSlot?: LegacyRuntimeSlot; previousSlot?: LegacyRuntimeSlot; generation?: string; rollbackUntil?: string }>(join(home, 'active-slot.json'));
  if (!activation && !writer && !pointer && !slot) throw new Error('RUNTIME_AUTHORITY_MISSING');

  const selectedSlot = activation?.activeSlot ?? writer?.activeSlot ?? pointer?.activeSlot ?? slot?.activeSlot;
  const selectedGeneration = activation?.generation ?? writer?.generation ?? pointer?.generation ?? slot?.generation;
  const selectedEpoch = activation?.writerEpoch ?? writer?.epoch ?? pointer?.writerEpoch;
  const selectedToken = activation?.fencingToken ?? writer?.fencingToken ?? pointer?.fencingToken;
  const slotValues = [activation?.activeSlot, writer?.activeSlot, pointer?.activeSlot, slot?.activeSlot].filter(Boolean);
  const generationValues = [activation?.generation, writer?.generation, pointer?.generation, slot?.generation].filter(Boolean);
  const epochValues = [activation?.writerEpoch, writer?.epoch, pointer?.writerEpoch].filter(Boolean);
  const tokenValues = [activation?.fencingToken, writer?.fencingToken, pointer?.fencingToken].filter(Boolean);
  const inconsistent = [slotValues, generationValues, epochValues, tokenValues]
    .some((values) => new Set(values).size > 1);
  if (
    inconsistent
    || (selectedSlot !== 'blue' && selectedSlot !== 'green')
    || !selectedGeneration
    || !selectedEpoch
    || !selectedToken
  ) {
    throw new Error(`MIGRATION_REQUIRED: legacy runtime authority projections are incomplete or conflicting: ${legacyStatePaths(home).filter((path) => existsSync(path)).join(', ')}`);
  }
  const committedAt = activation?.committedAt ?? new Date().toISOString();
  const releasePath = activation?.releasePath ?? writer?.releasePath ?? pointer?.releasePath;
  const releaseRevision = activation?.releaseRevision ?? writer?.releaseRevision ?? pointer?.releaseRevision;
  const authority: RuntimeAuthority = {
    schemaVersion: 2,
    status: 'committed',
    authorityTerm: selectedEpoch,
    activationId: activation?.transactionId ?? `migration-${randomUUID()}`,
    generation: selectedGeneration,
    configRevision: config.configRevision,
    configHash: runtimeConfigHash(home)!,
    fencingToken: selectedToken,
    active: {
      instanceId: selectedGeneration,
      ...(releasePath ? { releasePath } : {}),
      ...(releaseRevision ? { releaseRevision } : {}),
      publishedAt: committedAt,
    },
    ingress: config.ingress,
    daemon: { port: activation?.daemonPort ?? pointer?.daemonPort ?? config.daemon.port },
    gateway: { host: config.gateway.host, port: activation?.gatewayPort ?? pointer?.gatewayPort ?? config.gateway.port },
    legacySlot: selectedSlot,
    ...(activation?.previousSlot ?? slot?.previousSlot ? { previousLegacySlot: activation?.previousSlot ?? slot?.previousSlot } : {}),
    ...(activation?.rollbackUntil ?? slot?.rollbackUntil ? { rollbackUntil: activation?.rollbackUntil ?? slot?.rollbackUntil } : {}),
    ...(activation?.reason ? { operationId: activation.reason } : {}),
    committedAt,
  };
  writeRuntimeAuthority(home, authority);
  return authority;
}

export function requireRuntimeAuthority(controllerHome: string): RuntimeAuthority {
  const authority = readRuntimeAuthority(controllerHome);
  if (authority) return authority;
  if (hasLegacyRuntimeAuthorityState(controllerHome) || existsSync(runtimeAuthorityPath(controllerHome))) {
    throw new Error('MIGRATION_REQUIRED: runtime-authority.json is missing, invalid, or not bound to runtime-config.json');
  }
  throw new Error('RUNTIME_AUTHORITY_MISSING');
}

export function requireRuntimeConfig(controllerHome: string): RuntimeConfig {
  const config = readRuntimeConfig(controllerHome);
  if (config) return config;
  const home = ensureControllerHome(controllerHome);
  const legacyCandidates = [
    join(home, 'mcp', 'mcp.local.json'),
    join(home, 'runtime-slots', 'blue', 'mcp', 'mcp.local.json'),
    join(home, 'runtime-slots', 'green', 'mcp', 'mcp.local.json'),
  ];
  if (legacyCandidates.some(existsSync) || existsSync(runtimeConfigPath(home))) {
    throw new Error('MIGRATION_REQUIRED: runtime-config.json is missing or invalid');
  }
  throw new Error('RUNTIME_CONFIG_MISSING');
}
