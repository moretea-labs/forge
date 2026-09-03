import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { basename, extname, join } from 'path';
import type {
  ContextClosureReceipt,
  ContextClosureSemanticToolResolution,
  ContextClosureSkillResolution,
  ProjectEngineeringContract,
} from '../../../packages/kernel/work/api/index';
import { loadProjectEngineeringContract } from './project-engineering-contract';

const MAX_CLOSURE_PATHS = 48;
const MAX_RECENT_CHANGES = 6;
const MATERIAL_SEMANTIC_INTENT = /\b(architecture|ownership|protocol|cross[- ]?file|refactor|interface|contract|persistence|concurrency|lifecycle|writer|transaction)\b/i;

type ContextPackLike = {
  schemaVersion: number;
  generatedAt: string;
  git: { branch: string | null; dirty: boolean };
  instructionContext: { status: 'none' | 'ready' | 'degraded'; contracts: Array<{ path: string }> };
  structuralContext: { status: 'disabled' | 'ready' | 'stale' | 'unavailable' | 'degraded' };
  readiness: { sourceRevision: string | null; rawSource: { status: 'current' | 'partial' | 'unavailable' }; status: 'ready' | 'degraded' | 'insufficient'; unresolvedReasonCodes: string[] };
  files: Array<{ path: string }>;
  coverage: { relevantTests: string[]; inspectedFiles: string[] };
};

type SemanticNavigationLike = {
  requested: number;
  results: unknown[];
  errors: Array<{ code?: unknown; message?: unknown }>;
  freshness?: string;
};

export interface BuildContextClosureInput {
  repoRoot: string;
  query: string;
  pack: ContextPackLike;
  semanticNavigation: SemanticNavigationLike;
  semanticProviders: Array<{ id: string; languages: readonly string[] }>;
  workId?: string;
  activeWorkIds?: string[];
  includeRecentChanges?: boolean;
}

function unique(values: Iterable<string>, limit = 64): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function detectedLanguages(repoRoot: string, paths: string[]): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) values.add('typescript');
    else if (ext === '.swift') values.add('swift');
    else if (ext === '.rs') values.add('rust');
    else if (ext === '.go') values.add('go');
    else if (['.py', '.pyi'].includes(ext)) values.add('python');
    else if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(ext)) values.add('cpp');
  }
  if (existsSync(join(repoRoot, 'tsconfig.json')) || existsSync(join(repoRoot, 'package.json'))) values.add('typescript');
  if (existsSync(join(repoRoot, 'Package.swift'))) values.add('swift');
  return [...values].sort();
}

function detectedPlatforms(repoRoot: string, contract: ProjectEngineeringContract | undefined): string[] {
  const values = new Set<string>(contract?.platforms ?? []);
  let entries: string[] = [];
  try { entries = readdirSync(repoRoot).slice(0, 512); } catch { /* bounded best effort */ }
  if (entries.some((entry) => entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace'))) values.add('ios');
  if (existsSync(join(repoRoot, 'package.json'))) values.add('node');
  return [...values].sort();
}

function parseSkillRef(value: string): { id: string; version?: string } {
  const normalized = value.trim();
  const splitAt = normalized.lastIndexOf('@');
  if (splitAt > 0 && splitAt < normalized.length - 1) {
    return { id: normalized.slice(0, splitAt), version: normalized.slice(splitAt + 1) };
  }
  return { id: normalized };
}

function requiredSkillKinds(languages: string[], platforms: string[]): string[] {
  const kinds = new Set<string>();
  if (languages.includes('typescript')) kinds.add('typescript');
  if (languages.includes('swift')) kinds.add('swift');
  if (platforms.some((value) => value.toLowerCase() === 'ios')) kinds.add('ios');
  for (const language of languages) if (!['typescript', 'swift'].includes(language)) kinds.add(language);
  return [...kinds].sort();
}

function resolveSkills(contract: ProjectEngineeringContract | undefined, requiredKinds: string[]) {
  if (requiredKinds.length === 0) return { status: 'not_required' as const, requiredKinds, resolved: [] as ContextClosureSkillResolution[], unresolvedKinds: [] as string[] };
  const parsed = (contract?.skillRefs ?? []).map(parseSkillRef);
  const resolved: ContextClosureSkillResolution[] = [];
  const covered = new Set<string>();
  for (const skill of parsed) {
    const lower = skill.id.toLowerCase();
    const matchedKinds = requiredKinds.filter((kind) => lower.includes(kind.toLowerCase()));
    if (matchedKinds.length === 0) continue;
    matchedKinds.forEach((kind) => covered.add(kind));
    resolved.push({ ...skill, source: 'project_contract', matchedKinds });
  }
  const unresolvedKinds = requiredKinds.filter((kind) => !covered.has(kind));
  const status = unresolvedKinds.length === 0 ? 'ready' as const : resolved.length > 0 ? 'degraded' as const : 'unavailable' as const;
  return { status, requiredKinds, resolved, unresolvedKinds };
}

function semanticResultProviderIds(results: unknown[]): string[] {
  const ids: string[] = [];
  for (const value of results) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const nested = record.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : undefined;
    const id = typeof record.providerId === 'string' ? record.providerId : typeof nested?.providerId === 'string' ? nested.providerId : undefined;
    if (id) ids.push(id);
  }
  return unique(ids);
}

function resolveSemanticTools(input: BuildContextClosureInput, languages: string[], contract: ProjectEngineeringContract | undefined) {
  const toolingSignals = (contract?.tooling ?? []).map((item) => `${item.id} ${item.purpose ?? ''}`).join(' ');
  const required = MATERIAL_SEMANTIC_INTENT.test(input.query) || /\b(lsp|language[- ]?service|sourcekit|semantic)\b/i.test(toolingSignals);
  if (!required) {
    return { required, status: 'not_required' as const, providers: [] as ContextClosureSemanticToolResolution[], reasonCodes: [] as string[], compilerEvidenceRequired: false };
  }
  const applicable = input.semanticProviders.filter((provider) => provider.languages.some((language) => languages.includes(language)));
  const resultProviderIds = new Set(semanticResultProviderIds(input.semanticNavigation.results));
  const providers: ContextClosureSemanticToolResolution[] = applicable.map((provider) => ({
    providerId: provider.id,
    languages: [...provider.languages].filter((language) => languages.includes(language)),
    status: resultProviderIds.has(provider.id)
      ? 'ready'
      : input.semanticNavigation.requested > 0
        ? input.semanticNavigation.errors.length > 0 ? 'degraded' : 'registered'
        : 'registered',
    evidenceCount: resultProviderIds.has(provider.id) ? 1 : 0,
  }));
  const readyLanguages = new Set(providers.filter((provider) => provider.status === 'ready').flatMap((provider) => provider.languages));
  const unresolvedLanguages = languages.filter((language) => applicable.some((provider) => provider.languages.includes(language)) && !readyLanguages.has(language));
  const reasonCodes = unique([
    ...(applicable.length === 0 ? ['semantic.provider_unavailable'] : []),
    ...(input.semanticNavigation.requested === 0 ? ['semantic.navigation_not_requested'] : []),
    ...input.semanticNavigation.errors.map((error) => `semantic.${String(error.code ?? 'provider_error').toLowerCase()}`),
    ...(unresolvedLanguages.length > 0 ? unresolvedLanguages.map((language) => `semantic.${language}_unproven`) : []),
    ...(input.semanticNavigation.freshness === 'changed_during_query' ? ['semantic.source_changed_during_query'] : []),
  ]);
  const status = applicable.length === 0
    ? 'unavailable' as const
    : reasonCodes.length === 0 && unresolvedLanguages.length === 0
      ? 'ready' as const
      : 'degraded' as const;
  return { required, status, providers, reasonCodes, compilerEvidenceRequired: status !== 'ready' };
}

function recentChanges(repoRoot: string, paths: string[]): ContextClosureReceipt['sourceEvidence']['recentChanges'] {
  const args = ['-C', repoRoot, 'log', `-n${MAX_RECENT_CHANGES}`, '--format=%H%x09%cI%x09%s'];
  const selected = unique(paths, 12);
  if (selected.length > 0) args.push('--', ...selected);
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_RECENT_CHANGES).map((line) => {
    const [revision = '', committedAt = '', ...summary] = line.split('	');
    return { revision, committedAt, summary: summary.join('	').slice(0, 500) };
  }).filter((entry) => entry.revision.length > 0);
}

export function buildContextClosureReceipt(input: BuildContextClosureInput): ContextClosureReceipt {
  const sourceRevision = input.pack.readiness.sourceRevision?.trim();
  if (!sourceRevision) throw new Error('CONTEXT_CLOSURE_SOURCE_REVISION_REQUIRED');
  const project = loadProjectEngineeringContract({ repoRoot: input.repoRoot, sourceRevision });
  const contract = project.status === 'ready' ? project.contract : undefined;
  const currentPaths = unique([...input.pack.coverage.inspectedFiles, ...input.pack.files.map((file) => file.path)], MAX_CLOSURE_PATHS);
  const testPaths = unique(input.pack.coverage.relevantTests.length > 0
    ? input.pack.coverage.relevantTests
    : currentPaths.filter((path) => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path)), 24);
  const languages = detectedLanguages(input.repoRoot, currentPaths);
  const platforms = detectedPlatforms(input.repoRoot, contract);
  const skills = resolveSkills(contract, requiredSkillKinds(languages, platforms));
  const semanticTools = resolveSemanticTools(input, languages, contract);
  const reasonCodes = unique([
    ...input.pack.readiness.unresolvedReasonCodes,
    ...(project.status === 'missing' ? ['project_contract.missing'] : []),
    ...(skills.status === 'degraded' || skills.status === 'unavailable' ? skills.unresolvedKinds.map((kind) => `skill.${kind}_unresolved`) : []),
    ...semanticTools.reasonCodes,
  ], 80);
  const status = input.pack.readiness.rawSource.status === 'unavailable' || input.pack.readiness.status === 'insufficient'
    ? 'insufficient' as const
    : reasonCodes.length > 0 || input.pack.readiness.status === 'degraded'
      ? 'degraded' as const
      : 'ready' as const;
  const core = {
    sourceRevision,
    projectContractDigest: project.status === 'ready' ? project.receipt.contentDigest : null,
    currentPaths,
    testPaths,
    languages,
    platforms,
    skillIds: skills.resolved.map((skill) => `${skill.id}@${skill.version ?? ''}`),
    semanticProviders: semanticTools.providers.map((provider) => `${provider.providerId}:${provider.status}`),
    reasonCodes,
  };
  const receiptId = `context_closure_${createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 32)}`;
  return {
    schemaVersion: 1,
    receiptId,
    sourceRevision,
    generatedAt: new Date().toISOString(),
    contextPackSchemaVersion: input.pack.schemaVersion,
    repository: {
      branch: input.pack.git.branch,
      dirty: input.pack.git.dirty,
      ...(input.workId ? { workId: input.workId } : {}),
      activeWorkIds: unique(input.activeWorkIds ?? [], 20),
    },
    ...(project.status === 'ready' ? { projectContract: project.receipt } : {}),
    projectContractStatus: project.status,
    guidance: {
      status: input.pack.instructionContext.status,
      paths: unique(input.pack.instructionContext.contracts.map((contractEntry) => contractEntry.path), 24),
    },
    detected: { languages, platforms },
    skills,
    semanticTools,
    sourceEvidence: {
      currentPaths,
      testPaths,
      recentChanges: input.includeRecentChanges ? recentChanges(input.repoRoot, currentPaths) : [],
      rawSourceStatus: input.pack.readiness.rawSource.status,
      structuralStatus: input.pack.structuralContext.status,
    },
    readiness: { status, reasonCodes },
    provenance: { source: 'rh_context', contextGeneratedAt: input.pack.generatedAt },
  };
}
