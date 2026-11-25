import { createHash } from 'crypto';
import {
  defaultSemanticProviderRegistry,
  type SemanticNavigationKind,
  type SemanticNavigationRequest,
} from '../../../src/runtime/context/semantic-navigation';
import { isIncidentalSemanticDependencyProbe } from '../../../src/runtime/context/semantic-navigation-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result, serializeResultPayload } from './result-adapter';
import { selected } from './shared-adapter';
import { resolveMcpPath } from '../../../src/runtime/safe-tooling/path-policy';
import {
  cachedGitIdentityAsync,
  freshGitIdentityAsync,
  type CachedGitIdentity,
} from '../../../src/runtime/repositories/inspector';
import { repositorySummary } from '../../../src/runtime/repositories/registry';
import { listExecutionJobs } from '../../../src/runtime/execution/jobs/store';
import {
  isManagedProcessActive,
  listProcessRecords,
  listRecoverableProcessRecords,
  processRuntimeResourceDiagnostics,
} from '../../../src/runtime/execution/process-runtime';
import { listControllerChecks } from '../../../src/runtime/execution/process-runtime/check-runner';
import {
  getAssistantPluginManifest,
  getAssistantPluginManifestForAction,
  getControllerPluginManifest,
  listAssistantPluginManifests,
  listControllerPluginManifests,
} from '../../../src/runtime/plugins/store';
import {
  allowedFacadeOperations,
  buildFacadeResult,
  listCapabilityDescriptors,
  getCapabilityDescriptor,
  getCoreCapabilityExecutionSchema,
  getPluginActionCapabilitySchema,
  searchCapabilityDescriptors,
  summarizeCapabilityGroups,
  listHandoffAttentionItems,
  listHandoffItems,
  normalizeCheckIds,
  summarizeHandoffItem,
  FACADE_TOOLS,
} from '../../../src/runtime/control-plane/facade';
import { readForgeInstanceIdentity, type ScopeRef } from '../../../packages/kernel/identity/api/index';
import { memoryAddressKey } from '../../../packages/kernel/cognition/api/index';
import { resolveProjectForRepositoryPlacement } from '../../../src/runtime/control-plane/workspace/workspace-store';
import {
  activateCognitiveMemory,
  auditCognitiveMemory,
} from '../../../src/runtime/control-plane/persistence/cognition-store';
import {
  cognitiveUsageFeedbackForContext,
  resolveCognitiveAttention,
} from '../../../src/runtime/context/cognitive-attention';
import { invalidFacadeOperation } from './status-inbox-adapter';
import { summarizeExecutionJob } from './runtime-tool-shared';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';

const RH_CONTEXT_RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RH_CONTEXT_AUTOMATIC_RECALL_LIMIT = 4;
const RH_CONTEXT_SEMANTIC_EVIDENCE_LIMIT = 64;

function timestampIsRecent(value: string | undefined, cutoffMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoffMs;
}

function rhContextKnowledgeAuditRequested(args: Record<string, unknown>): boolean {
  return (
    [
      'knowledge_query',
      'knowledge_memory_id',
      'knowledge_scope_kind',
      'knowledge_scope_id',
      'knowledge_concept',
      'knowledge_facet',
      'knowledge_source_kind',
    ].some((key) => typeof args[key] === 'string' && String(args[key]).trim().length > 0) ||
    typeof args.knowledge_limit === 'number'
  );
}

function rhContextKnowledgeScopes(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
): { scopes: ScopeRef[]; projectId?: string; gaps: string[] } {
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
  const resolved = rhContextKnowledgeScopes(ctx, repository);
  const requestedKind = typeof args.knowledge_scope_kind === 'string' ? args.knowledge_scope_kind.trim() : '';
  const requestedId = typeof args.knowledge_scope_id === 'string' ? args.knowledge_scope_id.trim() : '';
  const scopes = resolved.scopes.filter(
    (scope) => (!requestedKind || scope.kind === requestedKind) && (!requestedId || scope.id === requestedId),
  );
  const scopeMismatch = resolved.scopes.length > 0 && scopes.length === 0 && Boolean(requestedKind || requestedId);
  const rawQuery = typeof args.knowledge_query === 'string' ? args.knowledge_query.trim() : '';
  const query = rawQuery === '*' ? '' : rawQuery;
  const audit = auditCognitiveMemory(ctx.controllerHome, {
    scopes,
    ...(query ? { query } : {}),
    ...(typeof args.knowledge_memory_id === 'string' && args.knowledge_memory_id.trim()
      ? { memoryId: args.knowledge_memory_id.trim() }
      : {}),
    ...(typeof args.knowledge_concept === 'string' && args.knowledge_concept.trim()
      ? { concept: args.knowledge_concept.trim() }
      : {}),
    ...(typeof args.knowledge_facet === 'string' && args.knowledge_facet.trim()
      ? { facet: args.knowledge_facet.trim() }
      : {}),
    ...(typeof args.knowledge_source_kind === 'string' && args.knowledge_source_kind.trim()
      ? {
          sourceKind: args.knowledge_source_kind.trim() as
            | 'experience'
            | 'outcome'
            | 'knowledge'
            | 'controller'
            | 'system'
            | 'external',
        }
      : {}),
    ...(typeof args.knowledge_limit === 'number' ? { limit: args.knowledge_limit } : {}),
  });
  const usage = cognitiveUsageFeedbackForContext({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    scopes,
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
  });
  const usageByAddress = new Map(usage.map((item) => [memoryAddressKey(item.address), item]));
  const activation = query
    ? activateCognitiveMemory(ctx.controllerHome, scopes, query, {
        maxItems: Math.min(
          32,
          Math.max(1, typeof args.knowledge_limit === 'number' ? Math.trunc(args.knowledge_limit) : 24),
        ),
        usageFeedback: usage,
      })
    : undefined;
  const activationByAddress = new Map(
    (activation?.items ?? []).map((item) => [
      memoryAddressKey({ scope: item.memory.scope, id: item.memory.id }),
      { score: item.score, reasons: item.reasons, activationPath: item.activationPath },
    ]),
  );
  return {
    readonly: true,
    advisoryOnly: true,
    authorityBoundary:
      'Learned memory never overrides project contracts, authorization, verification, Requirement/Plan, or semantic acceptance.',
    scopes,
    filters: {
      ...(rawQuery ? { query: rawQuery } : {}),
      ...(requestedKind ? { scopeKind: requestedKind } : {}),
      ...(requestedId ? { scopeId: requestedId } : {}),
      ...(typeof args.knowledge_memory_id === 'string' && args.knowledge_memory_id.trim()
        ? { memoryId: args.knowledge_memory_id.trim() }
        : {}),
      ...(typeof args.knowledge_concept === 'string' && args.knowledge_concept.trim()
        ? { concept: args.knowledge_concept.trim() }
        : {}),
      ...(typeof args.knowledge_facet === 'string' && args.knowledge_facet.trim()
        ? { facet: args.knowledge_facet.trim() }
        : {}),
      ...(typeof args.knowledge_source_kind === 'string' && args.knowledge_source_kind.trim()
        ? { sourceKind: args.knowledge_source_kind.trim() }
        : {}),
    },
    items: audit.items.map((entry) => {
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

function rhContextLearningRecall(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  query: string,
  queryVariants: readonly string[] = [],
  limit = RH_CONTEXT_AUTOMATIC_RECALL_LIMIT,
): Record<string, unknown> {
  const resolved = rhContextKnowledgeScopes(ctx, repository);
  if (!query.trim() || resolved.scopes.length === 0) {
    return { advisoryOnly: true, scopes: resolved.scopes, items: [], gaps: resolved.gaps };
  }
  const usage = cognitiveUsageFeedbackForContext({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    scopes: resolved.scopes,
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
  });
  const activation = resolveCognitiveAttention({
    controllerHome: ctx.controllerHome,
    scopes: resolved.scopes,
    query: query.slice(0, 4_000),
    queryVariants,
    now: new Date().toISOString(),
    maxItems: Math.min(8, Math.max(1, limit)),
    maxBytes: 12 * 1024,
    usageFeedback: usage,
  });
  const usageByAddress = new Map(usage.map((item) => [memoryAddressKey(item.address), item]));
  return {
    advisoryOnly: true,
    authorityBoundary:
      'Learned context may guide model decisions but never grants execution, lifecycle, or acceptance authority.',
    scopePolicy: 'unified_relevance_with_narrow_scope_prior',
    scopes: resolved.scopes,
    items: activation.items.map((entry) => ({
      memoryId: memoryAddressKey({ scope: entry.memory.scope, id: entry.memory.id }),
      text: entry.memory.canonicalText,
      score: entry.score,
      reasons: entry.reasons,
      activationPath: entry.activationPath,
      facets: entry.memory.facets,
      concepts: entry.memory.concepts,
      provenance: entry.memory.provenance,
      // Rejected/stale memory can still have a high lexical match score.
      // Present actual feedback to the model; do not make Forge a semantic
      // supersession judge or silently erase historically useful advice.
      recentUsage: usageByAddress.get(memoryAddressKey({ scope: entry.memory.scope, id: entry.memory.id })),
    })),
    gaps: [...resolved.gaps, ...activation.gaps],
    progressiveAttention: {
      workingSetBounded: true,
      moreCandidatesAvailable: activation.truncated,
      inspectedCandidates: activation.inspectedCandidates,
      modelDecision: activation.truncated
        ? 'This is an initial working set, not semantic completeness. If the current decision still lacks relevant prior context, issue a narrower rh_context query or an explicit knowledge_query/knowledge_limit expansion; otherwise reuse this working set through routine micro-steps.'
        : 'Decide whether this working set is semantically sufficient. Reuse it through routine micro-steps; only recall again when the task meaning/strategy changes or missing prior context could change the decision.',
    },
  };
}

const RH_CONTEXT_SEMANTIC_QUERY_LIMIT = 8;

const RH_CONTEXT_SEMANTIC_LOCATION_LIMIT = 200;

interface RhContextSemanticNavigationProjection {
  requested: number;
  executed: number;
  results: Record<string, unknown>[];
  errors: Array<{ index: number; code: string; message: string }>;
  providers: unknown[];
  policyDeniedLocations: number;
  policyDeniedReads: number;
  materialPolicyDeniedReads: number;
  policyDeniedReadSamples: string[];
  requestTruncated: boolean;
  freshness: 'not_requested' | 'changed_during_query' | 'current_at_query';
  sourceIdentity?: Record<string, unknown>;
  staticClosure: {
    scope: string;
    status: 'not_requested' | 'incomplete' | 'complete_for_requested_symbols';
    limitations: string[];
  };
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
  let materialPolicyDeniedReads = 0;
  const policyDeniedReadSamples = new Set<string>();
  const semanticAccessScope = createHash('sha256')
    .update(JSON.stringify({ profile: policy.profile, readGlobs: policy.readGlobs, denyGlobs: policy.denyGlobs }))
    .digest('hex')
    .slice(0, 20);

  const fingerprintOf = (identity: CachedGitIdentity | undefined): string | undefined =>
    identity
      ? (identity.workingTreeFingerprint ??
        createHash('sha256')
          .update(`${identity.head ?? ''}\n${identity.branch ?? ''}`)
          .digest('hex')
          .slice(0, 24))
      : undefined;
  // Semantic providers are targeted/optional. Reuse a short-lived identity sample at
  // query start, while the post-query fence below remains explicitly fresh. This
  // preserves change-during-query detection without spawning two Git processes for
  // repeated semantic reads inside the identity TTL.
  const sourceBefore = requests.length > 0 ? await cachedGitIdentityAsync(repoRoot) : undefined;
  const sourceFingerprintBefore = fingerprintOf(sourceBefore);
  const indexedRequests: Array<{ index: number; request: SemanticNavigationRequest }> = [];

  requests.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({
        index,
        code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID',
        message: 'semantic_navigation entries must be objects.',
      });
      return;
    }
    const item = entry as Record<string, unknown>;
    const navigation = String(item.navigation ?? '') as SemanticNavigationKind;
    const path = String(item.path ?? '').trim();
    const line = Number(item.line);
    const column = Number(item.column);
    const tsconfigPath =
      typeof item.tsconfig_path === 'string' && item.tsconfig_path.trim() ? item.tsconfig_path.trim() : undefined;
    const language =
      typeof item.language === 'string' && item.language.trim() ? item.language.trim().toLowerCase() : undefined;
    if (
      !['definition', 'references', 'implementations'].includes(navigation) ||
      !path ||
      !Number.isInteger(line) ||
      line < 1 ||
      !Number.isInteger(column) ||
      column < 1
    ) {
      errors.push({
        index,
        code: 'SEMANTIC_NAVIGATION_REQUEST_INVALID',
        message: 'navigation, path, and positive 1-based line/column are required.',
      });
      return;
    }
    const targetDecision = resolveMcpPath(repoRoot, path, policy, 'read');
    if (!targetDecision.ok) {
      errors.push({
        index,
        code: 'SEMANTIC_NAVIGATION_TARGET_DENIED',
        message: targetDecision.reason ?? 'target path denied by MCP read policy.',
      });
      return;
    }
    indexedRequests.push({
      index,
      request: {
        navigation,
        path,
        line,
        column,
        ...(tsconfigPath ? { tsconfigPath } : {}),
        ...(language ? { language } : {}),
      },
    });
  });

  const allowRepositoryPath = (relativePath: string): boolean => {
    const decision = resolveMcpPath(repoRoot, relativePath, policy, 'read');
    if (decision.ok) return true;
    policyDeniedReads += 1;
    if (!isIncidentalSemanticDependencyProbe(relativePath)) materialPolicyDeniedReads += 1;
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
    materialPolicyDeniedReads += Math.max(0, Number(semantic.materialPolicyDeniedReads ?? sidecarDeniedReads));
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
    // With no resolved requested relationship, even dependency-only denied reads
    // may conceal material evidence. Preserve admission blocking for this case.
    if (
      allowedLocations.length === 0 &&
      sidecarDeniedReads > 0 &&
      Number(semantic.materialPolicyDeniedReads ?? sidecarDeniedReads) === 0
    ) {
      materialPolicyDeniedReads += sidecarDeniedReads;
    }
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
      materialPolicyDeniedReads: semantic.materialPolicyDeniedReads ?? semantic.policyDeniedReads ?? 0,
      ...(semantic.details ?? {}),
    });
  }

  results.sort((left, right) => {
    const leftTarget = left.target as { path?: string; line?: number; column?: number } | undefined;
    const rightTarget = right.target as { path?: string; line?: number; column?: number } | undefined;
    return (
      String(leftTarget?.path ?? '').localeCompare(String(rightTarget?.path ?? '')) ||
      Number(leftTarget?.line ?? 0) - Number(rightTarget?.line ?? 0) ||
      Number(leftTarget?.column ?? 0) - Number(rightTarget?.column ?? 0)
    );
  });

  const sourceAfter = requests.length > 0 ? await freshGitIdentityAsync(repoRoot) : undefined;
  const sourceFingerprintAfter = fingerprintOf(sourceAfter);
  const sourceChangedDuringQuery = Boolean(
    sourceBefore &&
      sourceAfter &&
      (sourceBefore.head !== sourceAfter.head || sourceFingerprintBefore !== sourceFingerprintAfter),
  );
  if (sourceChangedDuringQuery) {
    errors.push({
      index: -1,
      code: 'SEMANTIC_SOURCE_CHANGED_DURING_QUERY',
      message:
        'Repository source identity changed while semantic providers were running. Returned locations are retained only as hints for the sampled source and are not proof for the newer source state.',
    });
  }

  const requestTruncated = raw.length > RH_CONTEXT_SEMANTIC_QUERY_LIMIT;
  const incomplete =
    requestTruncated ||
    anyLocationTruncated ||
    policyDeniedLocations > 0 ||
    materialPolicyDeniedReads > 0 ||
    errors.length > 0 ||
    sourceChangedDuringQuery;
  const languages = new Set(results.map((entry) => String(entry.language ?? '')).filter(Boolean));
  const singleLanguage = languages.size === 1 ? [...languages][0] : undefined;
  const scope =
    singleLanguage === 'typescript'
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
    materialPolicyDeniedReads,
    policyDeniedReadSamples: Array.from(policyDeniedReadSamples),
    requestTruncated,
    freshness:
      raw.length === 0 ? 'not_requested' : sourceChangedDuringQuery ? 'changed_during_query' : 'current_at_query',
    ...(sourceBefore
      ? {
          sourceIdentity: {
            repoId: repositoryIdentity.repoId,
            checkoutId: repositoryIdentity.checkoutId,
            branch: sourceBefore.branch,
            head: sourceBefore.head,
            workingTreeFingerprint: sourceFingerprintBefore,
            sampledAt: new Date(sourceBefore.sampledAt).toISOString(),
          },
        }
      : {}),
    staticClosure: {
      scope,
      status: raw.length === 0 ? 'not_requested' : incomplete ? 'incomplete' : 'complete_for_requested_symbols',
      limitations: [
        'dynamic_registration',
        'string_or_config_edges',
        'reflection',
        'runtime_dispatch',
        'stale_or_missing_language_index',
      ],
    },
  };
}

function rhContextSemanticEvidence(semanticNavigation: RhContextSemanticNavigationProjection) {
  const locations = semanticNavigation.results.flatMap((entry) => {
    const target =
      entry.target && typeof entry.target === 'object' && !Array.isArray(entry.target)
        ? (entry.target as Record<string, unknown>)
        : {};
    const values = Array.isArray(entry.locations) ? entry.locations : [];
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const location = value as Record<string, unknown>;
      const path = typeof location.path === 'string' ? location.path : '';
      const line = typeof location.line === 'number' ? location.line : Number.NaN;
      const column = typeof location.column === 'number' ? location.column : Number.NaN;
      if (!path || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return [];
      return [
        {
          provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
          language: typeof entry.language === 'string' ? entry.language : 'unknown',
          navigation: typeof entry.navigation === 'string' ? entry.navigation : 'unknown',
          targetPath: typeof target.path === 'string' ? target.path : '',
          targetLine: typeof target.line === 'number' ? target.line : 0,
          targetColumn: typeof target.column === 'number' ? target.column : 0,
          path,
          line,
          column,
          ...(typeof location.name === 'string' ? { name: location.name } : {}),
          ...(typeof location.kind === 'string' ? { kind: location.kind } : {}),
        },
      ];
    });
  });
  const totalLocations = semanticNavigation.results.reduce(
    (total, entry) =>
      total +
      (typeof entry.totalLocations === 'number'
        ? entry.totalLocations
        : Array.isArray(entry.locations)
          ? entry.locations.length
          : 0),
    0,
  );
  return {
    requested: semanticNavigation.requested,
    resultCount: semanticNavigation.results.length,
    totalLocations,
    returnedLocations: Math.min(locations.length, RH_CONTEXT_SEMANTIC_EVIDENCE_LIMIT),
    truncated:
      semanticNavigation.requestTruncated ||
      locations.length > RH_CONTEXT_SEMANTIC_EVIDENCE_LIMIT ||
      semanticNavigation.results.some((entry) => entry.truncated === true),
    locations: locations.slice(0, RH_CONTEXT_SEMANTIC_EVIDENCE_LIMIT),
  };
}

export async function callContextAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'rh_context') return undefined;
  const operation = String(args.operation ?? 'get');
  const repository = selected(ctx, args);
  if (!allowedFacadeOperations('rh_context').includes(operation)) {
    return invalidFacadeOperation('rh_context', operation);
  }
  const knowledgeAuditRequested = operation === 'get' && rhContextKnowledgeAuditRequested(args);
  const recallQuery = operation === 'get' && typeof args.query === 'string' ? args.query.trim() : '';
  const queryVariants = Array.isArray(args.recall_query_variants)
    ? args.recall_query_variants
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .slice(0, 3)
        .map((value) => value.trim().slice(0, 256))
    : [];
  const explicitSemanticNavigation =
    operation === 'get' && Array.isArray(args.semantic_navigation) ? args.semantic_navigation : [];
  const advisoryReadRequested =
    operation === 'get' && (knowledgeAuditRequested || Boolean(recallQuery) || explicitSemanticNavigation.length > 0);

  if (advisoryReadRequested) {
    const cognitionAudit = knowledgeAuditRequested ? rhContextKnowledgeAudit(ctx, repository, args) : undefined;
    const learningRecall =
      recallQuery && !knowledgeAuditRequested && args.include_learning_recall !== false
        ? rhContextLearningRecall(ctx, repository, recallQuery, queryVariants)
        : undefined;
    const semanticNavigation =
      explicitSemanticNavigation.length > 0
        ? await rhContextSemanticNavigation(repository.canonicalRoot, ctx.policy, explicitSemanticNavigation, {
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          })
        : undefined;
    const semanticEvidence = semanticNavigation ? rhContextSemanticEvidence(semanticNavigation) : undefined;
    const semanticFailed =
      Boolean(semanticNavigation) &&
      semanticNavigation!.requested > 0 &&
      semanticNavigation!.results.length === 0 &&
      semanticNavigation!.errors.length > 0;
    const detailLevel = args.detail_level === 'detail' || args.detail_level === 'raw' ? args.detail_level : 'summary';
    const auditItems = cognitionAudit && Array.isArray(cognitionAudit.items) ? cognitionAudit.items.length : 0;
    const facade = buildFacadeResult({
      status: semanticFailed ? 'failed' : 'ok',
      summary: semanticNavigation
        ? `Returned explicit semantic navigation for ${semanticNavigation.executed}/${semanticNavigation.requested} request(s).`
        : cognitionAudit
          ? `Retrieved ${auditItems} bounded learned-memory audit item(s).`
          : 'Retrieved bounded advisory Cognitive context.',
      data: {
        operation,
        repoId: repository.repoId,
        ...(cognitionAudit ? { cognitionAudit } : {}),
        ...(learningRecall ? { learningRecall } : {}),
        ...(semanticNavigation ? { semanticNavigation } : {}),
        ...(semanticEvidence ? { semanticEvidence } : {}),
      },
      warnings: [],
      suggestedNextActions: [],
      detailLevel,
      rawAvailable: false,
    });
    const data = facade.data as typeof facade.data & {
      cognitionAudit?: typeof cognitionAudit;
      learningRecall?: typeof learningRecall;
      semanticNavigation?: typeof semanticNavigation;
      semanticEvidence?: typeof semanticEvidence;
    };
    if (cognitionAudit) data.cognitionAudit = cognitionAudit;
    if (learningRecall) data.learningRecall = learningRecall;
    if (semanticNavigation) data.semanticNavigation = semanticNavigation;
    if (semanticEvidence) data.semanticEvidence = semanticEvidence;
    return result(facade as unknown as Record<string, unknown>, semanticFailed);
  }

  const startedAt = performance.now();
  const requestedCapabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  if (requestedCapabilityId) {
    const pluginMatch = /^plugin\.([^.]+)\.(.+)$/.exec(requestedCapabilityId);
    const manifests = pluginMatch
      ? (() => {
          const pluginId = pluginMatch[1];
          try {
            const actionId = pluginMatch[2];
            // Exact iPhone action schemas do not require the unrelated Controller
            // legacy migration. All other capability reads keep the usual path.
            return [
              pluginId === 'computer' && actionId.startsWith('physical_device_')
                ? getAssistantPluginManifestForAction(ctx.controllerHome, repository, { pluginId, actionId })
                : getAssistantPluginManifest(ctx.controllerHome, repository, pluginId),
            ];
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('PLUGIN_NOT_FOUND:')) throw error;
          }
          try {
            return [getControllerPluginManifest(ctx.controllerHome, pluginId)];
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('PLUGIN_NOT_FOUND:')) throw error;
          }
          return [];
        })()
      : [];
    const descriptor = getCapabilityDescriptor(requestedCapabilityId, manifests);
    const coreCapability = getCoreCapabilityExecutionSchema(requestedCapabilityId);
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
          coreCapability,
          pluginAction,
        },
        toolArchitecture: {
          facadeTools: [...FACADE_TOOLS],
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
    const serialized = serializeResultPayload(payload);
    return result(payload, false, serialized.text);
  }
  const capabilityIntentQuery = operation === 'list' && typeof args.query === 'string' ? args.query.trim() : '';
  if (capabilityIntentQuery) {
    // Intent-ranked capability discovery must reflect the executable plugin contract.
    // Persisted manifests are status projections and may outlive a source release that moved an action.
    const manifestOptions = { preferStored: false };
    const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
    const controllerManifests = listControllerPluginManifests(ctx.controllerHome, manifestOptions);
    const manifests = [
      ...new Map(
        [...controllerManifests, ...repositoryManifests].map((manifest) => [manifest.pluginId, manifest] as const),
      ).values(),
    ];
    const matches = searchCapabilityDescriptors(capabilityIntentQuery, manifests, 12).map((match) => ({
      ...match,
      coreCapability: getCoreCapabilityExecutionSchema(match.capabilityId),
      pluginAction: getPluginActionCapabilitySchema(match.capabilityId, manifests),
    }));
    const facade = buildFacadeResult({
      status: 'ok',
      summary:
        matches.length > 0
          ? `Found ${matches.length} capability candidate(s) for intent: ${capabilityIntentQuery}`
          : `No capability candidates matched intent: ${capabilityIntentQuery}`,
      data: {
        operation,
        repoId: repository.repoId,
        capabilitySearch: {
          query: capabilityIntentQuery,
          matches,
          readOnlyDiscovery: true,
          executeWith: 'capability-specific',
        },
        toolArchitecture: {
          facadeTools: [...FACADE_TOOLS],
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
  const recentActivityCutoffMs = Date.now() - RH_CONTEXT_RECENT_ACTIVITY_WINDOW_MS;
  const recentJobs = !isSummary
    ? listExecutionJobs(ctx.controllerHome, repository.repoId, 20)
        .filter((job) => timestampIsRecent(job.updatedAt, recentActivityCutoffMs))
        .slice(0, 5)
    : [];
  const processScan = isSummary
    ? listRecoverableProcessRecords(ctx.controllerHome, repository.repoId)
    : listProcessRecords(ctx.controllerHome, repository.repoId, 50);
  const relevantProcesses = processScan.filter((process) =>
    timestampIsRecent(process.updatedAt, recentActivityCutoffMs),
  );
  const liveProcessIds = new Set(processRuntimeResourceDiagnostics().activeProcessIds);
  const activeProcesses = relevantProcesses.filter(
    (process) => liveProcessIds.has(process.processId) && isManagedProcessActive(process),
  );
  const manifestOptions = { preferStored: true };
  const manifests = isSummary
    ? []
    : (() => {
        const repositoryManifests = listAssistantPluginManifests(ctx.controllerHome, repository, manifestOptions);
        const controllerManifests = listControllerPluginManifests(ctx.controllerHome, manifestOptions);
        return [
          ...new Map(
            [...repositoryManifests, ...controllerManifests].map((manifest) => [manifest.pluginId, manifest] as const),
          ).values(),
        ];
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
  // Current UserRequests and processes cannot be selected by a retired Work.
  const currentAttentionItems = isSummary ? currentAttentionScan.slice(0, 3) : currentAttentionScan;
  const attention = isSummary
    ? currentAttentionItems.map((item) => ({
        id: item.id,
        title: item.title.slice(0, 96),
        severity: item.severity,
        reason: item.reason.slice(0, 160),
        blockingDecision: item.blockingDecision?.slice(0, 160),
        updatedAt: item.updatedAt,
      }))
    : currentAttentionItems.map(summarizeHandoffItem);
  const detailCheckCandidates =
    requested.length > 0
      ? selectedChecks
      : checks.map((check) => ({ id: check.id, description: check.description, source: check.source }));
  const checkSummaries = isSummary ? selectedChecks : detailCheckCandidates.slice(0, 24);
  const detailArguments = {
    repo_id: repository.repoId,
    operation,
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
      reason:
        'Repository summary does not hydrate plugin manifests; request capability_id or detail/raw only when schema/policy detail is needed.',
    },
    capabilityLookup,
    toolArchitecture: {
      facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_project'],
      domainSchemaLoading: 'static_stable_surface',
    },
    activeProcesses: activeProcesses.slice(0, 3).map((process) => ({
      processId: process.processId,
      status: process.status,
      route: process.route,
      startedAt: process.startedAt,
      updatedAt: process.updatedAt,
    })),
    recentProcesses: relevantProcesses.slice(0, 5).map((process) => ({
      processId: process.processId,
      status: process.status,
      route: process.route,
      startedAt: process.startedAt,
      updatedAt: process.updatedAt,
    })),
    activeAttention: attention,
    counts: {
      availableChecks: checks.length,
      selectedChecks: selectedChecks.length,
      capabilityInventoryDeferred: true,
      currentAttention: currentAttentionScan.length,
      repositoryAttention: currentAttentionScan.length,
      currentAttentionShown: attention.length,
      activeProcesses: activeProcesses.length,
      recentProcesses: relevantProcesses.length,
      historicalProcessScanDeferred: true,
      pendingAttentionScanned: pendingAttention.length,
      historicalPendingAttention: Math.max(0, pendingAttention.length - currentAttentionScan.length),
      omittedCurrentAttention: Math.max(0, currentAttentionScan.length - attention.length),
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
      facadeTools: ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_project'],
      atomicTypedToolsRetained: true,
      internalHandlersRetained: true,
      domainSchemaLoading: 'static_stable_surface',
      dynamicDomainSchemaLoadingSupported: false,
    },
    activeProcesses: activeProcesses.slice(0, 10),
    recentProcesses: relevantProcesses.slice(0, 20),
    recentExecutionJobs: recentJobs.map((job) => summarizeExecutionJob(job, repository.canonicalRoot)),
    activeAttention: attention,
    counts: {
      availableChecks: checks.length,
      selectedChecks: selectedChecks.length,
      capabilities: capabilities.length,
      recentExecutionJobs: recentJobs.length,
      activeProcesses: activeProcesses.length,
      recentProcesses: relevantProcesses.length,
      activeAttention: attention.length,
    },
    bounded: true,
  };
  const facade = buildFacadeResult({
    status: 'ok',
    summary: 'Bounded repository context is available.',
    data: isSummary ? summaryData : detailData,
    warnings: normalizedChecks.warnings,
    suggestedNextActions: normalizedChecks.suggestedNextActions,
    detailLevel,
    rawAvailable: detailLevel === 'raw',
  });
  const payload = facade as unknown as Record<string, unknown>;
  if (isSummary) {
    payload.responseMeta = {
      serverDurationMs: Number((performance.now() - startedAt).toFixed(2)),
      structuredPayloadBytes: 0,
    };
  }
  const serialized = serializeResultPayload(payload);
  return result(payload, false, serialized.text);
}
