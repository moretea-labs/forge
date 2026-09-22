import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { defaultSemanticProviderRegistry, type SemanticNavigationKind, type SemanticNavigationRequest } from "../../../src/runtime/context/semantic-navigation";
import { buildContextClosureReceipt } from "../../../src/runtime/context/context-closure";
import { codegraphRepositoryCacheRoot } from "../../../src/runtime/context/codegraph-cache-boundary";
import type { MultiRepositoryMcpToolContext } from "../multi-repository";
import { result } from "./result-adapter";
import { selected } from "./shared-adapter";
import { resolveMcpPath } from "../paths";
import { freshGitIdentity } from "../../../src/cli/repository/inspector";
import { repositoryCheckoutLifecycle, repositorySummary, resolveRepositorySelection } from "../../../src/cli/repositories/registry";
import { getExecutionJob, listExecutionJobs } from "../../../src/runtime/execution/jobs/store";
import { isManagedProcessActive, listProcessRecords, listRecoverableProcessRecords, processRuntimeResourceDiagnostics } from "../../../src/runtime/execution/process-runtime";
import { CONTROLLER_CONTEXT_IMPACT_DOMAINS, type ControllerContextImpactDomain } from "../../../src/cli/controller/context/types";
import { buildControllerContextPackInSidecar } from "../../../src/runtime/context/context-pack-process";
import { listControllerChecks } from "../../../src/cli/controller/check-runner";
import { controllerPluginRepository, getAssistantPluginManifest, listAssistantPluginManifests } from "../../../src/runtime/plugins/store";
import { allowedFacadeOperations, buildFacadeResult, listCapabilityDescriptors, getCapabilityDescriptor, getPluginActionCapabilitySchema, searchCapabilityDescriptors, summarizeCapabilityGroups, listHandoffAttentionItems, listHandoffItems, normalizeCheckIds, summarizeHandoffItem, buildWorkContinuationSnapshot } from "../../../src/runtime/control-plane/facade";
import { currentTaskLineageWorkIds, currentTaskSemanticProjectionForWork, getWorkContract, readActiveWorkCandidates, readWorkContractStore, type InvalidActiveWorkCandidate } from "../../../packages/kernel/work/api/index";
import { readForgeInstanceIdentity, type ScopeRef } from "../../../packages/kernel/identity/api/index";
import { memoryAddressKey } from "../../../packages/kernel/cognition/api/index";
import { currentControllerInstanceId } from "../../../src/runtime/control-plane/execution/session-store";
import { getControllerSession } from "../../../packages/kernel/controller/api/index";
import { resolveProjectForRepositoryPlacement } from "../../../src/runtime/control-plane/workspace/workspace-store";
import { cognitiveScopesForWork } from "../../../src/runtime/control-plane/persistence/experience-store";
import { activateCognitiveMemory, auditCognitiveMemory } from "../../../src/runtime/control-plane/persistence/cognition-store";
import { cognitiveUsageFeedbackForContext } from "../../../src/runtime/context/assistant-work-context";
import { invalidFacadeOperation, repositoryExecutionReadiness, summarizeInvalidActiveWorkCandidate, summarizeWorkListItem } from './status-inbox-adapter';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';

const RH_CONTEXT_RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1_000;

function timestampIsRecent(value: string | undefined, cutoffMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoffMs;
}

function isRecentRhContextWork(
  contract: { status: string; updatedAt?: string },
  cutoffMs: number,
): boolean {
  if (contract.status === 'running') return true;
  if (contract.status !== 'ready' && contract.status !== 'open' && contract.status !== 'blocked') return false;
  return timestampIsRecent(contract.updatedAt, cutoffMs);
}

function rhContextReadSessionId(ctx: MultiRepositoryMcpToolContext): string | undefined {
  const principal = ctx.principalId?.trim();
  if (principal) {
    const controllerInstance = ctx.controllerInstanceId?.trim() || currentControllerInstanceId();
    return `controller:${principal}:${controllerInstance}`;
  }
  const transportSession = ctx.sessionId?.trim();
  return transportSession ? `transport:${transportSession}` : undefined;
}

function rhContextKnowledgeAuditRequested(args: Record<string, unknown>): boolean {
  return [
    'knowledge_query', 'knowledge_memory_id', 'knowledge_scope_kind', 'knowledge_scope_id',
    'knowledge_concept', 'knowledge_facet', 'knowledge_source_kind', 'knowledge_source_work_id',
  ].some(key => typeof args[key] === 'string' && String(args[key]).trim().length > 0)
    || typeof args.knowledge_limit === 'number';
}

function rhContextKnowledgeScopes(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  workId: string | undefined,
): { scopes: ScopeRef[]; projectId?: string; gaps: string[] } {
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const work = workId ? getWorkContract(store, workId) : undefined;
  if (work) {
    const scopes = cognitiveScopesForWork(work, ctx.controllerHome);
    return { scopes, projectId: scopes.find(scope => scope.kind === 'project')?.id, gaps: [] };
  }
  const instance = readForgeInstanceIdentity(ctx.controllerHome);
  if (!instance) return { scopes: [], gaps: ['forge_instance_identity_unavailable'] };
  const project = resolveProjectForRepositoryPlacement({
    controllerHome: ctx.controllerHome,
    forgeInstanceId: instance.instanceId,
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
  });
  if (!project) return { scopes: [], gaps: ['project_placement_unavailable'] };
  return {
    projectId: project.projectId,
    scopes: [
      { schemaVersion: 1, kind: 'project', id: project.projectId },
      { schemaVersion: 1, kind: 'workspace', id: project.workspaceId },
    ],
    gaps: [],
  };
}

function rhContextKnowledgeAudit(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const workId = typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined;
  const resolved = rhContextKnowledgeScopes(ctx, repository, workId);
  const requestedKind = typeof args.knowledge_scope_kind === 'string' ? args.knowledge_scope_kind.trim() : '';
  const requestedId = typeof args.knowledge_scope_id === 'string' ? args.knowledge_scope_id.trim() : '';
  const scopes = resolved.scopes.filter(scope =>
    (!requestedKind || scope.kind === requestedKind) && (!requestedId || scope.id === requestedId));
  const scopeMismatch = resolved.scopes.length > 0 && scopes.length === 0 && Boolean(requestedKind || requestedId);
  const rawQuery = typeof args.knowledge_query === 'string' ? args.knowledge_query.trim() : '';
  const query = rawQuery === '*' ? '' : rawQuery;
  const audit = auditCognitiveMemory(ctx.controllerHome, {
    scopes,
    ...(query ? { query } : {}),
    ...(typeof args.knowledge_memory_id === 'string' && args.knowledge_memory_id.trim()
      ? { memoryId: args.knowledge_memory_id.trim() } : {}),
    ...(typeof args.knowledge_concept === 'string' && args.knowledge_concept.trim()
      ? { concept: args.knowledge_concept.trim() } : {}),
    ...(typeof args.knowledge_facet === 'string' && args.knowledge_facet.trim()
      ? { facet: args.knowledge_facet.trim() } : {}),
    ...(typeof args.knowledge_source_kind === 'string' && args.knowledge_source_kind.trim()
      ? { sourceKind: args.knowledge_source_kind.trim() as 'experience' | 'outcome' | 'knowledge' | 'controller' | 'system' | 'external' } : {}),
    ...(typeof args.knowledge_source_work_id === 'string' && args.knowledge_source_work_id.trim()
      ? { sourceWorkId: args.knowledge_source_work_id.trim() } : {}),
    ...(typeof args.knowledge_limit === 'number' ? { limit: args.knowledge_limit } : {}),
  });
  const usage = cognitiveUsageFeedbackForContext({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    scopes,
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
  });
  const usageByAddress = new Map(usage.map(item => [memoryAddressKey(item.address), item]));
  const activation = query
    ? activateCognitiveMemory(ctx.controllerHome, scopes, query, {
        maxItems: Math.min(32, Math.max(1, typeof args.knowledge_limit === 'number' ? Math.trunc(args.knowledge_limit) : 24)),
        usageFeedback: usage,
      })
    : undefined;
  const activationByAddress = new Map((activation?.items ?? []).map(item => [
    memoryAddressKey({ scope: item.memory.scope, id: item.memory.id }),
    { score: item.score, reasons: item.reasons, activationPath: item.activationPath },
  ]));
  return {
    readonly: true,
    advisoryOnly: true,
    authorityBoundary: 'Learned memory never overrides project contracts, authorization, verification, Requirement/Plan/Work, or semantic acceptance.',
    scopes,
    filters: {
      ...(rawQuery ? { query: rawQuery } : {}),
      ...(requestedKind ? { scopeKind: requestedKind } : {}),
      ...(requestedId ? { scopeId: requestedId } : {}),
      ...(typeof args.knowledge_memory_id === 'string' && args.knowledge_memory_id.trim() ? { memoryId: args.knowledge_memory_id.trim() } : {}),
      ...(typeof args.knowledge_concept === 'string' && args.knowledge_concept.trim() ? { concept: args.knowledge_concept.trim() } : {}),
      ...(typeof args.knowledge_facet === 'string' && args.knowledge_facet.trim() ? { facet: args.knowledge_facet.trim() } : {}),
      ...(typeof args.knowledge_source_kind === 'string' && args.knowledge_source_kind.trim() ? { sourceKind: args.knowledge_source_kind.trim() } : {}),
      ...(typeof args.knowledge_source_work_id === 'string' && args.knowledge_source_work_id.trim() ? { sourceWorkId: args.knowledge_source_work_id.trim() } : {}),
    },
    items: audit.items.map(entry => {
      const address = memoryAddressKey({ scope: entry.memory.scope, id: entry.memory.id });
      return {
        memory: entry.memory,
        relations: entry.relations,
        recentUsage: usageByAddress.get(address),
        activation: activationByAddress.get(address),
      };
    }),
    inspected: audit.inspected,
    truncated: audit.truncated,
    gaps: [...resolved.gaps, ...(scopeMismatch ? ['requested_cognitive_scope_not_reachable'] : [])],
  };
}

const RH_CONTEXT_SEMANTIC_QUERY_LIMIT = 8;

const RH_CONTEXT_SEMANTIC_LOCATION_LIMIT = 200;

const RH_CONTEXT_LEGACY_SEMANTIC_SYNTAX = '@tsnav references <repo-path>:<line>:<column> | @swiftnav references <repo-path>:<line>:<column>';

type RhContextSemanticNavigationRequest = {
  navigation: SemanticNavigationKind;
  path: string;
  line: number;
  column: number;
  tsconfig_path?: string;
  language?: string;
};

function rhContextLegacySemanticQuery(query: string): {
  retrievalQuery: string;
  requests: RhContextSemanticNavigationRequest[];
} {
  const requests: RhContextSemanticNavigationRequest[] = [];
  const directive = /(?:^|\s)@(tsnav|swiftnav)\s+(definition|references|implementations)\s+([^\s]+):(\d+):(\d+)(?:\s+tsconfig=([^\s]+))?/gi;
  const retrievalQuery = query.replace(directive, (_match, directiveKind, navigation, path, line, column, tsconfigPath) => {
    const language = String(directiveKind).toLowerCase() === 'swiftnav' ? 'swift' : 'typescript';
    requests.push({
      navigation: String(navigation).toLowerCase() as SemanticNavigationKind,
      path: String(path),
      line: Number(line),
      column: Number(column),
      language,
      ...(tsconfigPath ? { tsconfig_path: String(tsconfigPath) } : {}),
    });
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  const fallback = requests.length > 0
    ? `${requests[0]!.language === 'swift' ? 'Swift' : 'TypeScript'} ${requests[0]!.navigation} ${requests[0]!.path}`
    : query;
  return { retrievalQuery: retrievalQuery || fallback, requests };
}

interface RhContextSemanticNavigationProjection {
  requested: number;
  executed: number;
  results: Record<string, unknown>[];
  errors: Array<{ index: number; code: string; message: string }>;
  providers: unknown[];
  policyDeniedLocations: number;
  policyDeniedReads: number;
  policyDeniedReadSamples: string[];
  requestTruncated: boolean;
  freshness: 'not_requested' | 'changed_during_query' | 'current_at_query';
  sourceIdentity?: Record<string, unknown>;
  staticClosure: { scope: string; status: 'not_requested' | 'incomplete' | 'complete_for_requested_symbols'; limitations: string[] };
}

async function rhContextSemanticNavigation(
  repoRoot: string,
  policy: MultiRepositoryMcpToolContext['policy'],
  value: unknown,
  repositoryIdentity: { repoId: string; checkoutId: string },
): Promise<RhContextSemanticNavigationProjection> {
  const raw = Array.isArray(value) ? value : [];
  const requests = raw.slice(0, RH_CONTEXT_SEMANTIC_QUERY_LIMIT);
  const results: Record<string, unknown>[] = [];
  const errors: Array<{ index: number; code: string; message: string }> = [];
  let anyLocationTruncated = false;
  let policyDeniedLocations = 0;
  let policyDeniedReads = 0;
  const policyDeniedReadSamples = new Set<string>();
  const semanticAccessScope = createHash('sha256')
    .update(JSON.stringify({ profile: policy.profile, readGlobs: policy.readGlobs, denyGlobs: policy.denyGlobs }))
    .digest('hex')
    .slice(0, 20);

  const fingerprintOf = (identity: ReturnType<typeof freshGitIdentity> | undefined): string | undefined => identity
    ? identity.workingTreeFingerprint
      ?? createHash('sha256').update(`${identity.head ?? ''}\n${identity.branch ?? ''}`).digest('hex').slice(0, 24)
    : undefined;
  // Semantic providers are targeted/optional, so pay the stronger fresh identity
  // sampling cost only when semantic evidence was explicitly requested.
  const sourceBefore = requests.length > 0 ? freshGitIdentity(repoRoot) : undefined;
  const sourceFingerprintBefore = fingerprintOf(sourceBefore);
  const indexedRequests: Array<{ index: number; request: SemanticNavigationRequest }> = [];

  requests.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID', message: 'semantic_navigation entries must be objects.' });
      return;
    }
    const item = entry as Record<string, unknown>;
    const navigation = String(item.navigation ?? '') as SemanticNavigationKind;
    const path = String(item.path ?? '').trim();
    const line = Number(item.line);
    const column = Number(item.column);
    const tsconfigPath = typeof item.tsconfig_path === 'string' && item.tsconfig_path.trim() ? item.tsconfig_path.trim() : undefined;
    const language = typeof item.language === 'string' && item.language.trim() ? item.language.trim().toLowerCase() : undefined;
    if (!['definition', 'references', 'implementations'].includes(navigation) || !path || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID', message: 'navigation, path, and positive 1-based line/column are required.' });
      return;
    }
    const targetDecision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!targetDecision.ok) {
      errors.push({ index, code: 'SEMANTIC_NAVIGATION_TARGET_DENIED', message: targetDecision.reason ?? 'target path denied by MCP read policy.' });
      return;
    }
    indexedRequests.push({
      index,
      request: { navigation, path, line, column, ...(tsconfigPath ? { tsconfigPath } : {}), ...(language ? { language } : {}) },
    });
  });

  const allowRepositoryPath = (relativePath: string): boolean => {
    const decision = resolveMcpPath(repoRoot, relativePath, policy, 'read');
    if (decision.ok) return true;
    policyDeniedReads += 1;
    if (policyDeniedReadSamples.size < 20) policyDeniedReadSamples.add(relativePath);
    return false;
  };

  const navigationOutcomes = await defaultSemanticProviderRegistry.navigate(repoRoot, indexedRequests, {
    cacheScope: `mcp:${semanticAccessScope}`,
    sourceIdentity: sourceFingerprintBefore,
    profile: policy.profile,
    readPolicy: {
      profile: policy.profile,
      readGlobs: [...policy.readGlobs],
      denyGlobs: [...policy.denyGlobs],
      maxFileBytes: policy.maxFileBytes,
    },
    allowRepositoryPath,
  });

  for (const { index, outcome } of navigationOutcomes) {
    if (!outcome.ok) {
      errors.push({ index, code: outcome.code, message: outcome.message });
      continue;
    }
    const semantic = outcome.result;
    const sidecarDeniedReads = Math.max(0, Number(semantic.policyDeniedReads ?? 0));
    policyDeniedReads += sidecarDeniedReads;
    const sidecarDeniedSamples = semantic.details?.policyDeniedReadSamples;
    if (Array.isArray(sidecarDeniedSamples)) {
      for (const sample of sidecarDeniedSamples) {
        if (policyDeniedReadSamples.size >= 20) break;
        if (typeof sample === 'string' && sample.trim()) policyDeniedReadSamples.add(sample);
      }
    }
    const allowedLocations = semantic.locations.filter((location) => {
      const decision = resolveMcpPath(repoRoot, location.path, policy, 'read');
      if (decision.ok) return true;
      policyDeniedLocations += 1;
      return false;
    });
    const truncated = allowedLocations.length > RH_CONTEXT_SEMANTIC_LOCATION_LIMIT;
    anyLocationTruncated ||= truncated;
    results.push({
      provider: semantic.providerId,
      ...(semantic.providerIdentity ? { providerIdentity: semantic.providerIdentity } : {}),
      language: semantic.language,
      navigation: semantic.navigation,
      target: semantic.target,
      locations: allowedLocations.slice(0, RH_CONTEXT_SEMANTIC_LOCATION_LIMIT),
      totalLocations: allowedLocations.length,
      returnedLocations: Math.min(allowedLocations.length, RH_CONTEXT_SEMANTIC_LOCATION_LIMIT),
      truncated,
      policyDeniedReads: semantic.policyDeniedReads ?? 0,
      ...(semantic.details ?? {}),
    });
  }

  results.sort((left, right) => {
    const leftTarget = left.target as { path?: string; line?: number; column?: number } | undefined;
    const rightTarget = right.target as { path?: string; line?: number; column?: number } | undefined;
    return String(leftTarget?.path ?? '').localeCompare(String(rightTarget?.path ?? ''))
      || Number(leftTarget?.line ?? 0) - Number(rightTarget?.line ?? 0)
      || Number(leftTarget?.column ?? 0) - Number(rightTarget?.column ?? 0);
  });

  const sourceAfter = requests.length > 0 ? freshGitIdentity(repoRoot) : undefined;
  const sourceFingerprintAfter = fingerprintOf(sourceAfter);
  const sourceChangedDuringQuery = Boolean(
    sourceBefore
    && sourceAfter
    && (sourceBefore.head !== sourceAfter.head || sourceFingerprintBefore !== sourceFingerprintAfter),
  );
  if (sourceChangedDuringQuery) {
    errors.push({
      index: -1,
      code: 'SEMANTIC_SOURCE_CHANGED_DURING_QUERY',
      message: 'Repository source identity changed while semantic providers were running. Returned locations are retained only as hints for the sampled source and are not proof for the newer source state.',
    });
  }

  const requestTruncated = raw.length > RH_CONTEXT_SEMANTIC_QUERY_LIMIT;
  const incomplete = requestTruncated || anyLocationTruncated || policyDeniedLocations > 0 || policyDeniedReads > 0 || errors.length > 0 || sourceChangedDuringQuery;
  const languages = new Set(results.map((entry) => String(entry.language ?? '')).filter(Boolean));
  const singleLanguage = languages.size === 1 ? [...languages][0] : undefined;
  const scope = singleLanguage === 'typescript'
    ? 'requested_typescript_static_relationships'
    : singleLanguage === 'swift'
      ? 'requested_swift_static_relationships'
      : singleLanguage
        ? `requested_${singleLanguage.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}_static_relationships`
        : languages.size > 1
          ? 'requested_multilanguage_static_relationships'
          : 'requested_semantic_static_relationships';
  return {
    requested: raw.length,
    executed: requests.length,
    results,
    errors,
    providers: defaultSemanticProviderRegistry.list(),
    policyDeniedLocations,
    policyDeniedReads,
    policyDeniedReadSamples: Array.from(policyDeniedReadSamples),
    requestTruncated,
    freshness: raw.length === 0 ? 'not_requested' : sourceChangedDuringQuery ? 'changed_during_query' : 'current_at_query',
    ...(sourceBefore ? {
      sourceIdentity: {
        repoId: repositoryIdentity.repoId,
        checkoutId: repositoryIdentity.checkoutId,
        branch: sourceBefore.branch,
        head: sourceBefore.head,
        workingTreeFingerprint: sourceFingerprintBefore,
        sampledAt: new Date(sourceBefore.sampledAt).toISOString(),
      },
    } : {}),
    staticClosure: {
      scope,
      status: raw.length === 0 ? 'not_requested' : incomplete ? 'incomplete' : 'complete_for_requested_symbols',
      limitations: ['dynamic_registration', 'string_or_config_edges', 'reflection', 'runtime_dispatch', 'stale_or_missing_language_index'],
    },
  };
}

function codegraphIndexExists(controllerHome: string, root: string): boolean {
  return existsSync(join(codegraphRepositoryCacheRoot(controllerHome, root), 'codegraph.db'))
    || existsSync(join(root, '.codegraph', 'codegraph.db'));
}

/**
 * Managed worktrees borrow one repository baseline CodeGraph from a non-worktree
 * checkout. Dirty worktree bytes remain a raw/lexical overlay; they never create
 * a second structural-index authority merely because execution is isolated.
 * Repo-local `.codegraph` is retained only as a legacy-readable fallback.
 */
export function resolveStructuralIndexRoot(
  controllerHome: string,
  repository: ReturnType<typeof resolveRepositorySelection>,
): string | undefined {
  const active = repository.checkouts.find((checkout) => checkout.checkoutId === repository.activeCheckoutId);
  const nonWorktreeRoots = repository.checkouts
    .filter((checkout) => checkout.checkoutId !== repository.activeCheckoutId && checkout.worktree !== true && repositoryCheckoutLifecycle(checkout) === 'active')
    .map((checkout) => checkout.canonicalRoot);
  const candidates = active?.worktree === true
    ? [...nonWorktreeRoots, repository.canonicalRoot]
    : [repository.canonicalRoot, ...nonWorktreeRoots];
  return [...new Set(candidates)].find((root) => codegraphIndexExists(controllerHome, root));
}

export async function callContextAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  if (name !== 'rh_context') return undefined;
    const repository = selected(ctx, args);
    const operation = String(args.operation ?? 'get');
    if (!allowedFacadeOperations('rh_context').includes(operation)) {
      return invalidFacadeOperation('rh_context', operation);
    }
    if (operation === 'search') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const knowledgeAuditRequested = rhContextKnowledgeAuditRequested(args);
      if (!query && !knowledgeAuditRequested) {
        const facade = buildFacadeResult({
          status: 'failed',
          summary: 'rh_context.search requires a non-empty code query or explicit knowledge audit fields.',
          data: { operation, repoId: repository.repoId },
          suggestedNextActions: [],
        });
        return result(facade as unknown as Record<string, unknown>, true);
      }
      const cognitionAudit = knowledgeAuditRequested ? rhContextKnowledgeAudit(ctx, repository, args) : undefined;
      if (!query && cognitionAudit) {
        const items = Array.isArray(cognitionAudit.items) ? cognitionAudit.items : [];
        const facade = buildFacadeResult({
          status: 'ok',
          summary: `Retrieved ${items.length} bounded learned-memory audit item(s).`,
          data: { operation, repoId: repository.repoId, cognitionAudit },
          warnings: [],
          suggestedNextActions: [],
          detailLevel: args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary',
          rawAvailable: false,
        });
        // cognitionAudit is already bounded by scope/item/relation/usage/activation budgets.
        // Preserve its nested provenance and reasoning rather than letting generic facade depth
        // bounding turn the read-only audit contract into opaque "[bounded-depth]" markers.
        (facade.data as typeof facade.data & { cognitionAudit: typeof cognitionAudit }).cognitionAudit = cognitionAudit;
        return result(facade as unknown as Record<string, unknown>);
      }
      const legacySemanticQuery = rhContextLegacySemanticQuery(query);
      const retrievalQuery = legacySemanticQuery.retrievalQuery;
      const list = (value: unknown): string[] => Array.isArray(value)
        ? value.map(String).map((entry) => entry.trim()).filter(Boolean)
        : [];
      const retrievalMode = args.retrieval_mode === 'plan' || args.retrieval_mode === 'debug' || args.retrieval_mode === 'review'
        ? args.retrieval_mode
        : 'implementation';
      const impactDomains = list(args.impact_domains)
        .filter((domain): domain is ControllerContextImpactDomain => CONTROLLER_CONTEXT_IMPACT_DOMAINS.includes(domain as ControllerContextImpactDomain));
      const structuralContext = args.structural_context === 'off' || args.structural_context === 'auto' || args.structural_context === 'required'
        ? args.structural_context
        : retrievalMode === 'plan' || retrievalMode === 'debug'
          ? 'required'
          : 'auto';
      const requestedCheckIds = list(args.requested_check_ids);
      // Source retrieval is the default Context responsibility. Check
      // readiness is only meaningful when the controller has named the
      // checks it is about to use, so do not pay its Git/dependency/schedule
      // preflight cost for every broad search.
      const checks = requestedCheckIds.length > 0
        ? listControllerChecks(repository.canonicalRoot)
        : [];
      const executionReadiness = requestedCheckIds.length > 0
        ? repositoryExecutionReadiness(repository.canonicalRoot, checks, requestedCheckIds, {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          })
        : undefined;
      const pack = await buildControllerContextPackInSidecar({
        repoRoot: repository.canonicalRoot,
        policy: ctx.policy,
        options: {
        description: retrievalQuery,
        // Short code-like queries remain useful exact lexical needles. Long
        // semantic prompts are already tokenized from description; adding the
        // whole prompt as an exact needle prevents batch-search early exit and
        // forces a full bounded repository scan for a phrase that will not match.
        searchTerms: retrievalQuery.length <= 160 ? [retrievalQuery] : undefined,
        knownPaths: list(args.known_paths),
        includeGlobs: list(args.include_globs),
        excludeGlobs: list(args.exclude_globs),
        maxFiles: typeof args.max_files === 'number' ? args.max_files : undefined,
        maxSnippets: typeof args.max_snippets === 'number' ? args.max_snippets : undefined,
        structuralContext,
        structuralIndexRoot: structuralContext === 'off' ? undefined : resolveStructuralIndexRoot(ctx.controllerHome, repository),
        retrievalMode,
        impactDomains,
          session: rhContextReadSessionId(ctx)
            ? { sessionId: rhContextReadSessionId(ctx)!, repoId: repository.repoId, checkoutId: repository.activeCheckoutId }
            : undefined,
        },
      });
      const explicitSemanticNavigation = Array.isArray(args.semantic_navigation) ? args.semantic_navigation : [];
      const semanticRequests = [...explicitSemanticNavigation, ...legacySemanticQuery.requests];
      const semanticNavigation = {
        ...await rhContextSemanticNavigation(repository.canonicalRoot, ctx.policy, semanticRequests, { repoId: repository.repoId, checkoutId: repository.activeCheckoutId }),
        requestSource: explicitSemanticNavigation.length > 0 && legacySemanticQuery.requests.length > 0
          ? 'schema_and_query'
          : explicitSemanticNavigation.length > 0
            ? 'semantic_navigation'
            : legacySemanticQuery.requests.length > 0
              ? 'query_compatibility'
              : 'none',
        compatibilityQuerySyntax: RH_CONTEXT_LEGACY_SEMANTIC_SYNTAX,
      };
      const semanticReasonCodes = Array.from(new Set([
        ...semanticNavigation.errors.map((entry) => `semantic.${String(entry.code ?? 'provider_error').toLowerCase()}`),
        ...(semanticNavigation.requestTruncated ? ['semantic.request_truncated'] : []),
        ...(semanticNavigation.policyDeniedLocations > 0 || semanticNavigation.policyDeniedReads > 0 ? ['semantic.policy_denied'] : []),
        ...(semanticNavigation.freshness === 'changed_during_query' ? ['semantic.source_changed_during_query'] : []),
        ...(semanticNavigation.requested > 0 && semanticNavigation.staticClosure.status !== 'complete_for_requested_symbols' ? ['semantic.static_closure_incomplete'] : []),
      ]));
      const semanticUnavailable = semanticNavigation.requested > 0
        && semanticNavigation.results.length === 0
        && semanticNavigation.errors.length > 0
        && semanticNavigation.errors.every((entry) => /UNAVAILABLE|NOT_AVAILABLE|NOT_READY|MISSING|NOT_FOUND|BUILD_SETTINGS|BUILD_SERVER/i.test(String(entry.code ?? '')));
      const semanticReadinessStatus = semanticNavigation.requested === 0
        ? 'not_requested' as const
        : semanticNavigation.results.length === 0 && semanticNavigation.errors.length > 0
          ? semanticUnavailable ? 'unavailable' as const : 'error' as const
          : semanticNavigation.staticClosure.status === 'complete_for_requested_symbols' && semanticReasonCodes.length === 0
            ? 'ready' as const
            : 'partial' as const;
      const readinessStatus = pack.readiness.status === 'insufficient'
        ? 'insufficient' as const
        : semanticReadinessStatus === 'unavailable' || semanticReadinessStatus === 'error'
          ? 'insufficient' as const
          : pack.readiness.status === 'degraded' || semanticReadinessStatus === 'partial'
            ? 'degraded' as const
            : 'ready' as const;
      const readiness = {
        ...pack.readiness,
        status: readinessStatus,
        semantic: { status: semanticReadinessStatus, reasonCodes: semanticReasonCodes },
        unresolvedReasonCodes: Array.from(new Set([...pack.readiness.unresolvedReasonCodes, ...semanticReasonCodes])).slice(0, 80),
        readyForHighConfidenceMutation: readinessStatus === 'ready',
      };
      const closureWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
      const closureWork = closureWorkId
        ? getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, closureWorkId)
        : undefined;
      const contextClosure = buildContextClosureReceipt({
        repoRoot: repository.canonicalRoot,
        query: retrievalQuery,
        pack: { ...pack, readiness },
        semanticNavigation,
        semanticProviders: defaultSemanticProviderRegistry.list(),
        workId: closureWorkId || undefined,
        activeWorkIds: closureWork ? [closureWork.workId] : [],
        includeRecentChanges: retrievalMode !== 'implementation',
      });
      const warnings = structuralContext === 'required' && !pack.structuralContext.requiredSatisfied
        ? [pack.structuralContext.fallbackReason ?? 'Required structural context is not ready; lexical retrieval results are returned as degraded evidence.']
        : [];
      const facade = buildFacadeResult({
        status: 'ok',
        summary: pack.files.length
          ? `Retrieved ${pack.files.length} bounded code context file(s) for the query.`
          : 'No bounded code context matched the query.',
        data: {
          operation,
          repoId: repository.repoId,
          goal: pack.goal,
          search: pack.search,
          structuralContext: pack.structuralContext,
          impactContext: pack.impactContext,
          semanticNavigation,
          contextClosure,
          readiness,
          expansion: pack.expansion,
          files: pack.files,
          coverage: pack.coverage,
          cache: pack.cache,
          timingsMs: pack.timingsMs,
          deniedPaths: pack.deniedPaths,
          omitted: pack.omitted,
          limits: pack.limits,
          contextContract: pack.contextContract,
          ...(cognitionAudit ? { cognitionAudit } : {}),
          ...(executionReadiness ? {
            executionReadiness,
            registeredChecks: checks.slice(0, 80).map((check) => ({ id: check.id, description: check.description, source: check.source, effects: check.effects })),
          } : {}),
          retrievalPolicy: {
            defaultBackend: 'bounded_lexical',
            structuralBackend: 'codegraph',
            rawReadTool: 'read_repository_file',
            shellSearchFallbackOnly: true,
            executionReadiness: 'requested_check_ids_only',
          },
        },
        warnings,
        suggestedNextActions: [],
        detailLevel: 'summary',
        rawAvailable: true,
      });
      // ContextClosureReceipt already enforces bounded paths, tests, skills, semantic providers,
      // and reason codes. Generic facade depth bounding is appropriate for exploratory context,
      // but it must not corrupt this runtime-issued round-trip contract because rh_work validates
      // the exact full receipt digest supplied by the Controller during engineering re-entry.
      (facade.data as typeof facade.data & { contextClosure: typeof contextClosure }).contextClosure = contextClosure;
      if (cognitionAudit) {
        (facade.data as typeof facade.data & { cognitionAudit: typeof cognitionAudit }).cognitionAudit = cognitionAudit;
      }
      return result(facade as unknown as Record<string, unknown>);
    }
    const startedAt = performance.now();
    const requestedCapabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
    if (requestedCapabilityId) {
      const pluginMatch = /^plugin\.([^.]+)\.(.+)$/.exec(requestedCapabilityId);
      const manifests = pluginMatch ? (() => {
        const pluginId = pluginMatch[1];
        const targets = [repository];
        const controllerRepository = controllerPluginRepository(ctx.controllerHome);
        if (controllerRepository.repoId !== repository.repoId) targets.push(controllerRepository);
        for (const target of targets) {
          try {
            return [getAssistantPluginManifest(ctx.controllerHome, target, pluginId)];
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('PLUGIN_NOT_FOUND:')) continue;
            throw error;
          }
        }
        return [];
      })() : [];
      const descriptor = getCapabilityDescriptor(requestedCapabilityId, manifests);
      const pluginAction = getPluginActionCapabilitySchema(requestedCapabilityId, manifests);
      const facade = buildFacadeResult({
        status: 'ok',
        summary: descriptor
          ? `Exact capability ${requestedCapabilityId} is available.`
          : `Capability ${requestedCapabilityId} was not found.`,
        data: {
          operation,
          repoId: repository.repoId,
          repository: {
            repoId: repository.repoId,
            displayName: repository.displayName,
            defaultBranch: repository.defaultBranch,
            repositoryType: repository.repositoryType,
          },
          capabilityLookup: {
            requestedCapabilityId,
            found: Boolean(descriptor),
            descriptor,
            pluginAction,
          },
          toolArchitecture: {
            facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
            domainSchemaLoading: 'exact_capability_fast_path',
          },
          bounded: true,
        },
        warnings: [],
        suggestedNextActions: [],
        detailLevel: args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary',
        rawAvailable: false,
      });
      const payload = facade as unknown as Record<string, unknown>;
      payload.responseMeta = {
        serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
        structuredPayloadBytes: 0,
      };
      (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      return result(payload);
    }
    const capabilityIntentQuery = operation === 'list' && typeof args.query === 'string'
      ? args.query.trim()
      : '';
    if (capabilityIntentQuery) {
      const manifestOptions = { preferStored: true };
      const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
      const controllerRepository = controllerPluginRepository(ctx.controllerHome);
      const controllerManifests = repository.repoId === controllerRepository.repoId
        ? []
        : listAssistantPluginManifests(ctx.controllerHome, controllerRepository, manifestOptions);
      const manifests = [...new Map(
        [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
      ).values()];
      const matches = searchCapabilityDescriptors(capabilityIntentQuery, manifests, 12)
        .map((match) => ({
          ...match,
          pluginAction: getPluginActionCapabilitySchema(match.capabilityId, manifests),
        }));
      const facade = buildFacadeResult({
        status: 'ok',
        summary: matches.length > 0
          ? `Found ${matches.length} capability candidate(s) for intent: ${capabilityIntentQuery}`
          : `No capability candidates matched intent: ${capabilityIntentQuery}`,
        data: {
          operation,
          repoId: repository.repoId,
          capabilitySearch: {
            query: capabilityIntentQuery,
            matches,
            readOnlyDiscovery: true,
            executeWith: 'plugin_action_execute',
          },
          toolArchitecture: {
            facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
            domainSchemaLoading: 'intent_ranked_capability_search',
            exactCapabilityLookupStillAvailable: true,
          },
          bounded: true,
        },
        warnings: [],
        suggestedNextActions: [],
        detailLevel: args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary',
        rawAvailable: false,
      });
      return result(facade as unknown as Record<string, unknown>);
    }
    const requested = Array.isArray(args.requested_check_ids) ? args.requested_check_ids.map(String) : [];
    const detailLevel = args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary';
    const isSummary = detailLevel === 'summary';
    const checks = requested.length > 0 || !isSummary ? listControllerChecks(repository.canonicalRoot) : [];
    const normalizedChecks = normalizeCheckIds(requested, checks);
    const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
    const workId = typeof args.work_id === 'string' ? args.work_id : undefined;
    const work = workId ? getWorkContract(store, workId) : undefined;
    const executionJob = workId && !work ? (() => { try { return getExecutionJob(ctx.controllerHome, repository.repoId, workId); } catch { return undefined; } })() : undefined;
    if (workId && !work && !executionJob) {
      const facade = buildFacadeResult({
        status: 'not_found',
        summary: `Work ${workId} not found in this repository.`,
        data: { operation, repoId: repository.repoId, workId },
        suggestedNextActions: [],
      });
      return result(facade as unknown as Record<string, unknown>, true);
    }
    const activeWorkProjection = operation === 'list' || !workId
      ? readActiveWorkCandidates({ ...store, limit: 20 })
      : { contracts: [], invalid: [] as InvalidActiveWorkCandidate[] };
    const activeContractScan = activeWorkProjection.contracts;
    const currentLineageWorkIds = work
      ? currentTaskLineageWorkIds([work.workId], readWorkContractStore(store).contracts)
      : new Set<string>();
    const recentActivityCutoffMs = Date.now() - RH_CONTEXT_RECENT_ACTIVITY_WINDOW_MS;
    const recentActiveContractScan = isSummary
      ? activeContractScan.filter((contract) => isRecentRhContextWork(contract, recentActivityCutoffMs))
      : activeContractScan;
    const activeContracts = isSummary ? recentActiveContractScan.slice(0, 3) : activeContractScan;
    const recentJobs = !isSummary && (operation === 'list' || !workId)
      ? listExecutionJobs(ctx.controllerHome, repository.repoId, 20)
        .filter((job) => timestampIsRecent(job.updatedAt, recentActivityCutoffMs))
        .slice(0, 5)
      : [];
    const processScan = isSummary
      ? listRecoverableProcessRecords(ctx.controllerHome, repository.repoId)
      : listProcessRecords(ctx.controllerHome, repository.repoId, workId ? 100 : 50);
    const relevantProcesses = processScan.filter((process) => work
      ? Boolean(process.workId && currentLineageWorkIds.has(process.workId))
      : timestampIsRecent(process.updatedAt, recentActivityCutoffMs));
    const liveProcessIds = new Set(processRuntimeResourceDiagnostics().activeProcessIds);
    const activeProcesses = relevantProcesses.filter((process) => liveProcessIds.has(process.processId) && isManagedProcessActive(process));
    const workController = work ? getControllerSession(store, work.workId) : undefined;
    const manifestOptions = { preferStored: true };
    const manifests = isSummary
      ? []
      : (() => {
          const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
          const controllerRepository = controllerPluginRepository(ctx.controllerHome);
          const controllerManifests = repository.repoId === controllerRepository.repoId
            ? []
            : listAssistantPluginManifests(ctx.controllerHome, controllerRepository, manifestOptions);
          return [...new Map(
            [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
          ).values()];
        })();
    const capabilities = isSummary ? [] : listCapabilityDescriptors(manifests);
    const capabilityGroups = isSummary ? [] : summarizeCapabilityGroups(manifests);
    const capabilityLookup = undefined;
    const selectedChecks = normalizedChecks.validCheckIds
      .map((id) => checks.find((check) => check.id === id))
      .filter((check): check is (typeof checks)[number] => Boolean(check))
      .map((check) => ({ id: check.id, description: check.description, source: check.source }));
    const pendingAttention = listHandoffItems({ ...store, status: 'pending', limit: isSummary ? 20 : 5 });
    const currentAttentionScan = listHandoffAttentionItems(store, isSummary ? 20 : 5);
    const workAttentionItems = work
      ? currentAttentionScan.filter((item) => Boolean(item.workId && currentLineageWorkIds.has(item.workId)))
      : [];
    const workAttention = workAttentionItems[0];
    const currentAttentionItems = work
      ? workAttentionItems
      : isSummary
        ? currentAttentionScan.slice(0, 3)
        : currentAttentionScan;
    const attention = isSummary
      ? currentAttentionItems.map((item) => ({
        id: item.id,
        workId: item.workId,
        title: item.title.slice(0, 96),
        severity: item.severity,
        reason: item.reason.slice(0, 160),
        blockingDecision: item.blockingDecision?.slice(0, 160),
        updatedAt: item.updatedAt,
      }))
      : currentAttentionItems.map(summarizeHandoffItem);
    const detailCheckCandidates = requested.length > 0
      ? selectedChecks
      : checks.map((check) => ({ id: check.id, description: check.description, source: check.source }));
    const checkSummaries = isSummary ? selectedChecks : detailCheckCandidates.slice(0, 24);
    const detailArguments = {
      repo_id: repository.repoId,
      operation,
      ...(workId ? { work_id: workId } : {}),
      ...(requested.length ? { requested_check_ids: requested } : {}),
    };
    const summaryData = {
      operation,
      repoId: repository.repoId,
      repository: {
        repoId: repository.repoId,
        displayName: repository.displayName,
        defaultBranch: repository.defaultBranch,
        repositoryType: repository.repositoryType,
      },
      checks: selectedChecks,
      selectedChecks,
      requestedCheckIds: requested,
      normalizedChecks,
      invalidCheckIdsAreNotFailures: true,
      capabilityInventory: {
        mode: 'detail_only',
        deferred: true,
        reason: 'Work/repository summary does not hydrate plugin manifests; request capability_id or detail/raw only when schema/policy detail is needed.',
      },
      capabilityLookup,
      toolArchitecture: {
        facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
        domainSchemaLoading: 'static_stable_surface',
      },
      work: work
        ? {
            workId: work.workId,
            status: work.status,
            mode: work.mode,
            objective: work.objective.slice(0, 160),
            continuation: buildWorkContinuationSnapshot(work),
          }
        : undefined,
      executionJob: executionJob ? summarizeWorkListItem(executionJob) : undefined,
      executionState: work ? (workAttention ? 'blocked' : activeProcesses.length > 0 ? 'executing' : workController ? 'controller_active' : 'waiting_trigger') : undefined,
      activeController: workController ? { controllerType: workController.controllerType, sessionId: workController.sessionId, leaseExpiresAt: workController.leaseExpiresAt } : undefined,
      activeProcesses: activeProcesses.slice(0, 3).map((process) => ({ processId: process.processId, workId: process.workId, status: process.status, route: process.route, startedAt: process.startedAt, updatedAt: process.updatedAt })),
      recentProcesses: relevantProcesses.slice(0, 5).map((process) => ({ processId: process.processId, workId: process.workId, status: process.status, route: process.route, startedAt: process.startedAt, updatedAt: process.updatedAt })),
      currentTask: work ? currentTaskSemanticProjectionForWork(work) : undefined,
      activeWork: activeContracts.map((entry) => ({
        relation: 'repository_inventory' as const,
        relevance: ['ownership', 'conflict', 'release_admission'] as const,
        workId: entry.workId,
        status: entry.status,
        mode: entry.mode,
      })),
      invalidActiveWork: activeWorkProjection.invalid.slice(0, 3).map(summarizeInvalidActiveWorkCandidate),
      activeAttention: attention,
      counts: {
        availableChecks: checks.length,
        selectedChecks: selectedChecks.length,
        capabilityInventoryDeferred: true,
        activeWork: recentActiveContractScan.length,
        activeWorkShown: activeContracts.length,
        recentActiveWork: recentActiveContractScan.length,
        invalidActiveWork: activeWorkProjection.invalid.length,
        invalidActiveWorkShown: Math.min(activeWorkProjection.invalid.length, 3),
        storedNonTerminalWork: activeContractScan.length,
        currentWork: work ? 1 : 0,
        historicalNonTerminalWork: Math.max(0, activeContractScan.length - recentActiveContractScan.length),
        currentAttention: work ? workAttentionItems.length : 0,
        repositoryAttention: currentAttentionScan.length,
        currentAttentionShown: attention.length,
        activeProcesses: activeProcesses.length,
        recentProcesses: relevantProcesses.length,
        historicalProcessScanDeferred: true,
        pendingAttentionScanned: pendingAttention.length,
        historicalPendingAttention: Math.max(0, pendingAttention.length - currentAttentionScan.length),
        omittedCurrentAttention: Math.max(0, (work ? workAttentionItems.length : 0) - attention.length),
        omittedPendingAttention: Math.max(0, pendingAttention.length - attention.length),
      },
      historicalExecutionJobsIncluded: false,
      detailPointers: {
        detail: { tool: 'rh_context', arguments: { ...detailArguments, detail_level: 'detail' } },
        raw: { tool: 'rh_context', arguments: { ...detailArguments, detail_level: 'raw' } },
      },
      bounded: true,
    };
    const detailCapabilities = capabilities.slice(0, 24);
    const detailData = {
      operation,
      repoId: repository.repoId,
      repository: repositorySummary(repository),
      checks: checkSummaries,
      omittedCheckCount: Math.max(0, checks.length - checkSummaries.length),
      selectedChecks,
      requestedCheckIds: requested,
      normalizedChecks,
      invalidCheckIdsAreNotFailures: true,
      capabilityCount: capabilities.length,
      capabilities: detailCapabilities,
      omittedCapabilityCount: Math.max(0, capabilities.length - detailCapabilities.length),
      capabilityGroups,
      capabilityLookup,
      toolArchitecture: {
        facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work'],
        atomicTypedToolsRetained: true,
        internalHandlersRetained: true,
        domainSchemaLoading: 'static_stable_surface',
        dynamicDomainSchemaLoadingSupported: false,
      },
      currentTask: work ? currentTaskSemanticProjectionForWork(work) : undefined,
      work: work ? { ...work, continuation: buildWorkContinuationSnapshot(work) } : undefined,
      executionJob: executionJob ? summarizeWorkListItem(executionJob) : undefined,
      executionState: work ? (workAttention ? 'blocked' : activeProcesses.length > 0 ? 'executing' : workController ? 'controller_active' : 'waiting_trigger') : undefined,
      activeController: workController,
      activeProcesses: activeProcesses.slice(0, 10),
      recentProcesses: relevantProcesses.slice(0, 20),
      activeWork: activeContracts.map((entry) => ({
        relation: 'repository_inventory' as const,
        relevance: ['ownership', 'conflict', 'release_admission'] as const,
        workId: entry.workId,
        status: entry.status,
        mode: entry.mode,
      })),
      invalidActiveWork: activeWorkProjection.invalid.slice(0, 10).map(summarizeInvalidActiveWorkCandidate),
      recentExecutionJobs: recentJobs.map(summarizeWorkListItem),
      activeAttention: attention,
      counts: {
        availableChecks: checks.length,
        selectedChecks: selectedChecks.length,
        capabilities: capabilities.length,
        activeWork: activeContracts.length,
        invalidActiveWork: activeWorkProjection.invalid.length,
        recentExecutionJobs: recentJobs.length,
        activeProcesses: activeProcesses.length,
        recentProcesses: relevantProcesses.length,
        activeAttention: attention.length,
      },
      bounded: true,
    };
    const facade = buildFacadeResult({
      status: 'ok',
      summary: work
        ? `Bounded context for work ${work.workId}.`
        : executionJob
          ? `Bounded context for execution job ${executionJob.jobId}.`
          : 'Bounded repository context and active work summaries are available.',
      data: isSummary ? summaryData : detailData,
      warnings: normalizedChecks.warnings,
      evidenceRefs: work?.evidenceRefs?.slice(0, 5) ?? [],
      suggestedNextActions: normalizedChecks.suggestedNextActions.length ? normalizedChecks.suggestedNextActions : [{
        label: 'Choose work mode',
        tool: 'rh_work',
        operation: 'start',
        risk: 'workspace_write',
        confidence: 'medium',
      }],
      detailLevel,
      rawAvailable: detailLevel === 'raw',
    });
    const payload = facade as unknown as Record<string, unknown>;
    if (isSummary) {
      payload.responseMeta = {
        serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
        structuredPayloadBytes: 0,
      };
      (payload.responseMeta as { structuredPayloadBytes: number }).structuredPayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    }
    return result(payload);
}
