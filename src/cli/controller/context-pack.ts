import {
  gitSnapshot,
  getRepositoryReadSessionCache,
  searchRepositoryMany,
  searchRepositoryManyAsync,
  searchRepositoryManyCacheIdentity,
} from "../repository/inspector";
import { globMatches } from "../mcp/paths";
import type { McpPolicy } from "../mcp/types";
import { materializeSource } from "./context/source-materializer";
import { projectBoard } from "./issue-store";
import { buildControllerTaskLedgerProjection } from "./task-ledger";
import { legacyIssueAuthorityRetired } from "./legacy-issue-cutover";
import {
  queryCodeGraphReadProvider,
  queryCodeGraphReadProviderAsync,
  type CodeGraphNodeSummary,
  type CodeGraphReadProviderResponse,
} from "../../runtime/context/codegraph-read-provider";
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  CONTROLLER_CONTEXT_IMPACT_DOMAINS,
  type ControllerContextImpactDomain,
  type ControllerContextPackDependencies,
  type ControllerContextPackFile,
  type ControllerContextPackOptions,
  type ControllerContextPackProjection,
  type ControllerContextPackSnippet,
} from './context/types';
import {
  DEFAULT_MAX_CHARS_PER_SNIPPET,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_SNIPPETS,
  DEFAULT_SEARCH_EXCLUDE_GLOBS,
  IMPACT_DOMAIN_TERMS,
  MAX_TOTAL_SEARCHED_FILES,
  clamp,
  cleanList,
  gitStatusChangedPaths,
  isCodeShapedTerm,
  pathNoisePenalty,
  structuralIntentQuery,
  textTokens,
} from './context/query-planning';
import { issueTaskFocus, ledgerTask } from './context/focus';
import { addReason, coveredByGlob, expandKnownPath, looksLikeGlob, readableFile } from './context/known-paths';
import { structuralResult } from './context/structural';
import { buildRepositoryInstructionContext } from './context/instruction-context';
import { resolveRepositoryGovernance } from './context/rule-resolution';
import { controllerCheckSelection, listControllerChecks } from './check-runner';

export { CONTROLLER_CONTEXT_IMPACT_DOMAINS } from './context/types';
export type {
  ControllerContextImpactDomain,
  ControllerContextPackDependencies,
  ControllerContextPackFile,
  ControllerContextPackOptions,
  ControllerContextPackProjection,
  ControllerContextPackSnippet,
  ControllerContextRetrievalMode,
  StructuralContextMode,
} from './context/types';

export function buildControllerContextPack(
  repoRoot: string,
  policy: McpPolicy,
  options: ControllerContextPackOptions = {},
  dependencies: ControllerContextPackDependencies = {},
): ControllerContextPackProjection {
  const contextStartedAt = performance.now();
  const timingsMs = { gitAndFocus: 0, structural: 0, lexical: 0, materialization: 0, governance: 0, total: 0 };
  const retrievalMode = options.retrievalMode ?? "implementation";
  const requestedMaxFiles = clamp(options.maxFiles, DEFAULT_MAX_FILES, 1, 30);
  const requestedMaxSnippets = clamp(options.maxSnippets, DEFAULT_MAX_SNIPPETS, 1, 80);
  let maxFiles = requestedMaxFiles;
  let maxSnippets = requestedMaxSnippets;
  const maxCharsPerSnippet = clamp(options.maxCharsPerSnippet, DEFAULT_MAX_CHARS_PER_SNIPPET, 500, 50_000);
  const knownPaths = cleanList(options.knownPaths);
  const knownGlobs = knownPaths.filter(looksLikeGlob);
  const explicitKnownPaths = knownPaths.filter((path) => !looksLikeGlob(path));
  const includeGlobs = cleanList([...(options.includeGlobs ?? []), ...knownGlobs]);
  // Runtime state, generated artifacts and backup files are never useful source
  // evidence. Exclude them by default so a broad investigation cannot scan the
  // controller home or return stale backup code. Caller exclusions remain additive.
  const excludeGlobs = cleanList([...DEFAULT_SEARCH_EXCLUDE_GLOBS, ...(options.excludeGlobs ?? [])]);
  // Independent investigations must not inherit an unrelated repository focus.
  // Only bind Issue/Task context when the caller explicitly requests it.
  const hasExplicitFocus = Boolean(options.issueId || options.taskId);
  const git = gitSnapshot(repoRoot, options.session);
  const board = hasExplicitFocus && !legacyIssueAuthorityRetired(repoRoot) ? projectBoard(repoRoot) : undefined;
  const focus = board ? issueTaskFocus(board, options.issueId, options.taskId) : {};
  const ledger = board ? buildControllerTaskLedgerProjection(repoRoot, board) : undefined;
  const compactTask = ledger ? ledgerTask(ledger, focus.issue?.id, focus.task?.id) : undefined;
  timingsMs.gitAndFocus = Math.round((performance.now() - contextStartedAt) * 100) / 100;
  // Work allowed paths are an authorization boundary, not a claim that early
  // investigation already discovered the complete semantic scope. Only an
  // explicit retrieval include narrows discovery.
  const searchIncludeGlobs = includeGlobs;
  const taskChecks = cleanList(compactTask?.checks);
  const goalParts = [
    options.description,
    focus.issue?.title,
    focus.issue?.summary,
    focus.task?.title,
    focus.task?.objective,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const goal = goalParts.join("\n").trim();
  const terms = cleanList([...(options.searchTerms ?? []), ...textTokens(goal)]).slice(0, 14);
  const impactDomains = cleanList(options.impactDomains)
    .filter((domain): domain is ControllerContextImpactDomain => CONTROLLER_CONTEXT_IMPACT_DOMAINS.includes(domain as ControllerContextImpactDomain))
    .slice(0, 6);
  const retrievalIntent = [goal, ...terms].filter(Boolean).join(" ");
  const impactTermDomains = new Map<string, ControllerContextImpactDomain[]>();
  for (const domain of impactDomains) {
    for (const term of IMPACT_DOMAIN_TERMS[domain]) {
      const existing = impactTermDomains.get(term) ?? [];
      if (!existing.includes(domain)) existing.push(domain);
      impactTermDomains.set(term, existing);
    }
  }
  const searchQueries = cleanList([
    ...(terms[0] ? [terms[0]] : []),
    ...impactDomains.flatMap((domain) => IMPACT_DOMAIN_TERMS[domain]),
    ...terms.slice(1),
  ]).slice(0, 32);
  // Preserve the guarantee for explicit code symbols while broad natural-
  // language terms remain eligible for early discovery completion.
  const requiredSearchQueries = cleanList(options.searchTerms)
    .filter(isCodeShapedTerm)
    .slice(0, 2);
  const impactCandidatePaths = new Map<ControllerContextImpactDomain, Set<string>>(impactDomains.map((domain) => [domain, new Set<string>()]));
  const candidates = new Map<string, { reasons: Set<string>; lines: Set<number> }>();
  const deniedPaths: Array<{ path: string; reason: string }> = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let searchTruncated = false;
  let lexicalCacheHit = false;
  let structuralCacheHits = 0;
  let structuralCacheMisses = 0;
  let rangeCacheHits = 0;
  let rangeCacheMisses = 0;
  const structuralMode = options.structuralContext ?? "off";
  const structuralIndexRoot = options.structuralIndexRoot?.trim() || repoRoot;
  const indexSource = structuralIndexRoot === repoRoot ? "current_checkout" : "repository_baseline";
  let overlayChangedFiles = indexSource === "repository_baseline" ? gitStatusChangedPaths(git.status) : [];
  const baselineRevisionMatches = indexSource === "current_checkout" || gitSnapshot(structuralIndexRoot).head === git.head;
  const graphImpactFiles = new Set<string>();
  let structuralContext: ControllerContextPackProjection["structuralContext"] = {
    provider: "codegraph",
    requestedMode: structuralMode,
    status: "disabled",
    requiredSatisfied: structuralMode !== "required",
    indexSource,
    overlayChangedFiles,
    baselineRevisionMatches,
    entryPoints: [],
    relatedFiles: [],
    truncated: false,
  };
  const repositorySessionCache = getRepositoryReadSessionCache(repoRoot, options.session);
  const queryCodeGraph = dependencies.queryCodeGraph ?? queryCodeGraphReadProvider;
  const queryStructural = (queryRoot: string, request: Parameters<typeof queryCodeGraphReadProvider>[1]): CodeGraphReadProviderResponse => {
    const key = JSON.stringify({ queryRoot, request });
    const cached = repositorySessionCache?.getStructural(key);
    if (cached && typeof cached === "object") {
      structuralCacheHits += 1;
      return cached as CodeGraphReadProviderResponse;
    }
    structuralCacheMisses += 1;
    const response = queryCodeGraph(queryRoot, request);
    repositorySessionCache?.putStructural(key, response);
    return response;
  };

  const structuralStartedAt = performance.now();
  if (structuralMode !== "off") {
    const structuralQuery = structuralIntentQuery(goal, terms, impactDomains);
    if (!structuralQuery) {
      structuralContext = {
        ...structuralContext,
        status: "degraded",
        requiredSatisfied: false,
        fallbackReason: "No task description or search term was available for structural context.",
      };
    } else {
      const structural = queryStructural(structuralIndexRoot, {
        operation: "context",
        query: structuralQuery,
        limit: Math.min(Math.max(maxFiles, 4), 12),
        maxNodes: Math.min(Math.max(maxFiles * 5, 20), 60),
        maxDepth: 2,
      });
      const graph = structuralResult(structural);
      const metadata = structural.metadata
        ? {
            initialized: structural.metadata.initialized,
            lastIndexedAt: structural.metadata.lastIndexedAt,
            buildVersion: structural.metadata.buildVersion,
            extractionVersion: structural.metadata.extractionVersion,
            staleEngine: structural.metadata.staleEngine,
            changedFiles: structural.metadata.changedFiles,
            ignoredChangedFileCount: structural.metadata.ignoredChangedFileCount,
          }
        : undefined;
      const providerChangedFiles = metadata
        ? [...metadata.changedFiles.added, ...metadata.changedFiles.modified]
        : [];
      overlayChangedFiles = Array.from(new Set([...overlayChangedFiles, ...providerChangedFiles]));
      structuralContext = {
        provider: "codegraph",
        requestedMode: structuralMode,
        status: indexSource === "repository_baseline" && (!baselineRevisionMatches || overlayChangedFiles.length > 0) && structural.status === "ready" ? "stale" : structural.status,
        requiredSatisfied: structuralMode !== "required" || (structural.status === "ready" && baselineRevisionMatches && overlayChangedFiles.length === 0),
        indexSource,
        overlayChangedFiles,
        baselineRevisionMatches,
        query: structuralQuery,
        entryPoints: graph.entryPoints
          .filter((node) => pathNoisePenalty(node.filePath, retrievalIntent, retrievalMode) < 15)
          .slice(0, 12).map((node) => ({
          id: node.id,
          kind: node.kind,
          name: node.name,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
        })),
        relatedFiles: Array.from(new Set(graph.relatedFiles))
          .filter((path) => pathNoisePenalty(path, retrievalIntent, retrievalMode) < 50)
          .slice(0, 80),
        metadata,
        ...(structural.error ? { fallbackReason: `${structural.error.code}: ${structural.error.message}` } : {}),
        timingsMs: structural.timingsMs,
        truncated: graph.truncated,
      };

      const addStructuralPath = (path: string, reason: string, line?: number): void => {
        if (!path || !coveredByGlob(path, searchIncludeGlobs) || excludeGlobs.some((glob) => globMatches(glob, path))) return;
        const readable = readableFile(repoRoot, policy, path);
        if (!readable.ok) {
          deniedPaths.push({ path: readable.path, reason: readable.reason });
          return;
        }
        addReason(candidates, readable.path, reason, line);
      };
      for (const node of graph.nodes.slice(0, maxFiles * 6)) {
        addStructuralPath(node.filePath, `codegraph:context:${node.kind}:${node.name}`, node.startLine);
      }
      for (const node of graph.entryPoints) {
        addStructuralPath(node.filePath, `codegraph:entry:${node.name}`, node.startLine);
      }
      for (const path of graph.relatedFiles.slice(0, maxFiles * 6)) addStructuralPath(path, "codegraph:related");
      // Context search identifies the structural entry points. For a bounded
      // number of those files, enrich the same Context Plane call with direct
      // file dependencies/dependents. This is impact evidence, not a second
      // routing/tool surface, and remains completely off for ordinary Direct.
      if (structural.status === "ready") {
        const primaryFiles = Array.from(new Set(graph.entryPoints.map((node) => node.filePath).filter(Boolean))).slice(0, 4);
        for (const filePath of primaryFiles) {
          const adjacency = queryStructural(structuralIndexRoot, { operation: "file_dependencies", filePath, limit: 40 });
          if (!adjacency.ok || adjacency.status !== "ready") continue;
          const dependencies = Array.isArray(adjacency.result?.dependencies)
            ? adjacency.result.dependencies.filter((value): value is string => typeof value === "string")
            : [];
          const dependents = Array.isArray(adjacency.result?.dependents)
            ? adjacency.result.dependents.filter((value): value is string => typeof value === "string")
            : [];
          for (const path of dependencies.slice(0, 40)) {
            graphImpactFiles.add(path);
            addStructuralPath(path, `codegraph:dependency:${filePath}`);
          }
          for (const path of dependents.slice(0, 40)) {
            graphImpactFiles.add(path);
            addStructuralPath(path, `codegraph:dependent:${filePath}`);
          }
        }
      }
      for (const path of metadata?.changedFiles.added ?? []) addStructuralPath(path, "codegraph:changed-file", 1);
      for (const path of metadata?.changedFiles.modified ?? []) addStructuralPath(path, "codegraph:changed-file", 1);
      for (const path of metadata?.changedFiles.removed ?? []) omitted.push({ path, reason: "codegraph reports file removed since index" });
      for (const path of overlayChangedFiles) addStructuralPath(path, "worktree:changed-file", 1);
    }
  }

  timingsMs.structural = Math.round((performance.now() - structuralStartedAt) * 100) / 100;
  const exactKnownFiles: string[] = [];
  let exactKnownFileScope = explicitKnownPaths.length > 0;
  for (const path of explicitKnownPaths) {
    const expanded = expandKnownPath(repoRoot, policy, path, Math.max(maxFiles * 4, 40));
    for (const file of expanded.files) {
      addReason(candidates, file, expanded.directory ? `explicit-known-directory:${expanded.directory}` : "explicit-known-path");
    }
    if (!expanded.directory && expanded.files.length === 1 && expanded.denied.length === 0 && !expanded.truncated) {
      exactKnownFiles.push(expanded.files[0]!);
    } else {
      exactKnownFileScope = false;
    }
    deniedPaths.push(...expanded.denied);
    scannedFiles += expanded.files.length;
    searchTruncated = searchTruncated || expanded.truncated;
  }
  // Exact caller-selected files own a reserved file slot. The inferred-file
  // budget may be smaller, but another ranked candidate must never displace an
  // exact known file. The overall response remains bounded by the hard cap.
  maxFiles = Math.min(30, Math.max(requestedMaxFiles, exactKnownFiles.length));

  // Exact known files are already a caller-selected implementation scope. When
  // no broader impact/structural/include scope was requested, search those files
  // for useful hit lines instead of rereading the whole repository. Planning,
  // debugging, directories and explicit broader scopes retain full discovery.
  const scopedExactKnownFileSearch = exactKnownFileScope
    && retrievalMode === "implementation"
    && structuralMode === "off"
    && impactDomains.length === 0
    && searchIncludeGlobs.length === 0;

  // Lexical retrieval is one bounded pass across candidate files for all terms.
  // The old per-term loop reread the same source files up to 14 times even
  // though inventory itself was cached.
  const lexicalStartedAt = performance.now();
  const requiredStructuralFallbackNeedsLexical = structuralMode === "required" && !structuralContext.requiredSatisfied;
  if (searchQueries.length > 0 && (requiredStructuralFallbackNeedsLexical || candidates.size < maxFiles * 3)) {
    const search = searchRepositoryMany(repoRoot, policy, {
      queries: searchQueries,
      files: scopedExactKnownFileSearch ? exactKnownFiles : undefined,
      includeGlobs: scopedExactKnownFileSearch ? undefined : searchIncludeGlobs,
      excludeGlobs,
      maxResultsPerQuery: Math.max(maxFiles * 4, 12),
      maxFiles: scopedExactKnownFileSearch ? exactKnownFiles.length : MAX_TOTAL_SEARCHED_FILES,
      caseSensitive: false,
      cacheKey: JSON.stringify({ head: git.head, status: git.status, diffStat: git.diffStat }),
      ...(!scopedExactKnownFileSearch ? {
        completionMode: 'discovery' as const,
        discoveryTargetFiles: Math.max(maxFiles * 2, 12),
        discoveryMinQueryCoverage: Math.min(3, searchQueries.length),
        requiredQueries: requiredSearchQueries,
      } : {}),
      session: options.session,
    });
    lexicalCacheHit = search.cacheHit === true;
    scannedFiles += search.scannedFiles;
    policyDeniedFiles += search.policyDeniedFiles;
    skippedLargeFiles += search.skippedLargeFiles;
    skippedBinaryFiles += search.skippedBinaryFiles;
    searchTruncated = searchTruncated || search.truncated;
    for (const hit of search.results) {
      if (!coveredByGlob(hit.path, searchIncludeGlobs) || excludeGlobs.some((glob) => globMatches(glob, hit.path))) continue;
      if (terms.includes(hit.query)) {
        addReason(candidates, hit.path, `search:${hit.query}`, hit.line);
      } else {
        const domains = impactTermDomains.get(hit.query) ?? [];
        if (domains.length === 0) addReason(candidates, hit.path, `search:${hit.query}`, hit.line);
        for (const domain of domains) {
          impactCandidatePaths.get(domain)?.add(hit.path);
          addReason(candidates, hit.path, `impact:${domain}:${hit.query}`, hit.line);
        }
      }
      if (candidates.size >= maxFiles * 3) break;
    }
  }

  timingsMs.lexical = Math.round((performance.now() - lexicalStartedAt) * 100) / 100;
  const primarySearchReason = terms.length > 0 ? `search:${terms[0]}` : undefined;
  const rankedCandidates = Array.from(candidates.entries())
    .map(([path, entry]) => ({ path, reasons: Array.from(entry.reasons), lines: Array.from(entry.lines) }))
    .sort((left, right) => {
      const leftExplicit = left.reasons.includes("explicit-known-path")
        ? 2
        : left.reasons.some((reason) => reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      const rightExplicit = right.reasons.includes("explicit-known-path")
        ? 2
        : right.reasons.some((reason) => reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      if (leftExplicit !== rightExplicit) return rightExplicit - leftExplicit;
      const leftPrimary = primarySearchReason && left.reasons.includes(primarySearchReason) ? 1 : 0;
      const rightPrimary = primarySearchReason && right.reasons.includes(primarySearchReason) ? 1 : 0;
      if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
      const noise = pathNoisePenalty(left.path, retrievalIntent, retrievalMode)
        - pathNoisePenalty(right.path, retrievalIntent, retrievalMode);
      if (noise !== 0) return noise;
      if (left.reasons.length !== right.reasons.length) return right.reasons.length - left.reasons.length;
      if (left.lines.length !== right.lines.length) return right.lines.length - left.lines.length;
      return left.path.localeCompare(right.path);
    });
  const selected = rankedCandidates.slice(0, maxFiles);
  const isExactKnownCandidate = (entry: { reasons: string[] }): boolean => entry.reasons.includes("explicit-known-path");
  const selectedExactKnownCount = selected.filter(isExactKnownCandidate).length;
  // Reserve at least one materialization for every selected exact known file.
  // This may raise a caller's inferred snippet budget, but never beyond the
  // existing hard response cap.
  maxSnippets = Math.min(80, Math.max(requestedMaxSnippets, selectedExactKnownCount));
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  const impactCoverage = impactDomains.map((domain) => {
    const matchedFiles = [...(impactCandidatePaths.get(domain) ?? new Set<string>())].sort();
    const selectedFiles = matchedFiles.filter((path) => selectedPaths.has(path));
    return {
      domain,
      queries: [...IMPACT_DOMAIN_TERMS[domain]],
      matchedFiles: matchedFiles.slice(0, 20),
      selectedFiles: selectedFiles.slice(0, 20),
      omittedFileCount: Math.max(0, matchedFiles.length - selectedFiles.length),
      status: selectedFiles.length > 0 ? "selected" as const : matchedFiles.length > 0 ? "matched_not_selected" as const : "no_evidence" as const,
    };
  });
  for (const entry of rankedCandidates.slice(maxFiles)) omitted.push({ path: entry.path, reason: "max_files" });

  let remainingSnippets = maxSnippets;
  const files: ControllerContextPackFile[] = [];
  const materializationStartedAt = performance.now();
  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
    const entry = selected[selectedIndex]!;
    if (remainingSnippets <= 0) {
      omitted.push({ path: entry.path, reason: "max_snippets" });
      continue;
    }
    const exactKnown = isExactKnownCandidate(entry);
    const exactKnownAfter = selected
      .slice(selectedIndex + 1)
      .filter(isExactKnownCandidate)
      .length;
    const fileSnippetBudget = exactKnown
      ? Math.max(1, remainingSnippets - exactKnownAfter)
      : remainingSnippets;
    let snippets: ControllerContextPackSnippet[] = [];
    try {
      snippets = materializeSource({
        repoRoot,
        policy,
        path: entry.path,
        hitLines: entry.lines.length > 0 ? entry.lines : [1],
        reasons: entry.reasons,
        maxSnippets: Math.min(fileSnippetBudget, remainingSnippets),
        maxCharsPerSnippet,
        session: options.session,
      });
      for (const snippet of snippets) {
        if (snippet.cacheHit) rangeCacheHits += 1;
        else rangeCacheMisses += 1;
      }
      remainingSnippets -= snippets.length;
    } catch (error) {
      deniedPaths.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
    }
    if (snippets.length > 0) {
      files.push({
        path: entry.path,
        reasons: entry.reasons,
        hitLines: Array.from(new Set(entry.lines)).sort((a, b) => a - b).slice(0, 30),
        snippetCount: snippets.length,
        snippets,
      });
    }
  }

  timingsMs.materialization = Math.round((performance.now() - materializationStartedAt) * 100) / 100;
  if (files.length === 0 && terms.length === 0 && explicitKnownPaths.length === 0) {
    omitted.push({ path: "<none>", reason: "No description, search_terms, issue/task focus, or known_paths produced search terms." });
  }

  const rawSnippetTruncated = files.some((file) => file.snippets.some((snippet) => snippet.truncated));
  const expansionSignals = [
    ...(files.length === 0 ? ["no_current_raw_source"] : []),
    ...(rawSnippetTruncated ? ["raw_snippet_truncated"] : []),
    ...(searchTruncated ? ["candidate_search_truncated"] : []),
    ...(structuralContext.truncated ? ["structural_context_truncated"] : []),
    ...(structuralContext.status === "stale" ? ["structural_context_stale"] : []),
    ...(structuralMode === "required" && !structuralContext.requiredSatisfied ? ["required_structural_context_unavailable"] : []),
    ...(policyDeniedFiles > 0 || deniedPaths.length > 0 ? ["policy_denied_candidates"] : []),
    ...(skippedLargeFiles > 0 ? ["large_candidates_skipped"] : []),
    ...impactCoverage.flatMap((coverage) => coverage.status === "no_evidence"
      ? [`impact_domain_without_evidence:${coverage.domain}`]
      : coverage.status === "matched_not_selected"
        ? [`impact_domain_not_selected:${coverage.domain}`]
        : []),
  ];
  const rawCodeRequiredForImplementation = retrievalMode !== "implementation"
    || files.length === 0
    || rawSnippetTruncated;
  const graphEntryPaths = Array.from(new Set(structuralContext.entryPoints.map((entry) => entry.filePath).filter(Boolean))).slice(0, 20);
  const structuralEvidenceCurrent = structuralContext.status === "ready";
  const primaryTargets = structuralEvidenceCurrent ? graphEntryPaths : [];
  const structuralHints = structuralEvidenceCurrent
    ? []
    : Array.from(new Set([...graphEntryPaths, ...graphImpactFiles, ...structuralContext.relatedFiles])).slice(0, 80);
  const structuralUniverse = Array.from(new Set([
    ...graphEntryPaths,
    ...graphImpactFiles,
    ...structuralContext.relatedFiles,
    ...selected.map((entry) => entry.path),
  ])).slice(0, 160);
  const relevantTests = structuralUniverse.filter((path) => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)).slice(0, 40);
  const architectureContracts = structuralUniverse.filter((path) =>
    path === "AGENTS.md"
    || path === "CLAUDE.md"
    || path.startsWith("docs/architecture/")
    || path.startsWith(".ai/context/"),
  ).slice(0, 40);
  const mustInspect = structuralEvidenceCurrent
    ? Array.from(new Set([...primaryTargets, ...graphImpactFiles, ...relevantTests, ...architectureContracts])).slice(0, 80)
    : [];
  const mustInspectSet = new Set(mustInspect);
  const likelyAffected = structuralUniverse.filter((path) => !mustInspectSet.has(path)).slice(0, 80);
  const changedFileCount = structuralContext.metadata
    ? structuralContext.metadata.changedFiles.added.length
      + structuralContext.metadata.changedFiles.modified.length
      + structuralContext.metadata.changedFiles.removed.length
    : 0;
  const coverageGaps = [
    ...(structuralContext.status === "stale" ? ["structural_index_stale"] : []),
    ...(structuralContext.indexSource === "repository_baseline" ? ["structural_repository_baseline_overlay"] : []),
    ...(!structuralContext.baselineRevisionMatches ? ["structural_baseline_revision_mismatch"] : []),
    ...(structuralContext.status === "unavailable" || structuralContext.status === "degraded" ? ["structural_provider_unavailable"] : []),
    ...(structuralContext.truncated ? ["structural_result_truncated"] : []),
    ...(changedFileCount > 0 ? ["structural_index_has_unindexed_changes"] : []),
    ...impactCoverage.filter((coverage) => coverage.status !== "selected").map((coverage) => `impact_domain_${coverage.status}:${coverage.domain}`),
  ];
  const impactContext: ControllerContextPackProjection["impactContext"] = {
    status: structuralMode === "off" ? "not_requested" : structuralContext.status === "ready" ? "ready" : "degraded",
    confidence: structuralContext.status === "ready" && primaryTargets.length > 0 && !structuralContext.truncated
      ? "high"
      : structuralContext.status === "ready" || files.length > 0
        ? "medium"
        : "low",
    primaryTargets,
    structuralHints,
    mustInspect,
    likelyAffected,
    relevantTests,
    relevantChecks: taskChecks,
    architectureContracts,
    coverageGaps: Array.from(new Set(coverageGaps)).slice(0, 40),
    relationSources: [
      ...(structuralMode !== "off" ? ["codegraph" as const] : []),
      ...(files.length > 0 ? ["lexical" as const] : []),
      ...(taskChecks.length > 0 ? ["forge_checks" as const] : []),
    ],
    freshness: {
      structuralStatus: structuralContext.status,
      lastIndexedAt: structuralContext.metadata?.lastIndexedAt,
      changedFileCount,
      indexSource: structuralContext.indexSource,
      overlayChangedFileCount: structuralContext.overlayChangedFiles.length,
      baselineRevisionMatches: structuralContext.baselineRevisionMatches,
    },
  };
  const inspectedFiles = files.map((file) => file.path);
  const instructionContext = buildRepositoryInstructionContext(
    repoRoot,
    policy,
    [...exactKnownFiles, ...inspectedFiles],
    { maxCharsPerContract: Math.min(maxCharsPerSnippet, 12_000) },
  );
  const governanceStartedAt = performance.now();
  const governanceResolution = resolveRepositoryGovernance(repoRoot, policy, {
    goal,
    targetPaths: [...exactKnownFiles, ...inspectedFiles],
    changedPaths: gitStatusChangedPaths(git.status),
  });
  const availableChecks = governanceResolution.recommendedCheckIds.length > 0
    ? new Map(listControllerChecks(repoRoot).map((check) => [check.id, check]))
    : new Map();
  const governanceContext: ControllerContextPackProjection['governanceContext'] = {
    ...governanceResolution,
    recommendedChecks: governanceResolution.recommendedCheckIds.map((checkId) => {
      const check = availableChecks.get(checkId);
      const ruleIds = governanceResolution.activeRules.filter((rule) => rule.checkIds.includes(checkId)).map((rule) => rule.id).sort();
      if (!check) return { checkId, ruleIds, available: false };
      const selection = controllerCheckSelection(check);
      return { checkId, ruleIds, available: true, ...selection };
    }),
    coverageGaps: [
      ...governanceResolution.coverageGaps,
      ...governanceResolution.recommendedCheckIds
        .filter((checkId) => !availableChecks.has(checkId))
        .map((checkId) => `governance_check_unregistered:${checkId}`),
    ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 80),
  };
  if (governanceContext.coverageGaps.length > 0 && governanceContext.status === 'ready') governanceContext.status = 'degraded';
  timingsMs.governance = Math.round((performance.now() - governanceStartedAt) * 100) / 100;
  const inspectedSet = new Set(inspectedFiles);
  const likelyRelatedNotInspected = Array.from(new Set([
    ...rankedCandidates.map((entry) => entry.path),
    ...structuralContext.relatedFiles,
    ...graphImpactFiles,
  ])).filter((path) => !inspectedSet.has(path)).slice(0, 80);
  const materializedExactKnownPaths = files
    .filter((file) => file.reasons.includes("explicit-known-path"))
    .map((file) => file.path);
  const materializedExactKnownSet = new Set(materializedExactKnownPaths);
  const unresolvedRelationships = Array.from(new Set([
    ...coverageGaps,
    ...expansionSignals,
    ...(likelyRelatedNotInspected.length > 0 ? ["likely_related_files_not_inspected"] : []),
  ])).slice(0, 80);
  timingsMs.total = Math.round((performance.now() - contextStartedAt) * 100) / 100;

  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "controller-context-pack",
    focus: {
      issueId: focus.issue?.id,
      issueTitle: focus.issue?.title,
      taskId: focus.task?.id,
      taskTitle: focus.task?.title,
      taskStatus: compactTask?.effectiveStatus ?? focus.task?.status,
    },
    goal,
    git,
    search: {
      terms: searchQueries,
      impactDomains,
      impactCoverage,
      includeGlobs: searchIncludeGlobs,
      excludeGlobs,
      scannedFiles,
      policyDeniedFiles,
      skippedLargeFiles,
      skippedBinaryFiles,
      truncated: searchTruncated,
      cacheHit: lexicalCacheHit,
    },
    instructionContext,
    governanceContext,
    structuralContext,
    impactContext,
    files,
    coverage: {
      inspectedFiles,
      likelyRelatedNotInspected,
      unresolvedRelationships,
      relevantTests,
      exactKnownPaths: {
        requested: exactKnownFiles,
        materialized: materializedExactKnownPaths,
        missing: exactKnownFiles.filter((path) => !materializedExactKnownSet.has(path)),
      },
      skippedCandidates: {
        omittedFiles: Math.max(0, rankedCandidates.length - selected.length),
        policyDeniedFiles: policyDeniedFiles + deniedPaths.length,
        largeFiles: skippedLargeFiles,
        binaryFiles: skippedBinaryFiles,
        searchTruncated,
        structuralTruncated: structuralContext.truncated,
      },
      materialization: {
        completeFiles: files.flatMap((file) => file.snippets).filter((snippet) => snippet.materialization === "complete_file").length,
        symbols: files.flatMap((file) => file.snippets).filter((snippet) => snippet.materialization === "symbol").length,
        fallbackWindows: files.flatMap((file) => file.snippets).filter((snippet) => snippet.materialization === "line_window").length,
      },
    },
    cache: {
      sessionBound: Boolean(options.session),
      lexicalHit: lexicalCacheHit,
      structuralHits: structuralCacheHits,
      structuralMisses: structuralCacheMisses,
      rangeHits: rangeCacheHits,
      rangeMisses: rangeCacheMisses,
      reused: lexicalCacheHit || structuralCacheHits > 0 || rangeCacheHits > 0,
    },
    timingsMs,
    deniedPaths: deniedPaths.slice(0, 20),
    omitted: omitted.slice(0, 30),
    limits: {
      maxFiles,
      maxSnippets,
      maxCharsPerSnippet,
      requestedMaxFiles,
      requestedMaxSnippets,
      reservedExactKnownFiles: selectedExactKnownCount,
    },
    validation: {
      policy: taskChecks.length > 0 ? "task-targeted" : "minimal",
      checks: taskChecks,
    },
    contextContract: {
      strategy: retrievalMode === "implementation"
        ? "Use one broad current-source pack to discover credible entry points, then progressively expand from returned paths and symbols. Lexical terms are heuristic hints rather than completeness requirements. ChatGPT owns semantic sufficiency and should prefer targeted known_paths, compiler semantic navigation for concrete TypeScript symbols, or structural relationships before repeating broad lexical discovery."
        : "Use this pack as progressive investigation evidence and repeat rh_context to expand exact ranges, symbols, relationships, tests, or neighboring modules whenever that can improve the plan, diagnosis, or review.",
      retrievalMode,
      semanticSufficiencyAuthority: "chatgpt",
      rawCodeRequiredForImplementation,
      expansionSignals,
      notes: [
        retrievalMode === "implementation"
          ? "The pack contains policy-approved current raw source with file SHA identities, but returned snippets are bounded evidence rather than proof of semantic completeness. After reading this evidence, derive new exact paths, symbols, tests, or relationships from the source itself. A guessed lexical term with no result is not by itself a reason to keep scanning or repeat the same broad query."
          : "Investigation modes may intentionally expand exact ranges, structural relationships, tests, and neighboring modules before any implementation decision.",
        "Search/CodeGraph ranking is discovery evidence, not a business-semantics authority. impactContext makes the bounded evidence surface and coverage gaps explicit; ChatGPT still decides semantic sufficiency.",
        instructionContext.contracts.length > 0
          ? `Applicable repository guidance was resolved hierarchically for selected source paths: ${instructionContext.contracts.map((entry) => entry.path).join(", ")}. These AGENTS.md/CLAUDE.md files are guidance-only evidence and do not define semantic scope.`
          : "No applicable AGENTS.md/CLAUDE.md guidance file was found for the selected source paths.",
        impactDomains.length > 0 ? `Impact domains were selected by ChatGPT and expanded mechanically in this same retrieval call: ${impactDomains.join(", ")}. Missing or omitted domain evidence is an ambiguity signal, not proof that the domain is irrelevant.` : "No explicit cross-cutting impact domains were requested; ChatGPT may add them when state, scheduling, notifications, events, caching, API, or concurrency could materially change the implementation.",
        governanceContext.status === 'none'
          ? "No repository governance rule registry is present; existing guidance and explicit Task checks behave as before."
          : `Repository governance resolved ${governanceContext.activeRules.length} active rule(s), ${governanceContext.suppressedRules.length} suppressed rule(s), and ${governanceContext.recommendedCheckIds.length} recommended check(s) through bounded local matching. Recommendations are evidence only and never execute checks or create Work by themselves.`,
        "CodeGraph structural evidence is discovery evidence. Raw source access still passes through Forge repository policy and current-file reads.",
        structuralContext.status === "stale" ? "CodeGraph reports stale structural evidence. Treat graph relationships as hints and prefer the returned current raw source for changed files." : structuralContext.status === "unavailable" || structuralContext.status === "degraded" ? "Structural context was unavailable or degraded; bounded text search remains the fallback." : structuralContext.status === "ready" ? "CodeGraph structural context was queried read-only with index sync disabled." : "Structural context was not requested.",
        "Run focused validation after a coherent edit batch; expensive full-suite checks belong at candidate/release boundaries unless debugging specifically needs them earlier.",
        taskChecks.length > 0 ? `Task checks advertised by the board: ${taskChecks.join(", ")}.` : "No task-specific checks were found in the compact ledger.",
      ],
    },
    next: [
      ...(structuralMode === "required" && !structuralContext.requiredSatisfied
        ? ["Structural context was required but is not current/ready. Refresh CodeGraph explicitly or continue only with the degraded-plan warning visible."]
        : []),
      files.length > 0
        ? retrievalMode === "implementation"
          ? "ChatGPT should decide whether impact coverage is sufficient. Edit when it is; otherwise derive the next exact paths/symbols/tests from this source and repeat rh_context narrowly. For concrete TypeScript symbols prefer semantic navigation; use another broad lexical pass only when no credible entry point exists or a dynamic/string/config edge still needs discovery."
          : "Expand exact ranges or neighboring evidence when that investigation can materially change the plan, diagnosis, or review conclusion."
        : "Provide known_paths or narrower search_terms before attempting implementation.",
      "After editing, review the bounded diff/evidence for the coherent edit batch.",
      "Use targeted validation before acceptance; defer expensive full-suite validation to a stable candidate or release boundary unless the task specifically requires it earlier.",
    ],
  };
}

/**
 * Broad first-call fan-in for the canonical rh_context path. CodeGraph runs in
 * its sidecar while broad lexical retrieval performs bounded async file I/O;
 * the sync builder then consumes the warmed session cache/evidence.
 */
export const AUTO_STRUCTURAL_PREFETCH_TIMEOUT_MS = 1_000;

export async function buildControllerContextPackAsync(
  repoRoot: string,
  policy: McpPolicy,
  options: ControllerContextPackOptions = {},
  dependencies: ControllerContextPackDependencies = {},
): Promise<ControllerContextPackProjection> {
  const structuralMode = options.structuralContext ?? 'off';
  if (dependencies.queryCodeGraph || !options.session || options.issueId || options.taskId) {
    return buildControllerContextPack(repoRoot, policy, options, dependencies);
  }
  const prefetchStartedAt = performance.now();
  const retrievalMode = options.retrievalMode ?? 'implementation';
  const maxFiles = clamp(options.maxFiles, DEFAULT_MAX_FILES, 1, 30);
  const knownPaths = cleanList(options.knownPaths);
  const includeGlobs = cleanList([...(options.includeGlobs ?? []), ...knownPaths.filter(looksLikeGlob)]);
  const excludeGlobs = cleanList([...DEFAULT_SEARCH_EXCLUDE_GLOBS, ...(options.excludeGlobs ?? [])]);
  const terms = cleanList([...(options.searchTerms ?? []), ...textTokens(options.description ?? '')]).slice(0, 14);
  const impactDomains = cleanList(options.impactDomains)
    .filter((domain): domain is ControllerContextImpactDomain => CONTROLLER_CONTEXT_IMPACT_DOMAINS.includes(domain as ControllerContextImpactDomain))
    .slice(0, 6);
  const searchQueries = cleanList([
    ...(terms[0] ? [terms[0]] : []),
    ...impactDomains.flatMap((domain) => IMPACT_DOMAIN_TERMS[domain]),
    ...terms.slice(1),
  ]).slice(0, 32);
  const requiredSearchQueries = cleanList(options.searchTerms)
    .filter(isCodeShapedTerm)
    .slice(0, 2);
  const structuralQuery = structuralMode === 'off'
    ? ''
    : structuralIntentQuery(options.description ?? '', terms, impactDomains);
  const structuralIndexRoot = options.structuralIndexRoot?.trim() || repoRoot;
  const structuralRequest = {
    operation: 'context' as const,
    query: structuralQuery,
    limit: Math.min(Math.max(maxFiles, 4), 12),
    maxNodes: Math.min(Math.max(maxFiles * 5, 20), 60),
    maxDepth: 2,
  };
  const structuralCacheKey = JSON.stringify({ queryRoot: structuralIndexRoot, request: structuralRequest });
  const sessionCache = getRepositoryReadSessionCache(repoRoot, options.session);
  const cachedStructural = structuralQuery
    ? sessionCache?.peekStructural(structuralCacheKey) as CodeGraphReadProviderResponse | undefined
    : undefined;
  const lexicalOptions = searchQueries.length > 0
    ? (() => {
        const git = gitSnapshot(repoRoot, options.session);
        return {
          queries: searchQueries,
          includeGlobs,
          excludeGlobs,
          maxResultsPerQuery: Math.max(maxFiles * 4, 12),
          maxFiles: MAX_TOTAL_SEARCHED_FILES,
          caseSensitive: false,
          cacheKey: JSON.stringify({ head: git.head, status: git.status, diffStat: git.diffStat }),
          completionMode: 'discovery' as const,
          discoveryTargetFiles: Math.max(maxFiles * 2, 12),
          discoveryMinQueryCoverage: Math.min(3, searchQueries.length),
          requiredQueries: requiredSearchQueries,
        };
      })()
    : undefined;
  const lexicalIdentity = lexicalOptions ? searchRepositoryManyCacheIdentity(lexicalOptions) : undefined;
  const cachedLexical = lexicalIdentity && sessionCache
    ? sessionCache.getSearch(lexicalIdentity.batchQueryKey, lexicalIdentity.includeKey)
    : undefined;
  if ((!structuralQuery || cachedStructural) && (!lexicalIdentity || cachedLexical?.result)) {
    const pack = buildControllerContextPack(repoRoot, policy, options, dependencies);
    pack.timingsMs.parallelFirstPass = false;
    pack.timingsMs.parallelPrefetch = 0;
    return pack;
  }
  const structuralPromise = cachedStructural
    ? Promise.resolve(cachedStructural)
    : structuralQuery
      ? queryCodeGraphReadProviderAsync(
          structuralIndexRoot,
          structuralRequest,
          structuralMode === 'auto' ? { timeoutMs: AUTO_STRUCTURAL_PREFETCH_TIMEOUT_MS } : {},
        )
      : Promise.resolve<CodeGraphReadProviderResponse>({
          schemaVersion: 1, provider: 'codegraph', operation: 'context', ok: false, status: 'degraded',
          error: { code: 'CODEGRAPH_QUERY_REQUIRED', message: 'No context query was provided.' }, timingsMs: { total: 0 },
        });
  const lexicalPromise = lexicalOptions && lexicalIdentity && !cachedLexical?.result
    ? searchRepositoryManyAsync(repoRoot, policy, lexicalOptions).then((result) => {
        sessionCache?.putSearch({
          query: lexicalIdentity.batchQueryKey,
          includeKey: lexicalIdentity.includeKey,
          result,
          scannedFiles: result.scannedFiles,
        });
        return result;
      })
    : Promise.resolve(cachedLexical?.result);
  const [prefetched] = await Promise.all([structuralPromise, lexicalPromise]);
  const pack = buildControllerContextPack(repoRoot, policy, options, {
    queryCodeGraph: (queryRoot, request) => request.operation === 'context' && queryRoot === structuralIndexRoot
      ? prefetched
      : queryCodeGraphReadProvider(queryRoot, request),
  });
  pack.timingsMs.parallelFirstPass = true;
  pack.timingsMs.parallelPrefetch = Math.round((performance.now() - prefetchStartedAt) * 100) / 100;
  return pack;
}
