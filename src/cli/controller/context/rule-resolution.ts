import { closeSync, openSync, readSync, statSync } from 'fs';
import { extname, resolve } from 'path';
import { globMatches } from '../../mcp/paths';
import type { McpPolicy } from '../../mcp/types';
import { readableFile } from './known-paths';

export const GOVERNANCE_RULES_PATH = '.ai/context/governance-rules.json';
export const GOVERNANCE_EXCEPTIONS_PATH = '.ai/context/governance-exceptions.json';
export const GOVERNANCE_MAX_RULES = 256;
export const GOVERNANCE_MAX_EXCEPTIONS = 256;
export const GOVERNANCE_MAX_CONFIG_BYTES = 256 * 1024;
export const GOVERNANCE_MAX_SOURCE_FILES = 24;
export const GOVERNANCE_MAX_SOURCE_BYTES = 512 * 1024;
export const GOVERNANCE_MAX_SOURCE_BYTES_PER_FILE = 64 * 1024;

export type GovernanceRuleLevel = 'kernel' | 'capability' | 'platform' | 'project';
export type GovernanceRuleLifecycle = 'draft' | 'active' | 'deprecated' | 'superseded' | 'removed';
export type GovernanceRuleSeverity = 'info' | 'warning' | 'error';
export type GovernanceActivationMatch = 'all' | 'any';

export interface GovernanceRuleActivation {
  match: GovernanceActivationMatch;
  paths: string[];
  extensions: string[];
  symbols: string[];
  text: string[];
  goalTerms: string[];
}

export interface GovernanceRule {
  id: string;
  title: string;
  level: GovernanceRuleLevel;
  lifecycle: GovernanceRuleLifecycle;
  severity: GovernanceRuleSeverity;
  invariant: string;
  owner?: string;
  version?: number;
  supersedes: string[];
  activation: GovernanceRuleActivation;
  validation: { checkIds: string[] };
}

export interface GovernanceException {
  id: string;
  ruleId: string;
  paths: string[];
  reason: string;
  owner?: string;
  expiresAt?: string;
  status: 'active' | 'revoked';
}

export interface GovernanceRuleActivationEvidence {
  id: string;
  title: string;
  level: GovernanceRuleLevel;
  severity: GovernanceRuleSeverity;
  invariant: string;
  owner?: string;
  version?: number;
  matchedPaths: string[];
  matchedSignals: string[];
  checkIds: string[];
  partialExceptionIds: string[];
  suppressedPaths: string[];
}

export interface GovernanceSuppressedRule extends GovernanceRuleActivationEvidence {
  exceptionIds: string[];
}

export interface RepositoryGovernanceResolution {
  status: 'none' | 'ready' | 'degraded';
  authority: 'repository_rule_registry';
  registry: { rulesPath: string; exceptionsPath: string };
  activeRules: GovernanceRuleActivationEvidence[];
  suppressedRules: GovernanceSuppressedRule[];
  recommendedCheckIds: string[];
  expiredExceptionIds: string[];
  coverageGaps: string[];
  metrics: {
    rulesLoaded: number;
    rulesEvaluated: number;
    exceptionsLoaded: number;
    filesScanned: number;
    bytesScanned: number;
    elapsedMs: number;
  };
}

interface GovernanceResolutionInput {
  goal?: string;
  targetPaths?: string[];
  changedPaths?: string[];
  now?: Date;
}

interface BoundedReadResult {
  status: 'ok' | 'missing' | 'denied' | 'too_large' | 'failed';
  content?: string;
  bytes?: number;
  truncated?: boolean;
  reason?: string;
}

function cleanStrings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))].slice(0, max);
}

function cleanRepoPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.split('/').some((part) => part === '..')) return undefined;
  return normalized;
}

function cleanRepoPaths(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).flatMap((value) => {
    const clean = cleanRepoPath(value);
    return clean ? [clean] : [];
  }))].sort();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function normalizeRule(value: unknown, index: number, gaps: string[]): GovernanceRule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    gaps.push(`governance_rule_invalid:${index}`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const invariant = typeof raw.invariant === 'string' ? raw.invariant.trim() : '';
  if (!id || !title || !invariant) {
    gaps.push(`governance_rule_missing_required_fields:${id || index}`);
    return undefined;
  }
  const activationRaw = raw.activation && typeof raw.activation === 'object' && !Array.isArray(raw.activation)
    ? raw.activation as Record<string, unknown>
    : {};
  const validationRaw = raw.validation && typeof raw.validation === 'object' && !Array.isArray(raw.validation)
    ? raw.validation as Record<string, unknown>
    : {};
  const extensions = cleanStrings(activationRaw.extensions).map((entry) => entry.startsWith('.') ? entry.toLowerCase() : `.${entry.toLowerCase()}`);
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version > 0 ? Math.trunc(raw.version) : undefined;
  const enumChecks: Array<[string, unknown, readonly string[]]> = [
    ['level', raw.level, ['kernel', 'capability', 'platform', 'project']],
    ['lifecycle', raw.lifecycle, ['draft', 'active', 'deprecated', 'superseded', 'removed']],
    ['severity', raw.severity, ['info', 'warning', 'error']],
    ['activation.match', activationRaw.match, ['all', 'any']],
  ];
  for (const [field, candidate, allowed] of enumChecks) {
    if (candidate !== undefined && (typeof candidate !== 'string' || !allowed.includes(candidate))) {
      gaps.push(`governance_rule_invalid_${field.replace('.', '_')}:${id}`);
      return undefined;
    }
  }
  return {
    id,
    title,
    level: enumValue(raw.level, ['kernel', 'capability', 'platform', 'project'] as const, 'project'),
    lifecycle: enumValue(raw.lifecycle, ['draft', 'active', 'deprecated', 'superseded', 'removed'] as const, 'active'),
    severity: enumValue(raw.severity, ['info', 'warning', 'error'] as const, 'warning'),
    invariant,
    ...(typeof raw.owner === 'string' && raw.owner.trim() ? { owner: raw.owner.trim() } : {}),
    ...(version ? { version } : {}),
    supersedes: cleanStrings(raw.supersedes),
    activation: {
      match: enumValue(activationRaw.match, ['all', 'any'] as const, 'all'),
      paths: cleanStrings(activationRaw.paths),
      extensions,
      symbols: cleanStrings(activationRaw.symbols),
      text: cleanStrings(activationRaw.text),
      goalTerms: cleanStrings(activationRaw.goalTerms),
    },
    validation: { checkIds: cleanStrings(validationRaw.checkIds ?? validationRaw.check_ids) },
  };
}

function normalizeException(value: unknown, index: number, gaps: string[]): GovernanceException | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    gaps.push(`governance_exception_invalid:${index}`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const ruleId = typeof raw.ruleId === 'string' ? raw.ruleId.trim() : typeof raw.rule_id === 'string' ? raw.rule_id.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!id || !ruleId || !reason) {
    gaps.push(`governance_exception_missing_required_fields:${id || index}`);
    return undefined;
  }
  const expiresAt = typeof raw.expiresAt === 'string' && raw.expiresAt.trim()
    ? raw.expiresAt.trim()
    : typeof raw.expires_at === 'string' && raw.expires_at.trim()
      ? raw.expires_at.trim()
      : undefined;
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    gaps.push(`governance_exception_invalid_expiry:${id}`);
    return undefined;
  }
  if (raw.status !== undefined && (typeof raw.status !== 'string' || !['active', 'revoked'].includes(raw.status))) {
    gaps.push(`governance_exception_invalid_status:${id}`);
    return undefined;
  }
  return {
    id,
    ruleId,
    paths: cleanStrings(raw.paths),
    reason,
    ...(typeof raw.owner === 'string' && raw.owner.trim() ? { owner: raw.owner.trim() } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    status: enumValue(raw.status, ['active', 'revoked'] as const, 'active'),
  };
}

function readBoundedRepositoryFile(
  repoRoot: string,
  policy: McpPolicy,
  path: string,
  maxBytes: number,
  allowTruncate = false,
): BoundedReadResult {
  const readable = readableFile(repoRoot, policy, path);
  if (!readable.ok) {
    return readable.reason.startsWith('path does not exist')
      ? { status: 'missing', reason: readable.reason }
      : { status: 'denied', reason: readable.reason };
  }
  const absolute = resolve(repoRoot, readable.path);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return { status: 'failed', reason: 'not a regular file' };
    const truncated = stat.size > maxBytes;
    if (truncated && !allowTruncate) return { status: 'too_large', bytes: stat.size, reason: `file exceeds ${maxBytes} bytes` };
    const length = Math.max(0, Math.min(stat.size, maxBytes));
    const buffer = Buffer.alloc(length);
    const fd = openSync(absolute, 'r');
    try {
      const bytes = length > 0 ? readSync(fd, buffer, 0, length, 0) : 0;
      return { status: 'ok', content: buffer.subarray(0, bytes).toString('utf8'), bytes, truncated };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseRegistry<T>(
  repoRoot: string,
  policy: McpPolicy,
  path: string,
  key: 'rules' | 'exceptions',
  cap: number,
  normalize: (value: unknown, index: number, gaps: string[]) => T | undefined,
  gaps: string[],
): { found: boolean; values: T[] } {
  const read = readBoundedRepositoryFile(repoRoot, policy, path, GOVERNANCE_MAX_CONFIG_BYTES);
  if (read.status === 'missing') return { found: false, values: [] };
  if (read.status !== 'ok') {
    gaps.push(`governance_registry_${read.status}:${path}${read.reason ? `:${read.reason}` : ''}`);
    return { found: true, values: [] };
  }
  try {
    const parsed = JSON.parse(read.content ?? '{}') as Record<string, unknown>;
    const list = Array.isArray(parsed[key]) ? parsed[key] : undefined;
    if (!list) {
      gaps.push(`governance_registry_missing_array:${path}:${key}`);
      return { found: true, values: [] };
    }
    if (list.length > cap) gaps.push(`governance_registry_truncated:${path}:${list.length - cap}`);
    return {
      found: true,
      values: list.slice(0, cap).flatMap((entry, index) => {
        const normalized = normalize(entry, index, gaps);
        return normalized ? [normalized] : [];
      }),
    };
  } catch (error) {
    gaps.push(`governance_registry_invalid_json:${path}:${error instanceof Error ? error.message : String(error)}`);
    return { found: true, values: [] };
  }
}

function uniqueById<T extends { id: string }>(values: T[], kind: 'rule' | 'exception', gaps: string[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    if (seen.has(value.id)) {
      gaps.push(`governance_duplicate_${kind}_id:${value.id}`);
      continue;
    }
    seen.add(value.id);
    unique.push(value);
  }
  return unique;
}

function pathMatches(globs: readonly string[], path: string): boolean {
  return globs.length === 0 || globs.some((glob) => globMatches(glob, path));
}

function exceptionExpired(exception: GovernanceException, nowMs: number): boolean {
  if (!exception.expiresAt) return false;
  const expiresAt = Date.parse(exception.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

export function resolveRepositoryGovernance(
  repoRoot: string,
  policy: McpPolicy,
  input: GovernanceResolutionInput = {},
): RepositoryGovernanceResolution {
  const startedAt = performance.now();
  const coverageGaps: string[] = [];
  const rulesRegistry = parseRegistry(
    repoRoot,
    policy,
    GOVERNANCE_RULES_PATH,
    'rules',
    GOVERNANCE_MAX_RULES,
    normalizeRule,
    coverageGaps,
  );
  const base = {
    authority: 'repository_rule_registry' as const,
    registry: { rulesPath: GOVERNANCE_RULES_PATH, exceptionsPath: GOVERNANCE_EXCEPTIONS_PATH },
  };
  if (!rulesRegistry.found) {
    return {
      ...base,
      status: coverageGaps.length > 0 ? 'degraded' : 'none',
      activeRules: [],
      suppressedRules: [],
      recommendedCheckIds: [],
      expiredExceptionIds: [],
      coverageGaps,
      metrics: {
        rulesLoaded: 0,
        rulesEvaluated: 0,
        exceptionsLoaded: 0,
        filesScanned: 0,
        bytesScanned: 0,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
    };
  }

  const exceptionsRegistry = parseRegistry(
    repoRoot,
    policy,
    GOVERNANCE_EXCEPTIONS_PATH,
    'exceptions',
    GOVERNANCE_MAX_EXCEPTIONS,
    normalizeException,
    coverageGaps,
  );
  const rules = uniqueById(rulesRegistry.values, 'rule', coverageGaps);
  const exceptions = uniqueById(exceptionsRegistry.values, 'exception', coverageGaps);
  const targetPaths = cleanRepoPaths([...(input.targetPaths ?? []), ...(input.changedPaths ?? [])]);
  const goal = (input.goal ?? '').toLowerCase();
  const nowMs = (input.now ?? new Date()).getTime();
  const activeExceptions = exceptions.filter((entry) => entry.status === 'active');
  const expiredExceptionIds = activeExceptions.filter((entry) => exceptionExpired(entry, nowMs)).map((entry) => entry.id).sort();
  const validExceptions = activeExceptions.filter((entry) => !exceptionExpired(entry, nowMs));
  const sourceCache = new Map<string, string | undefined>();
  let filesScanned = 0;
  let bytesScanned = 0;
  let sourceBudgetReported = false;

  const sourceForPath = (path: string): string | undefined => {
    if (sourceCache.has(path)) return sourceCache.get(path);
    if (filesScanned >= GOVERNANCE_MAX_SOURCE_FILES || bytesScanned >= GOVERNANCE_MAX_SOURCE_BYTES) {
      if (!sourceBudgetReported) {
        coverageGaps.push('governance_source_scan_budget_reached');
        sourceBudgetReported = true;
      }
      sourceCache.set(path, undefined);
      return undefined;
    }
    const remaining = Math.max(0, GOVERNANCE_MAX_SOURCE_BYTES - bytesScanned);
    const maxBytes = Math.min(GOVERNANCE_MAX_SOURCE_BYTES_PER_FILE, remaining);
    if (maxBytes <= 0) {
      if (!sourceBudgetReported) {
        coverageGaps.push('governance_source_scan_budget_reached');
        sourceBudgetReported = true;
      }
      sourceCache.set(path, undefined);
      return undefined;
    }
    const read = readBoundedRepositoryFile(repoRoot, policy, path, maxBytes, true);
    if (read.status !== 'ok') {
      if (!['missing'].includes(read.status)) coverageGaps.push(`governance_source_${read.status}:${path}`);
      sourceCache.set(path, undefined);
      return undefined;
    }
    filesScanned += 1;
    bytesScanned += read.bytes ?? 0;
    if (read.truncated) coverageGaps.push(`governance_source_truncated:${path}`);
    sourceCache.set(path, read.content ?? '');
    return read.content ?? '';
  };

  const activeRules: GovernanceRuleActivationEvidence[] = [];
  const suppressedRules: GovernanceSuppressedRule[] = [];
  let rulesEvaluated = 0;
  for (const rule of rules) {
    if (rule.lifecycle !== 'active') continue;
    rulesEvaluated += 1;
    const activation = rule.activation;
    const hasLocalCriteria = activation.paths.length > 0
      || activation.extensions.length > 0
      || activation.symbols.length > 0
      || activation.text.length > 0;
    const hasGoalCriteria = activation.goalTerms.length > 0;
    const matchedGoalTerms = activation.goalTerms.filter((term) => goal.includes(term.toLowerCase()));
    const goalMatched = matchedGoalTerms.length > 0;
    const matchedSignals: string[] = matchedGoalTerms.map((term) => `goal:${term}`);
    const matchedPaths = new Set<string>();

    for (const path of targetPaths) {
      const localSignals: string[] = [];
      const localKindMatches: boolean[] = [];
      const pathMatched = pathMatches(activation.paths, path);
      if (activation.paths.length > 0) {
        localKindMatches.push(pathMatched);
        if (pathMatched) {
          const glob = activation.paths.find((candidate) => globMatches(candidate, path));
          localSignals.push(`path:${glob ?? '*'}:${path}`);
        }
      }
      const extension = extname(path).toLowerCase();
      const extensionMatched = activation.extensions.length === 0 || activation.extensions.includes(extension);
      if (activation.extensions.length > 0) {
        localKindMatches.push(extensionMatched);
        if (extensionMatched) localSignals.push(`extension:${extension}:${path}`);
      }

      const sourcePrerequisitesMatched = activation.match === 'any'
        || ((activation.paths.length === 0 || pathMatched) && (activation.extensions.length === 0 || extensionMatched));
      let source: string | undefined;
      if (sourcePrerequisitesMatched && (activation.symbols.length > 0 || activation.text.length > 0)) {
        source = sourceForPath(path);
      }
      if (activation.symbols.length > 0) {
        const matchingSymbols = source === undefined ? [] : activation.symbols.filter((symbol) => source!.includes(symbol));
        localKindMatches.push(matchingSymbols.length > 0);
        for (const symbol of matchingSymbols) localSignals.push(`symbol:${symbol}:${path}`);
      }
      if (activation.text.length > 0) {
        const matchingText = source === undefined ? [] : activation.text.filter((text) => source!.includes(text));
        localKindMatches.push(matchingText.length > 0);
        for (const text of matchingText) localSignals.push(`text:${text}:${path}`);
      }

      const localMatched = localKindMatches.length > 0 && (
        activation.match === 'all'
          ? localKindMatches.every(Boolean)
          : localKindMatches.some(Boolean)
      );
      if (!localMatched) continue;
      matchedPaths.add(path);
      matchedSignals.push(...localSignals);
    }

    const matches = !hasLocalCriteria && !hasGoalCriteria
      ? true
      : activation.match === 'any'
        ? goalMatched || matchedPaths.size > 0
        : (!hasGoalCriteria || goalMatched) && (!hasLocalCriteria || matchedPaths.size > 0);
    if (!matches) continue;

    const ruleExceptions = validExceptions.filter((entry) => entry.ruleId === rule.id);
    const globalExceptions = ruleExceptions.filter((entry) => entry.paths.length === 0);
    const evidencePaths = [...matchedPaths].sort();
    const scopedSuppressedPaths = evidencePaths.filter((path) => ruleExceptions.some((entry) => entry.paths.length > 0 && pathMatches(entry.paths, path)));
    const scopedExceptionIds = ruleExceptions
      .filter((entry) => entry.paths.length > 0 && scopedSuppressedPaths.some((path) => pathMatches(entry.paths, path)))
      .map((entry) => entry.id);
    const fullyScopedSuppressed = evidencePaths.length > 0 && scopedSuppressedPaths.length === evidencePaths.length;
    const common: GovernanceRuleActivationEvidence = {
      id: rule.id,
      title: rule.title,
      level: rule.level,
      severity: rule.severity,
      invariant: rule.invariant,
      ...(rule.owner ? { owner: rule.owner } : {}),
      ...(rule.version ? { version: rule.version } : {}),
      matchedPaths: evidencePaths.filter((path) => !scopedSuppressedPaths.includes(path)),
      matchedSignals: [...new Set(matchedSignals)].sort(),
      checkIds: rule.validation.checkIds,
      partialExceptionIds: fullyScopedSuppressed || globalExceptions.length > 0 ? [] : [...new Set(scopedExceptionIds)].sort(),
      suppressedPaths: scopedSuppressedPaths,
    };
    if (globalExceptions.length > 0 || fullyScopedSuppressed) {
      suppressedRules.push({
        ...common,
        exceptionIds: [...new Set([...globalExceptions.map((entry) => entry.id), ...scopedExceptionIds])].sort(),
      });
      continue;
    }
    activeRules.push(common);
  }

  const recommendedCheckIds = [...new Set(activeRules.flatMap((rule) => rule.checkIds))].sort();
  const uniqueGaps = [...new Set(coverageGaps)].slice(0, 80);
  return {
    ...base,
    status: uniqueGaps.length > 0 ? 'degraded' : 'ready',
    activeRules: activeRules.sort((a, b) => a.id.localeCompare(b.id)),
    suppressedRules: suppressedRules.sort((a, b) => a.id.localeCompare(b.id)),
    recommendedCheckIds,
    expiredExceptionIds,
    coverageGaps: uniqueGaps,
    metrics: {
      rulesLoaded: rules.length,
      rulesEvaluated,
      exceptionsLoaded: exceptions.length,
      filesScanned,
      bytesScanned,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    },
  };
}
