import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { resolveGitExecutable } from '../../effects/git-executable';
import {
  durableControllerHome,
  ensureControllerHome,
  ensureRepositoryControllerLayout,
} from './controller-home';
import {
  inferDisplayName,
  newLocalRepoId,
  normalizeRemoteUrl,
  parseGitHubRemote,
  stableCheckoutId,
  stableRemoteRepoId,
} from './identity';
import type {
  RepositoryCheckout,
  RepositoryCheckoutLifecycle,
  RepositoryRecord,
  RepositoryRegistry,
  RepositoryStateStorageStrategy,
  RepositorySummary,
  RepositoryType,
  RepositoryValidation,
} from './types';

const REGISTRY_FILE = 'repositories.json';
const FOCUS_FILE = 'focus.json';
const LEGACY_LOCAL_CONFIG = '.ai/harness/repository.json';
const LEGACY_GITHUB_PLUGIN_CONFIG = '.forge/plugins/github.json';

interface RegisterRepositoryInput {
  path: string;
  controllerHome?: string;
  displayName?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  repositoryType?: RepositoryType;
  enabled?: boolean;
  stateStorageStrategy?: RepositoryStateStorageStrategy;
  repoIdOverride?: string;
}

interface UpdateRepositoryInput {
  displayName?: string;
  enabled?: boolean;
  defaultBranch?: string;
  stateStorageStrategy?: RepositoryStateStorageStrategy;
  github?: RepositoryRecord['github'];
}

export interface AddRepositoryCheckoutInput {
  repoId: string;
  path: string;
  controllerHome?: string;
  activate?: boolean;
}

export interface SetRepositoryCheckoutLifecycleInput {
  repoId: string;
  checkoutId: string;
  lifecycle: RepositoryCheckoutLifecycle;
  reason?: string;
  controllerHome?: string;
}

export interface ReconcileRepositoryCheckoutsResult {
  repository: RepositoryRecord;
  archivedCheckoutIds: string[];
}

function validBranch(value: string | undefined): boolean {
  if (!value) return true;
  return /^(?!\/)(?!.*(?:\/\/|\.\.))(?!.*\/$)[A-Za-z0-9._/-]+$/.test(value);
}

function now(): string {
  return new Date().toISOString();
}

function comparablePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'darwin' && resolved.startsWith('/var/')
    ? `/private${resolved}`
    : resolved;
}

function pathInside(parent: string, candidate: string): boolean {
  const rel = relative(comparablePath(parent), comparablePath(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function registrationPathPolicy(home: string, canonicalRoot: string): void {
  const systemTemp = realpathSync(tmpdir());
  const controllerIsEphemeral = pathInside(systemTemp, home);
  if (!controllerIsEphemeral && pathInside(systemTemp, canonicalRoot)) {
    throw new Error(`REPOSITORY_EPHEMERAL_PATH_DENIED: ${canonicalRoot}`);
  }
  const managedWorktrees = join(home, 'repositories');
  const segments = relative(managedWorktrees, canonicalRoot).split(/[/\\]+/).filter(Boolean);
  if (segments.length >= 3 && segments[1] === 'worktrees') {
    throw new Error(`REPOSITORY_MANAGED_WORKTREE_DENIED: ${canonicalRoot}`);
  }
}

export function repositoryCheckoutLifecycle(checkout: RepositoryCheckout): RepositoryCheckoutLifecycle {
  return checkout.lifecycle === 'removed' || checkout.lifecycle === 'archived'
    ? checkout.lifecycle
    : 'active';
}

function normalizeCheckout(checkout: RepositoryCheckout): RepositoryCheckout {
  return { ...checkout, lifecycle: repositoryCheckoutLifecycle(checkout) };
}

function activeCheckouts(record: RepositoryRecord): RepositoryCheckout[] {
  return record.checkouts.filter((checkout) => repositoryCheckoutLifecycle(checkout) === 'active');
}

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync(resolveGitExecutable(), ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function gitTopLevel(root: string): string | undefined {
  const value = git(root, ['rev-parse', '--show-toplevel']);
  if (!value) return undefined;
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function gitCommonDirectory(root: string): string | undefined {
  const value = git(root, ['rev-parse', '--git-common-dir']);
  if (!value) return undefined;
  try {
    return realpathSync(resolve(root, value));
  } catch {
    return undefined;
  }
}

function gitDirectory(root: string): string | undefined {
  const value = git(root, ['rev-parse', '--git-dir']);
  if (!value) return undefined;
  try {
    return realpathSync(resolve(root, value));
  } catch {
    return undefined;
  }
}

function isPrimaryGitWorktree(root: string): boolean {
  const directory = gitDirectory(root);
  const common = gitCommonDirectory(root);
  return Boolean(directory && common && comparablePath(directory) === comparablePath(common));
}

export function repositoryCheckoutRootMatches(record: RepositoryRecord, root: string): boolean {
  if (!existsSync(root)) return false;
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return false;
  const checkoutTopLevel = gitTopLevel(root);
  if (!checkoutTopLevel || comparablePath(checkoutTopLevel) !== comparablePath(root)) return false;
  const repositoryCommon = gitCommonDirectory(record.canonicalRoot);
  const checkoutCommon = gitCommonDirectory(root);
  return Boolean(repositoryCommon && checkoutCommon && comparablePath(repositoryCommon) === comparablePath(checkoutCommon));
}

function repositoryByGitCommonDirectory(records: RepositoryRecord[], root: string): RepositoryRecord | undefined {
  const checkoutCommon = gitCommonDirectory(root);
  if (!checkoutCommon) return undefined;
  const comparableCommon = comparablePath(checkoutCommon);
  let linkedWorktreeFallback: RepositoryRecord | undefined;
  let historicalCheckoutFallback: RepositoryRecord | undefined;
  for (const record of records) {
    if (record.enabled === false || record.removedAt) continue;
    // Multiple historical Repository records may point at linked/detached
    // worktrees from the same Git repository. Prefer the record whose canonical
    // root is the primary worktree; a linked-worktree canonical record is only a
    // compatibility fallback and must not steal new worktrees from that primary.
    if (record.canonicalRoot && existsSync(record.canonicalRoot)) {
      const canonicalCommon = gitCommonDirectory(record.canonicalRoot);
      if (canonicalCommon && comparablePath(canonicalCommon) === comparableCommon) {
        if (isPrimaryGitWorktree(record.canonicalRoot)) return record;
        linkedWorktreeFallback ??= record;
        continue;
      }
      if (canonicalCommon) continue;
    }
    const fallbackRoots = Array.from(new Set(record.checkouts.map((checkout) => checkout.canonicalRoot)));
    for (const candidateRoot of fallbackRoots) {
      if (!candidateRoot || !existsSync(candidateRoot)) continue;
      const common = gitCommonDirectory(candidateRoot);
      if (common && comparablePath(common) === comparableCommon) {
        historicalCheckoutFallback ??= record;
        break;
      }
    }
  }
  return linkedWorktreeFallback ?? historicalCheckoutFallback;
}

/**
 * Resolve an already-registered repository from one concrete checkout root
 * without mutating Repository Registry state. Exact canonical/active-checkout
 * matches stay filesystem-only; Git common-directory probing is a bounded
 * compatibility fallback for linked worktrees that predate checkout tracking.
 */
export function findRegisteredRepositoryByCheckoutRoot(
  root: string,
  controllerHome?: string,
): RepositoryRecord | undefined {
  const candidateRoot = resolve(root);
  const records = listRepositories(controllerHome).filter((record) => record.enabled !== false && !record.removedAt);
  const exact = records.find((record) => (
    comparablePath(record.canonicalRoot) === comparablePath(candidateRoot)
    || activeCheckouts(record).some((checkout) => comparablePath(checkout.canonicalRoot) === comparablePath(candidateRoot))
  ));
  return exact ?? repositoryByGitCommonDirectory(records, candidateRoot);
}

function managedCheckoutMatchesRepository(record: RepositoryRecord, checkout: RepositoryCheckout): boolean {
  return repositoryCheckoutRootMatches(record, checkout.canonicalRoot);
}

function registryHome(controllerHome?: string): string {
  return durableControllerHome(controllerHome);
}

function ensureRegistryHome(controllerHome?: string): string {
  return ensureControllerHome(registryHome(controllerHome));
}

function registryPath(controllerHome?: string): string {
  return join(registryHome(controllerHome), REGISTRY_FILE);
}

function focusPath(controllerHome?: string): string {
  return join(registryHome(controllerHome), FOCUS_FILE);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function defaultRegistry(): RepositoryRegistry {
  return { schemaVersion: 1, repositories: [], updatedAt: now() };
}

function normalizeRegistry(parsed: Partial<RepositoryRegistry>): RepositoryRegistry {
  return {
    schemaVersion: 1,
    repositories: Array.isArray(parsed.repositories)
      ? parsed.repositories.map((record) => ({
        ...record,
        checkouts: Array.isArray(record.checkouts) ? record.checkouts.map(normalizeCheckout) : [],
      }))
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
  };
}

function readRegistryFile(path: string, strict: boolean): RepositoryRegistry | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return normalizeRegistry(JSON.parse(readFileSync(path, 'utf-8')) as Partial<RepositoryRegistry>);
  } catch (error) {
    if (!strict) return undefined;
    throw new Error(`repository registry is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function timestampValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function preferredCheckout(left: RepositoryCheckout, right: RepositoryCheckout): RepositoryCheckout {
  const leftTime = timestampValue(left.updatedAt);
  const rightTime = timestampValue(right.updatedAt);
  if (leftTime !== rightTime) return rightTime > leftTime ? right : left;
  const leftLifecycle = repositoryCheckoutLifecycle(left);
  const rightLifecycle = repositoryCheckoutLifecycle(right);
  if (leftLifecycle === 'active' && rightLifecycle !== 'active') return right;
  return left;
}

function mergeRepositorySources(
  primary: RepositoryRegistry,
  supplements: RepositoryRegistry[],
): RepositoryRegistry {
  const supplementRecords = new Map<string, RepositoryRecord[]>();
  for (const registry of supplements) {
    for (const record of registry.repositories) {
      const records = supplementRecords.get(record.repoId) ?? [];
      records.push(record);
      supplementRecords.set(record.repoId, records);
    }
  }
  const primaryRecords = new Map(primary.repositories.map((record) => [record.repoId, record]));
  const repoIds = new Set([...primaryRecords.keys(), ...supplementRecords.keys()]);
  const repositories = [...repoIds].map((repoId) => {
    const primaryRecord = primaryRecords.get(repoId);
    const legacyRecords = supplementRecords.get(repoId) ?? [];
    const base = primaryRecord ?? [...legacyRecords]
      .sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt))[0];
    if (!base) throw new Error(`repository registry merge lost record: ${repoId}`);
    const checkouts = new Map(base.checkouts.map((checkout) => [checkout.checkoutId, checkout]));
    for (const record of legacyRecords) {
      for (const checkout of record.checkouts) {
        const existing = checkouts.get(checkout.checkoutId);
        if (!existing) {
          checkouts.set(checkout.checkoutId, checkout);
          continue;
        }
        if (checkout.checkoutId === base.activeCheckoutId) continue;
        checkouts.set(checkout.checkoutId, preferredCheckout(existing, checkout));
      }
    }
    return { ...base, checkouts: [...checkouts.values()] };
  });
  const updatedAt = [primary, ...supplements]
    .map((registry) => registry.updatedAt)
    .sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? now();
  return { schemaVersion: 1, repositories, updatedAt };
}

export function loadRepositoryRegistry(controllerHome?: string): RepositoryRegistry {
  // Normal reads must use only the stable Controller Home authority. Slot-local
  // files are migration inputs, not live replicas; continuously merging them
  // can resurrect stale checkouts after a whole-Runtime replacement.
  return readRegistryFile(registryPath(controllerHome), true) ?? defaultRegistry();
}

export function saveRepositoryRegistry(registry: RepositoryRegistry, controllerHome?: string): RepositoryRegistry {
  const home = ensureControllerHome(registryHome(controllerHome));
  const next = { ...registry, schemaVersion: 1 as const, updatedAt: now() };
  atomicJson(join(home, REGISTRY_FILE), next);
  return next;
}

export function consolidateRepositoryRegistry(controllerHome?: string): RepositoryRegistry {
  return readRegistryFile(registryPath(controllerHome), true) ?? defaultRegistry();
}

function resolveGitRoot(inputPath: string): string {
  const candidate = resolve(inputPath);
  if (!existsSync(candidate)) throw new Error(`repository path does not exist: ${candidate}`);
  const topLevel = git(candidate, ['rev-parse', '--show-toplevel']);
  if (!topLevel) throw new Error(`path is not a Git repository: ${candidate}`);
  return realpathSync(topLevel);
}

function readLocalIdentity(canonicalRoot: string): { repoId?: string } {
  const path = join(canonicalRoot, LEGACY_LOCAL_CONFIG);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { repoId?: unknown };
    return typeof parsed.repoId === 'string' && parsed.repoId.trim()
      ? { repoId: parsed.repoId.trim() }
      : {};
  } catch (_error) {
    return {};
  }
}

function readLegacyGitHubPluginConfig(canonicalRoot: string): Partial<RepositoryRecord['github']> | undefined {
  const path = join(canonicalRoot, LEGACY_GITHUB_PLUGIN_CONFIG);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      enabled?: unknown;
      repository?: unknown;
      syncMode?: unknown;
      includeTasks?: unknown;
      projectOwner?: unknown;
      projectNumber?: unknown;
    };
    const repository = typeof raw.repository === 'string' && raw.repository.trim() ? raw.repository.trim() : undefined;
    const [owner, repo] = repository?.includes('/') ? repository.split('/', 2) : [undefined, undefined];
    return repository && owner && repo ? {
      owner,
      repo,
      repository,
      pluginEnabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
      syncMode: raw.syncMode === 'checkpoint' ? 'checkpoint' : 'manual',
      includeTasks: raw.includeTasks !== false,
      projectOwner: typeof raw.projectOwner === 'string' && raw.projectOwner.trim() ? raw.projectOwner.trim() : undefined,
      projectNumber: Number.isInteger(raw.projectNumber) && Number(raw.projectNumber) > 0 ? Number(raw.projectNumber) : undefined,
    } : undefined;
  } catch (_error) {
    return undefined;
  }
}

function repositoryType(root: string, remoteUrl: string | undefined): RepositoryType {
  const bare = git(root, ['rev-parse', '--is-bare-repository']);
  if (bare === 'true') return 'bare';
  return remoteUrl ? 'git' : 'local-git';
}

function defaultBranch(root: string): string | undefined {
  const originHead = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith('origin/')) return originHead.slice('origin/'.length);
  const current = git(root, ['branch', '--show-current']);
  return current || undefined;
}

function activeCheckout(record: RepositoryRecord): RepositoryCheckout {
  const available = activeCheckouts(record);
  return available.find((checkout) => checkout.checkoutId === record.activeCheckoutId)
    ?? available[0]
    ?? {
      checkoutId: record.activeCheckoutId,
      localRoot: record.localRoot,
      canonicalRoot: record.canonicalRoot,
      worktree: false,
      branch: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSeenAt: record.lastSeenAt,
      lifecycle: 'active',
    };
}

function defaultGitHubMapping(
  canonicalRemote: string | undefined,
  existing?: RepositoryRecord['github'],
  previousCanonicalRemote?: string,
  legacy?: Partial<RepositoryRecord['github']>,
): RepositoryRecord['github'] {
  const parsed = parseGitHubRemote(canonicalRemote);
  const previousParsed = parseGitHubRemote(previousCanonicalRemote);
  const legacyMapping = legacy?.owner && legacy?.repo ? {
    owner: legacy.owner,
    repo: legacy.repo,
    repository: legacy.repository ?? `${legacy.owner}/${legacy.repo}`,
    pluginEnabled: legacy.pluginEnabled ?? true,
    syncMode: legacy.syncMode ?? 'manual',
    includeTasks: legacy.includeTasks ?? true,
    labels: legacy.labels,
    projectOwner: legacy.projectOwner,
    projectNumber: legacy.projectNumber,
    issueSyncEnabled: legacy.issueSyncEnabled,
    cloudAgentSupported: legacy.cloudAgentSupported,
    authenticationCapability: legacy.authenticationCapability ?? 'unknown',
  } : undefined;
  if (!parsed) return existing ?? legacyMapping;
  const inferredRepository = `${parsed.owner}/${parsed.repo}`;
  if (!existing) {
    return {
      ...parsed,
      repository: inferredRepository,
      pluginEnabled: true,
      syncMode: 'manual',
      includeTasks: true,
      authenticationCapability: 'unknown',
    };
  }
  const previousRepository = previousParsed ? `${previousParsed.owner}/${previousParsed.repo}` : undefined;
  const existingRepository = existing.repository ?? `${existing.owner}/${existing.repo}`;
  if (previousRepository && existingRepository.toLowerCase() === previousRepository.toLowerCase()) {
    return {
      ...existing,
      ...parsed,
      repository: inferredRepository,
    };
  }
  return existing ?? legacyMapping;
}

function currentProcessOwnsRepository(record: RepositoryRecord): boolean {
  try {
    return realpathSync(process.cwd()) === realpathSync(record.canonicalRoot);
  } catch {
    return false;
  }
}

function uniqueCanonicalRecord(records: RepositoryRecord[], canonicalRoot: string): RepositoryRecord | undefined {
  const normalized = canonicalRoot.replace(/\\/g, '/');
  return records.find((record) => record.canonicalRoot.replace(/\\/g, '/') === normalized);
}

function retireCanonicalDuplicates(records: RepositoryRecord[], canonicalRoot: string, keepRepoId: string, timestamp: string): RepositoryRecord[] {
  const normalized = canonicalRoot.replace(/\\/g, '/');
  return records.map((record) => {
    if (record.repoId === keepRepoId || record.canonicalRoot.replace(/\\/g, '/') !== normalized) return record;
    if (record.removedAt) return record;
    return {
      ...record,
      enabled: false,
      disabledAt: record.disabledAt ?? timestamp,
      removedAt: record.removedAt ?? timestamp,
      updatedAt: timestamp,
    };
  });
}

export function repositorySummary(record: RepositoryRecord): RepositorySummary {
  const checkout = activeCheckout(record);
  return {
    repoId: record.repoId,
    displayName: record.displayName,
    enabled: record.enabled,
    localRoot: checkout.localRoot,
    canonicalRoot: checkout.canonicalRoot,
    checkoutId: checkout.checkoutId,
    remoteUrl: record.remoteUrl,
    github: record.github,
    defaultBranch: record.defaultBranch,
    repositoryType: record.repositoryType,
    lastSeenAt: record.lastSeenAt,
    removedAt: record.removedAt,
  };
}

export function listRepositories(controllerHome?: string, options: { includeRemoved?: boolean } = {}): RepositoryRecord[] {
  return loadRepositoryRegistry(controllerHome).repositories
    .filter((record) => options.includeRemoved === true || !record.removedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.repoId.localeCompare(b.repoId));
}

export function getRepository(repoId: string, controllerHome?: string, options: { includeRemoved?: boolean } = {}): RepositoryRecord {
  const record = loadRepositoryRegistry(controllerHome).repositories.find((candidate) => candidate.repoId === repoId);
  if (!record || (record.removedAt && options.includeRemoved !== true)) {
    throw new Error(`repository not found: ${repoId}`);
  }
  return record;
}

export function selectRepositoryCheckout(
  record: RepositoryRecord,
  checkoutId?: string,
  options: { allowArchived?: boolean } = {},
): RepositoryRecord {
  if (!checkoutId?.trim()) return record;
  const checkout = record.checkouts.find((candidate) => candidate.checkoutId === checkoutId.trim());
  if (!checkout) throw new Error(`checkout not found for ${record.repoId}: ${checkoutId}`);
  const lifecycle = repositoryCheckoutLifecycle(checkout);
  if (lifecycle !== 'active' && !(options.allowArchived === true && lifecycle === 'archived')) {
    throw new Error(`CHECKOUT_NOT_ACTIVE: ${record.repoId}/${checkout.checkoutId} is ${lifecycle}`);
  }
  return {
    ...record,
    localRoot: checkout.localRoot,
    canonicalRoot: checkout.canonicalRoot,
    activeCheckoutId: checkout.checkoutId,
  };
}

export function registerRepository(input: RegisterRepositoryInput): RepositoryRecord {
  const home = ensureRegistryHome(input.controllerHome);
  if (!input.path?.trim()) throw new Error('REPOSITORY_PATH_REQUIRED');
  const canonicalRoot = resolveGitRoot(input.path);
  registrationPathPolicy(home, canonicalRoot);
  if (input.defaultBranch && !validBranch(input.defaultBranch.trim())) throw new Error(`BRANCH_INVALID: ${input.defaultBranch}`);
  const requestedRemote = input.remoteUrl?.trim();
  const rawRemote = requestedRemote || git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  if (requestedRemote && !canonicalRemote) throw new Error(`REMOTE_URL_INVALID: ${requestedRemote}`);
  const localIdentity = readLocalIdentity(canonicalRoot);
  const legacyGitHub = readLegacyGitHubPluginConfig(canonicalRoot);
  const timestamp = now();
  const registry = loadRepositoryRegistry(home);
  const existingByRoot = uniqueCanonicalRecord(registry.repositories, canonicalRoot);
  const gitDirectory = git(canonicalRoot, ['rev-parse', '--git-dir']);
  const commonDirectory = git(canonicalRoot, ['rev-parse', '--git-common-dir']);
  const worktree = Boolean(commonDirectory && gitDirectory !== commonDirectory);
  // Historical/controller-issued repository ids are allowed to differ from the
  // later remote-derived hash. A Git worktree belongs to the repository that
  // owns the same Git common directory; equal remotes alone are not sufficient
  // because independent clones of one remote are separate checkout families.
  const existingByCommonDirectory = !existingByRoot && worktree
    ? repositoryByGitCommonDirectory(registry.repositories, canonicalRoot)
    : undefined;
  const existingIdentity = existingByRoot ?? existingByCommonDirectory;
  const derivedRepoId = input.repoIdOverride?.trim()
    || existingIdentity?.repoId
    || localIdentity.repoId
    || (canonicalRemote ? stableRemoteRepoId(canonicalRemote) : newLocalRepoId());
  const repoId = existingIdentity?.repoId ?? derivedRepoId;
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const existing = existingIdentity ?? registry.repositories.find((record) => record.repoId === repoId);
  const checkout: RepositoryCheckout = {
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree,
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    createdAt: existing?.checkouts.find((value) => value.checkoutId === checkoutId)?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lifecycle: 'active',
  };
  const restoringExisting = Boolean(existing && (existing.removedAt || existing.enabled === false));
  const enabled = input.enabled ?? (restoringExisting ? true : existing?.enabled ?? true);

  // A repository-scoped command may start from a managed checkout (for example
  // immutable release construction). Registering that path must add/update the
  // checkout only; it must never promote the ephemeral worktree to repository
  // canonical authority. Explicit activation remains available through
  // addRepositoryCheckout({ activate: true }).
  if (existing && worktree && existing.canonicalRemote && canonicalRemote !== existing.canonicalRemote) {
    throw new Error(`CHECKOUT_REPOSITORY_MISMATCH: ${canonicalRoot}`);
  }
  if (existing && worktree && existing.canonicalRoot !== canonicalRoot) {
    const next: RepositoryRecord = {
      ...existing,
      enabled,
      checkouts: [
        ...existing.checkouts.filter((value) => value.checkoutId !== checkoutId),
        checkout,
      ],
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      disabledAt: enabled ? undefined : existing.disabledAt,
      removedAt: enabled ? undefined : existing.removedAt,
    };
    const index = registry.repositories.findIndex((candidate) => candidate.repoId === existing.repoId);
    registry.repositories[index] = next;
    saveRepositoryRegistry(registry, home);
    ensureRepositoryControllerLayout(home, next.repoId);
    return selectRepositoryCheckout(next, checkoutId);
  }

  const record: RepositoryRecord = {
    schemaVersion: 1,
    repoId,
    displayName: input.displayName?.trim() || existing?.displayName || inferDisplayName(canonicalRoot, canonicalRemote),
    localRoot: canonicalRoot,
    canonicalRoot,
    activeCheckoutId: checkoutId,
    checkouts: [
      ...(existing?.checkouts.filter((value) => value.checkoutId !== checkoutId) ?? []),
      checkout,
    ],
    remoteUrl: rawRemote,
    canonicalRemote,
    github: defaultGitHubMapping(canonicalRemote, existing?.github, existing?.canonicalRemote, legacyGitHub),
    defaultBranch: input.defaultBranch?.trim() || existing?.defaultBranch || defaultBranch(canonicalRoot),
    repositoryType: input.repositoryType ?? existing?.repositoryType ?? repositoryType(canonicalRoot, rawRemote),
    enabled,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: registryPath(home),
    stateStorageStrategy: input.stateStorageStrategy ?? existing?.stateStorageStrategy ?? 'hybrid',
    disabledAt: enabled ? undefined : existing?.disabledAt,
    removedAt: enabled ? undefined : existing?.removedAt,
  };
  const retained = registry.repositories.filter((candidate) => candidate.repoId !== repoId);
  registry.repositories = [
    ...retireCanonicalDuplicates(retained, canonicalRoot, repoId, timestamp),
    record,
  ];
  saveRepositoryRegistry(registry, home);
  ensureRepositoryControllerLayout(home, repoId);
  return record;
}

/**
 * Fast path for repeat `repository_register`: when the canonical path, repo id,
 * checkout identity, and registration identity (remote / default branch /
 * display name) are unchanged, return the existing registration without any
 * legacy migration / history scan. The caller decides whether to run
 * bindRepositoryEntities (install / upgrade / explicit repair only).
 */
export function findIdenticalRepositoryRegistration(
  input: RegisterRepositoryInput,
): { repository: RepositoryRecord; identical: boolean; reasons: string[] } | undefined {
  const home = ensureRegistryHome(input.controllerHome);
  if (!input.path?.trim()) return undefined;
  const canonicalRoot = resolveGitRoot(input.path);
  const registry = loadRepositoryRegistry(home);
  const existing = uniqueCanonicalRecord(registry.repositories, canonicalRoot);
  if (!existing) return undefined;

  const reasons: string[] = [];
  if (existing.removedAt || existing.enabled === false) {
    reasons.push('registration_is_disabled_or_removed');
  }
  const checkoutId = stableCheckoutId(existing.repoId, canonicalRoot);
  if (existing.activeCheckoutId !== checkoutId) {
    reasons.push('checkout_identity_changed');
  }
  const requestedRemote = input.remoteUrl?.trim();
  const canonicalRemote = normalizeRemoteUrl(
    requestedRemote || git(canonicalRoot, ['config', '--get', 'remote.origin.url']),
  );
  if (requestedRemote && canonicalRemote && existing.canonicalRemote !== canonicalRemote) {
    reasons.push('remote_identity_changed');
  }
  if (input.defaultBranch?.trim() && existing.defaultBranch !== input.defaultBranch.trim()) {
    reasons.push('default_branch_changed');
  }
  if (input.displayName?.trim() && existing.displayName !== input.displayName.trim()) {
    reasons.push('display_name_changed');
  }
  return {
    repository: existing,
    identical: reasons.length === 0,
    reasons,
  };
}

export function addRepositoryCheckout(input: AddRepositoryCheckoutInput): RepositoryRecord {
  const home = ensureRegistryHome(input.controllerHome);
  const canonicalRoot = resolveGitRoot(input.path);
  const registry = loadRepositoryRegistry(home);
  const index = registry.repositories.findIndex((record) => record.repoId === input.repoId);
  if (index < 0) throw new Error(`repository not found: ${input.repoId}`);
  const current = registry.repositories[index];
  const rawRemote = git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  if (current.canonicalRemote && canonicalRemote !== current.canonicalRemote) {
    throw new Error(`CHECKOUT_REPOSITORY_MISMATCH: ${canonicalRoot}`);
  }
  const timestamp = now();
  const checkoutId = stableCheckoutId(current.repoId, canonicalRoot);
  const checkout: RepositoryCheckout = {
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree: Boolean(git(canonicalRoot, ['rev-parse', '--git-common-dir']) && git(canonicalRoot, ['rev-parse', '--git-dir']) !== git(canonicalRoot, ['rev-parse', '--git-common-dir'])),
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    createdAt: current.checkouts.find((value) => value.checkoutId === checkoutId)?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lifecycle: 'active',
  };
  const activate = input.activate === true;
  const next: RepositoryRecord = {
    ...current,
    ...(activate ? { localRoot: canonicalRoot, canonicalRoot, activeCheckoutId: checkoutId } : {}),
    checkouts: [...current.checkouts.filter((value) => value.checkoutId !== checkoutId), checkout],
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  registry.repositories[index] = next;
  saveRepositoryRegistry(registry, home);
  return next;
}

export function setRepositoryCheckoutLifecycle(input: SetRepositoryCheckoutLifecycleInput): RepositoryRecord {
  const home = ensureRegistryHome(input.controllerHome);
  const registry = loadRepositoryRegistry(home);
  const repositoryIndex = registry.repositories.findIndex((record) => record.repoId === input.repoId);
  if (repositoryIndex < 0) throw new Error(`repository not found: ${input.repoId}`);
  const repository = registry.repositories[repositoryIndex];
  const checkoutIndex = repository.checkouts.findIndex((checkout) => checkout.checkoutId === input.checkoutId);
  if (checkoutIndex < 0) throw new Error(`checkout not found for ${input.repoId}: ${input.checkoutId}`);
  if (input.lifecycle !== 'active' && repository.activeCheckoutId === input.checkoutId) {
    throw new Error(`CHECKOUT_ACTIVE_PROTECTED: ${input.repoId}/${input.checkoutId}`);
  }
  const timestamp = now();
  const checkout = repository.checkouts[checkoutIndex];
  const updated: RepositoryCheckout = {
    ...checkout,
    lifecycle: input.lifecycle,
    updatedAt: timestamp,
    lifecycleReason: input.lifecycle === 'active' ? undefined : input.reason?.trim() || checkout.lifecycleReason,
    removedAt: input.lifecycle === 'removed' ? checkout.removedAt ?? timestamp : undefined,
    archivedAt: input.lifecycle === 'archived' ? checkout.archivedAt ?? timestamp : undefined,
  };
  const next: RepositoryRecord = {
    ...repository,
    checkouts: repository.checkouts.map((candidate, index) => index === checkoutIndex ? updated : candidate),
    updatedAt: timestamp,
  };
  registry.repositories[repositoryIndex] = next;
  saveRepositoryRegistry(registry, home);
  return next;
}

export function reconcileRepositoryCheckouts(repoId: string, controllerHome?: string): ReconcileRepositoryCheckoutsResult {
  const home = ensureRegistryHome(controllerHome);
  const registry = loadRepositoryRegistry(home);
  const repositoryIndex = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (repositoryIndex < 0) throw new Error(`repository not found: ${repoId}`);
  const repository = registry.repositories[repositoryIndex];
  const timestamp = now();
  const archivedCheckoutIds: string[] = [];
  const checkouts = repository.checkouts.map((checkout) => {
    if (
      checkout.checkoutId === repository.activeCheckoutId
      || !checkout.worktree
      || repositoryCheckoutLifecycle(checkout) !== 'active'
    ) return checkout;
    const rootExists = existsSync(checkout.canonicalRoot);
    if (rootExists && managedCheckoutMatchesRepository(repository, checkout)) return checkout;
    archivedCheckoutIds.push(checkout.checkoutId);
    return {
      ...checkout,
      lifecycle: 'archived' as const,
      archivedAt: timestamp,
      removedAt: undefined,
      lifecycleReason: rootExists
        ? 'Managed checkout is no longer a valid Git worktree for this repository.'
        : 'Managed worktree root no longer exists.',
      updatedAt: timestamp,
    };
  });
  if (archivedCheckoutIds.length === 0) return { repository, archivedCheckoutIds };
  const next: RepositoryRecord = { ...repository, checkouts, updatedAt: timestamp };
  registry.repositories[repositoryIndex] = next;
  saveRepositoryRegistry(registry, home);
  return { repository: next, archivedCheckoutIds };
}

export function updateRepository(repoId: string, patch: UpdateRepositoryInput, controllerHome?: string): RepositoryRecord {
  if (patch.defaultBranch && !validBranch(patch.defaultBranch.trim())) throw new Error(`BRANCH_INVALID: ${patch.defaultBranch}`);
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const previous = registry.repositories[index];
  const enabled = patch.enabled ?? previous.enabled;
  const restoring = previous.enabled === false && patch.enabled === true;
  const next: RepositoryRecord = {
    ...previous,
    ...patch,
    displayName: patch.displayName?.trim() || previous.displayName,
    defaultBranch: patch.defaultBranch?.trim() || previous.defaultBranch,
    enabled,
    disabledAt: enabled ? undefined : previous.disabledAt ?? now(),
    removedAt: restoring ? previous.removedAt : enabled ? undefined : previous.removedAt,
    github: patch.github ?? previous.github,
    updatedAt: now(),
  };
  registry.repositories[index] = next;
  saveRepositoryRegistry(registry, controllerHome);
  return next;
}

export function disableRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const record = getRepository(repoId, controllerHome, { includeRemoved: true });
  if (currentProcessOwnsRepository(record)) throw new Error(`REPOSITORY_SELF_PROTECTED: ${repoId}`);
  return updateRepository(repoId, { enabled: false }, controllerHome);
}

export function removeRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  if (currentProcessOwnsRepository(registry.repositories[index])) throw new Error(`REPOSITORY_SELF_PROTECTED: ${repoId}`);
  const timestamp = now();
  registry.repositories[index] = {
    ...registry.repositories[index],
    enabled: false,
    disabledAt: registry.repositories[index].disabledAt ?? timestamp,
    removedAt: timestamp,
    updatedAt: timestamp,
  };
  saveRepositoryRegistry(registry, controllerHome);
  return registry.repositories[index];
}

export function purgeRepository(repoId: string, controllerHome?: string): void {
  const home = registryHome(controllerHome);
  const registry = loadRepositoryRegistry(home);
  registry.repositories = registry.repositories.filter((record) => record.repoId !== repoId);
  saveRepositoryRegistry(registry, home);
  rmSync(join(home, 'repositories', repoId), { recursive: true, force: true });
}

export function validateRepository(repoId: string, controllerHome?: string): RepositoryValidation {
  const record = getRepository(repoId, controllerHome, { includeRemoved: true });
  const checkout = activeCheckout(record);
  const errors: string[] = [];
  const warnings: string[] = [];
  const rootExists = existsSync(checkout.canonicalRoot);
  const canonicalRoot = rootExists ? realpathSync(checkout.canonicalRoot) : checkout.canonicalRoot;
  const gitRepository = rootExists && Boolean(git(canonicalRoot, ['rev-parse', '--show-toplevel']));
  const remoteUrl = gitRepository ? git(canonicalRoot, ['config', '--get', 'remote.origin.url']) : undefined;
  const canonicalRemote = normalizeRemoteUrl(remoteUrl);
  const identityMatches = record.canonicalRemote
    ? canonicalRemote === record.canonicalRemote
    : rootExists && canonicalRoot === checkout.canonicalRoot;
  const githubRemote = parseGitHubRemote(canonicalRemote);
  const githubRemoteRepository = githubRemote ? `${githubRemote.owner}/${githubRemote.repo}` : undefined;
  const githubMappingMatches = !record.github || !githubRemoteRepository
    ? undefined
    : record.github.owner.toLowerCase() === githubRemote!.owner.toLowerCase() &&
      record.github.repo.toLowerCase() === githubRemote!.repo.toLowerCase();
  if (!rootExists) errors.push('checkout root does not exist');
  if (rootExists && !gitRepository) errors.push('checkout root is no longer a Git repository');
  if (gitRepository && !identityMatches) errors.push('repository identity does not match the registry record');
  if (record.canonicalRemote && canonicalRemote && record.canonicalRemote !== canonicalRemote) {
    warnings.push(`Git origin ${canonicalRemote} differs from registry remote ${record.canonicalRemote}; repoId remains stable until explicitly remapped`);
  }
  if (githubMappingMatches === false) {
    warnings.push(`GitHub plugin mapping ${record.github?.owner}/${record.github?.repo} differs from Git origin ${githubRemoteRepository}; mapping was not changed automatically`);
  }
  if (!record.enabled) warnings.push('repository is disabled');
  if (record.removedAt) warnings.push('repository was removed and is retained for audit only');
  return {
    repoId,
    checkoutId: checkout.checkoutId,
    ok: errors.length === 0,
    rootExists,
    gitRepository,
    identityMatches,
    canonicalRoot,
    canonicalRemote,
    registryCanonicalRemote: record.canonicalRemote,
    githubRemoteRepository,
    githubMappingMatches,
    errors,
    warnings,
    checkedAt: now(),
  };
}

export function refreshRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const home = ensureRegistryHome(controllerHome);
  const registry = loadRepositoryRegistry(home);
  const index = registry.repositories.findIndex((candidate) => candidate.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const record = registry.repositories[index];
  const checkout = activeCheckout(record);
  const canonicalRoot = resolveGitRoot(checkout.canonicalRoot);
  const rawRemote = git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const timestamp = now();
  const refreshedCheckout: RepositoryCheckout = {
    ...checkout,
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree: Boolean(git(canonicalRoot, ['rev-parse', '--git-common-dir']) && git(canonicalRoot, ['rev-parse', '--git-dir']) !== git(canonicalRoot, ['rev-parse', '--git-common-dir'])),
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lifecycle: 'active',
    removedAt: undefined,
    archivedAt: undefined,
    lifecycleReason: undefined,
  };
  const refreshed: RepositoryRecord = {
    ...record,
    localRoot: canonicalRoot,
    canonicalRoot,
    activeCheckoutId: checkoutId,
    checkouts: [
      ...record.checkouts.filter((candidate) => candidate.checkoutId !== checkout.checkoutId && candidate.checkoutId !== checkoutId),
      refreshedCheckout,
    ],
    remoteUrl: rawRemote,
    canonicalRemote,
    github: defaultGitHubMapping(canonicalRemote, record.github, record.canonicalRemote, readLegacyGitHubPluginConfig(canonicalRoot)),
    defaultBranch: defaultBranch(canonicalRoot) ?? record.defaultBranch,
    repositoryType: repositoryType(canonicalRoot, rawRemote),
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: registryPath(home),
  };
  registry.repositories[index] = refreshed;
  registry.repositories = retireCanonicalDuplicates(registry.repositories, canonicalRoot, repoId, timestamp);
  saveRepositoryRegistry(registry, home);
  ensureRepositoryControllerLayout(home, repoId);
  return refreshed;
}

export function focusRepository(repoId: string | undefined, controllerHome?: string): { repoId?: string; updatedAt: string } {
  const home = ensureRegistryHome(controllerHome);
  if (repoId) getRepository(repoId, home);
  const value = { repoId, updatedAt: now() };
  atomicJson(focusPath(home), value);
  return value;
}

export function getRepositoryFocus(controllerHome?: string): { repoId?: string; updatedAt?: string } {
  const stablePath = focusPath(controllerHome);
  if (existsSync(stablePath)) {
    try {
      return JSON.parse(readFileSync(stablePath, 'utf-8')) as { repoId?: string; updatedAt?: string };
    } catch {
      // Fail closed instead of reviving a newer-looking slot-local focus record.
      return {};
    }
  }
  return {};
}

export function resolveRepositorySelection(input: {
  repoId?: string;
  checkoutId?: string;
  explicitPath?: string;
  controllerHome?: string;
  allowSoleRepository?: boolean;
  allowDisabledReason?: 'restore';
}): RepositoryRecord {
  if (input.repoId?.trim()) {
    const record = getRepository(input.repoId.trim(), input.controllerHome);
    if (!record.enabled) {
      const allowRestore = input.allowDisabledReason === 'restore';
      if (!allowRestore) throw new Error(`repository is disabled: ${record.repoId}`);
    }
    // An explicit repoId + checkoutId is a complete invocation identity.
    // explicitPath is the MCP server's default repository context; allowing it
    // to veto a named checkout makes every non-default worktree drift back to
    // the server startup path. Checkout registration, lifecycle, and Git
    // boundary validation remain enforced by selectRepositoryCheckout.
    return selectRepositoryCheckout(record, input.checkoutId);
  }
  if (input.explicitPath?.trim()) {
    return selectRepositoryCheckout(registerRepository({ path: input.explicitPath, controllerHome: input.controllerHome }), input.checkoutId);
  }
  const enabled = listRepositories(input.controllerHome).filter((record) => record.enabled);
  if (input.allowSoleRepository !== false && enabled.length === 1) return selectRepositoryCheckout(enabled[0], input.checkoutId);
  if (enabled.length === 0) {
    throw new Error('REPOSITORY_REQUIRED: no enabled repository is registered; pass repoId or register a repository');
  }
  throw new Error(`REPOSITORY_AMBIGUOUS: ${enabled.length} enabled repositories are registered; pass repoId explicitly`);
}
