import { existsSync, lstatSync, readdirSync, statSync } from "fs";
import { gitSnapshot, readRepositoryRange, searchRepositoryMany } from "../repository/inspector";
import { resolveMcpPath, globMatches } from "../mcp/paths";
import type { McpPolicy } from "../mcp/types";
import { redactMcpText } from "../mcp/redaction";
import { projectBoard } from "./issue-store";
import { buildControllerTaskLedgerProjection, type TaskLedgerTaskProjection } from "./task-ledger";
import { legacyIssueAuthorityRetired } from "./legacy-issue-cutover";
import {
  queryCodeGraphReadProvider,
  type CodeGraphIndexMetadata,
  type CodeGraphNodeSummary,
  type CodeGraphReadProviderResponse,
} from "../../runtime/context/codegraph-read-provider";

const CONTEXT_PACK_SCHEMA_VERSION = 6;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_SNIPPETS = 20;
const DEFAULT_SNIPPET_CONTEXT_BEFORE = 12;
const DEFAULT_SNIPPET_CONTEXT_AFTER = 28;
const DEFAULT_MAX_CHARS_PER_SNIPPET = 8000;
const DEFAULT_SEARCH_EXCLUDE_GLOBS = [
  ".git/**",
  "_ops/**",
  ".forge/**",
  ".ai/harness/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  "**/*.bak",
] as const;
const MAX_TOTAL_SEARCHED_FILES = 800;

const STOPWORDS = new Set([
  "about", "after", "again", "also", "and", "around", "because", "before", "between", "change", "code", "config",
  "context", "current", "does", "file", "from", "have", "into", "issue", "make", "need", "needs", "only", "path",
  "repo", "repository", "runtime", "should", "task", "that", "this", "through", "todo", "update", "when", "with",
]);

export type StructuralContextMode = "off" | "auto" | "required";
export type ControllerContextRetrievalMode = "implementation" | "plan" | "debug" | "review";
export const CONTROLLER_CONTEXT_IMPACT_DOMAINS = [
  "persistence", "scheduler", "notification", "timeline", "events", "cache", "api", "concurrency",
] as const;
export type ControllerContextImpactDomain = (typeof CONTROLLER_CONTEXT_IMPACT_DOMAINS)[number];

const IMPACT_DOMAIN_TERMS: Record<ControllerContextImpactDomain, readonly string[]> = {
  persistence: ["persist", "database", "repository"],
  scheduler: ["scheduler", "schedule", "reminder"],
  notification: ["notification", "notify", "push"],
  timeline: ["timeline", "history", "activity"],
  events: ["event", "publish", "subscribe"],
  cache: ["cache", "invalidate", "memo"],
  api: ["api", "dto", "controller"],
  concurrency: ["transaction", "lock", "atomic"],
};

export interface ControllerContextPackOptions {
  description?: string;
  issueId?: string;
  taskId?: string;
  knownPaths?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  searchTerms?: string[];
  maxFiles?: number;
  maxSnippets?: number;
  maxCharsPerSnippet?: number;
  structuralContext?: StructuralContextMode;
  /** Optional repository-level CodeGraph root used as structural baseline when the selected checkout has no local index. */
  structuralIndexRoot?: string;
  retrievalMode?: ControllerContextRetrievalMode;
  /** GPT-selected cross-cutting evidence dimensions. Forge expands mechanically and never treats them as semantic completeness proof. */
  impactDomains?: ControllerContextImpactDomain[];
}

export interface ControllerContextPackDependencies {
  queryCodeGraph?: typeof queryCodeGraphReadProvider;
}

export interface ControllerContextPackSnippet {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  sha256: string;
  content: string;
  truncated: boolean;
  redactions: Array<{ type: string; count: number }>;
  reason: string;
}

export interface ControllerContextPackFile {
  path: string;
  reasons: string[];
  hitLines: number[];
  snippetCount: number;
  snippets: ControllerContextPackSnippet[];
}

export interface ControllerContextPackProjection {
  schemaVersion: typeof CONTEXT_PACK_SCHEMA_VERSION;
  generatedAt: string;
  source: "controller-context-pack";
  focus: {
    issueId?: string;
    issueTitle?: string;
    taskId?: string;
    taskTitle?: string;
    taskStatus?: string;
  };
  goal: string;
  git: {
    branch: string | null;
    status: string;
    diffStat: string;
    dirty: boolean;
  };
  search: {
    terms: string[];
    impactDomains: ControllerContextImpactDomain[];
    impactCoverage: Array<{
      domain: ControllerContextImpactDomain;
      queries: string[];
      matchedFiles: string[];
      selectedFiles: string[];
      omittedFileCount: number;
      status: "selected" | "matched_not_selected" | "no_evidence";
    }>;
    includeGlobs: string[];
    excludeGlobs: string[];
    scannedFiles: number;
    policyDeniedFiles: number;
    skippedLargeFiles: number;
    skippedBinaryFiles: number;
    truncated: boolean;
  };
  structuralContext: {
    provider: "codegraph";
    requestedMode: StructuralContextMode;
    status: "disabled" | "ready" | "stale" | "unavailable" | "degraded";
    requiredSatisfied: boolean;
    indexSource: "current_checkout" | "repository_baseline";
    overlayChangedFiles: string[];
    baselineRevisionMatches: boolean;
    query?: string;
    entryPoints: Array<Pick<CodeGraphNodeSummary, "id" | "kind" | "name" | "filePath" | "startLine" | "endLine">>;
    relatedFiles: string[];
    metadata?: Pick<CodeGraphIndexMetadata, "initialized" | "lastIndexedAt" | "buildVersion" | "extractionVersion" | "staleEngine" | "changedFiles" | "ignoredChangedFileCount">;
    fallbackReason?: string;
    timingsMs?: CodeGraphReadProviderResponse["timingsMs"];
    truncated: boolean;
  };
  impactContext: {
    status: "not_requested" | "ready" | "degraded";
    confidence: "low" | "medium" | "high";
    primaryTargets: string[];
    mustInspect: string[];
    likelyAffected: string[];
    relevantTests: string[];
    relevantChecks: string[];
    architectureContracts: string[];
    coverageGaps: string[];
    relationSources: Array<"codegraph" | "lexical" | "forge_checks">;
    freshness: {
      structuralStatus: "disabled" | "ready" | "stale" | "unavailable" | "degraded";
      lastIndexedAt?: number | null;
      changedFileCount: number;
      indexSource: "current_checkout" | "repository_baseline";
      overlayChangedFileCount: number;
      baselineRevisionMatches: boolean;
    };
  };
  files: ControllerContextPackFile[];
  deniedPaths: Array<{ path: string; reason: string }>;
  omitted: Array<{ path: string; reason: string }>;
  limits: {
    maxFiles: number;
    maxSnippets: number;
    maxCharsPerSnippet: number;
  };
  validation: {
    policy: "task-targeted" | "minimal";
    checks: string[];
  };
  contextContract: {
    strategy: string;
    retrievalMode: ControllerContextRetrievalMode;
    semanticSufficiencyAuthority: "chatgpt";
    rawCodeRequiredForImplementation: boolean;
    expansionSignals: string[];
    notes: string[];
  };
  next: string[];
}

function cleanList(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean)));
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function textTokens(value: string): string[] {
  const split = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const tokens = split
    .map((entry) => entry.replace(/^['"`]+|['"`]+$/g, ""))
    .filter((entry) => entry.length >= 3)
    .filter((entry) => !STOPWORDS.has(entry.toLowerCase()))
    .filter((entry) => !/^\d+$/.test(entry));
  return Array.from(new Set(tokens)).slice(0, 12);
}

interface ContextPackIssueFocus {
  id?: string;
  title?: string;
  summary?: string;
  tasks: ContextPackTaskFocus[];
}

interface ContextPackTaskFocus {
  id?: string;
  title?: string;
  objective?: string;
  status?: string;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unknownRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(unknownRecord).filter((entry) => Object.keys(entry).length > 0);
}

function contextPackTaskFocus(value: unknown): ContextPackTaskFocus {
  const record = unknownRecord(value);
  return {
    id: unknownString(record.id),
    title: unknownString(record.title),
    objective: unknownString(record.objective),
    status: unknownString(record.status),
  };
}

function contextPackIssueFocus(value: unknown): ContextPackIssueFocus {
  const record = unknownRecord(value);
  return {
    id: unknownString(record.id),
    title: unknownString(record.title),
    summary: unknownString(record.summary),
    tasks: unknownRecordArray(record.tasks).map(contextPackTaskFocus),
  };
}

function issueTaskFocus(board: ReturnType<typeof projectBoard>, issueId?: string, taskId?: string): { issue?: ContextPackIssueFocus; task?: ContextPackTaskFocus } {
  const issues = board.issues.map(contextPackIssueFocus);
  const resolvedIssue = issueId
    ? issues.find((issue) => issue.id === issueId)
    : board.currentIssueId
      ? issues.find((issue) => issue.id === board.currentIssueId)
      : undefined;
  const resolvedTask = resolvedIssue?.tasks.find((task) => task.id === taskId) ?? resolvedIssue?.tasks[0];
  return { issue: resolvedIssue, task: resolvedTask };
}

function ledgerTask(ledger: ReturnType<typeof buildControllerTaskLedgerProjection>, issueId?: string, taskId?: string): TaskLedgerTaskProjection | undefined {
  const tasks = ledger.issues.flatMap((issue) => issue.tasks);
  const findTask = (candidateIssueId?: string, candidateTaskId?: string) => tasks
    .find((task) => (!candidateIssueId || task.issueId === candidateIssueId) && (!candidateTaskId || task.taskId === candidateTaskId));

  if (!issueId && !taskId) {
    const readyTask = ledger.readyTasks[0];
    return ledger.attention[0]
      ?? findTask(readyTask?.issueId, readyTask?.taskId)
      ?? tasks.find((task) => task.dispatchable || task.queueable);
  }

  return findTask(issueId, taskId);
}

function looksLikeGlob(path: string): boolean {
  return /[*?{[]/.test(path);
}

function coveredByGlob(path: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some((glob) => globMatches(glob, path));
}

function gitStatusChangedPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("##") || line.length < 4) continue;
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.slice(path.lastIndexOf(" -> ") + 4).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function addReason(map: Map<string, { reasons: Set<string>; lines: Set<number> }>, path: string, reason: string, line?: number): void {
  const entry = map.get(path) ?? { reasons: new Set<string>(), lines: new Set<number>() };
  entry.reasons.add(reason);
  if (typeof line === "number" && Number.isFinite(line)) entry.lines.add(Math.max(1, Math.trunc(line)));
  map.set(path, entry);
}

function readableFile(repoRoot: string, policy: McpPolicy, path: string): { ok: true; path: string } | { ok: false; path: string; reason: string } {
  const decision = resolveMcpPath(repoRoot, path, policy, "read");
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { ok: false, path: decision.relativePath ?? path, reason: decision.reason ?? "path denied" };
  }
  if (!existsSync(decision.absolutePath)) return { ok: false, path: decision.relativePath, reason: "path does not exist" };
  if (!statSync(decision.absolutePath).isFile()) return { ok: false, path: decision.relativePath, reason: "path is not a file" };
  return { ok: true, path: decision.relativePath };
}

interface ExpandedKnownPath {
  files: string[];
  denied: Array<{ path: string; reason: string }>;
  directory?: string;
  truncated: boolean;
}

/**
 * Expand an explicit file or directory without following symlinks. Every file
 * is re-checked through resolveMcpPath so directory support never broadens the
 * policy boundary. Enumeration is deterministic and bounded.
 */
function expandKnownPath(
  repoRoot: string,
  policy: McpPolicy,
  path: string,
  maxFiles: number,
): ExpandedKnownPath {
  const decision = resolveMcpPath(repoRoot, path, policy, "read");
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { files: [], denied: [{ path: decision.relativePath ?? path, reason: decision.reason ?? "path denied" }], truncated: false };
  }
  if (!existsSync(decision.absolutePath)) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "path does not exist" }], truncated: false };
  }
  const rootStat = lstatSync(decision.absolutePath);
  if (rootStat.isSymbolicLink()) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "symbolic links are not followed" }], truncated: false };
  }
  if (rootStat.isFile()) return { files: [decision.relativePath], denied: [], truncated: false };
  if (!rootStat.isDirectory()) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "path is neither a regular file nor directory" }], truncated: false };
  }

  const files: string[] = [];
  const denied: Array<{ path: string; reason: string }> = [];
  let truncated = false;
  const walk = (relativeDirectory: string, depth: number): void => {
    if (files.length >= maxFiles) { truncated = true; return; }
    if (depth > 8) { denied.push({ path: relativeDirectory, reason: "directory recursion depth exceeded" }); return; }
    const directoryDecision = resolveMcpPath(repoRoot, relativeDirectory, policy, "read");
    if (!directoryDecision.ok || !directoryDecision.absolutePath || !directoryDecision.relativePath) {
      denied.push({ path: directoryDecision.relativePath ?? relativeDirectory, reason: directoryDecision.reason ?? "path denied" });
      return;
    }
    let entries;
    try {
      entries = readdirSync(directoryDecision.absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      denied.push({ path: directoryDecision.relativePath, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const child = `${directoryDecision.relativePath}/${entry.name}`.replace(/^\.\//, "");
      if (entry.isSymbolicLink()) {
        denied.push({ path: child, reason: "symbolic links are not followed" });
      } else if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else if (entry.isFile()) {
        const readable = readableFile(repoRoot, policy, child);
        if (readable.ok) files.push(readable.path);
        else denied.push(readable);
      }
    }
  };
  walk(decision.relativePath, 0);
  return { files, denied, directory: decision.relativePath, truncated };
}

function boundedSnippet(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return { content: `${content.slice(0, maxChars)}\n... <snippet truncated>`, truncated: true };
}

function mergeHitLines(lines: number[]): number[] {
  const sorted = Array.from(new Set(lines.filter((line) => line > 0))).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const line of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && line - previous <= DEFAULT_SNIPPET_CONTEXT_BEFORE + DEFAULT_SNIPPET_CONTEXT_AFTER) continue;
    merged.push(line);
  }
  return merged;
}

function structuralResult(response: CodeGraphReadProviderResponse): {
  nodes: CodeGraphNodeSummary[];
  entryPoints: CodeGraphNodeSummary[];
  relatedFiles: string[];
  truncated: boolean;
} {
  const result = response.result ?? {};
  const nodes = Array.isArray(result.nodes) ? result.nodes as CodeGraphNodeSummary[] : [];
  const entryPoints = Array.isArray(result.entryPoints) ? result.entryPoints as CodeGraphNodeSummary[] : [];
  const relatedFiles = Array.isArray(result.relatedFiles) ? result.relatedFiles.filter((value): value is string => typeof value === "string") : [];
  return { nodes, entryPoints, relatedFiles, truncated: result.truncated === true };
}

export function buildControllerContextPack(
  repoRoot: string,
  policy: McpPolicy,
  options: ControllerContextPackOptions = {},
  dependencies: ControllerContextPackDependencies = {},
): ControllerContextPackProjection {
  const retrievalMode = options.retrievalMode ?? "implementation";
  const maxFiles = clamp(options.maxFiles, DEFAULT_MAX_FILES, 1, 30);
  const maxSnippets = clamp(options.maxSnippets, DEFAULT_MAX_SNIPPETS, 1, 80);
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
  const git = gitSnapshot(repoRoot);
  const board = hasExplicitFocus && !legacyIssueAuthorityRetired(repoRoot) ? projectBoard(repoRoot) : undefined;
  const focus = board ? issueTaskFocus(board, options.issueId, options.taskId) : {};
  const ledger = board ? buildControllerTaskLedgerProjection(repoRoot, board) : undefined;
  const compactTask = ledger ? ledgerTask(ledger, focus.issue?.id, focus.task?.id) : undefined;
  const allowedPathGlobs = cleanList(compactTask?.allowedPaths);
  const searchIncludeGlobs = includeGlobs.length > 0 ? includeGlobs : allowedPathGlobs;
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
  const impactCandidatePaths = new Map<ControllerContextImpactDomain, Set<string>>(impactDomains.map((domain) => [domain, new Set<string>()]));
  const candidates = new Map<string, { reasons: Set<string>; lines: Set<number> }>();
  const deniedPaths: Array<{ path: string; reason: string }> = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let searchTruncated = false;
  const structuralMode = options.structuralContext ?? "off";
  const structuralIndexRoot = options.structuralIndexRoot?.trim() || repoRoot;
  const indexSource = structuralIndexRoot === repoRoot ? "current_checkout" : "repository_baseline";
  const overlayChangedFiles = indexSource === "repository_baseline" ? gitStatusChangedPaths(git.status) : [];
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

  if (structuralMode !== "off") {
    const structuralQuery = [goal || terms.join(" "), ...impactDomains].filter(Boolean).join(" ");
    if (!structuralQuery) {
      structuralContext = {
        ...structuralContext,
        status: "degraded",
        requiredSatisfied: false,
        fallbackReason: "No task description or search term was available for structural context.",
      };
    } else {
      const queryCodeGraph = dependencies.queryCodeGraph ?? queryCodeGraphReadProvider;
      const structural = queryCodeGraph(structuralIndexRoot, {
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
      structuralContext = {
        provider: "codegraph",
        requestedMode: structuralMode,
        status: indexSource === "repository_baseline" && (!baselineRevisionMatches || overlayChangedFiles.length > 0) && structural.status === "ready" ? "stale" : structural.status,
        requiredSatisfied: structuralMode !== "required" || (structural.status === "ready" && baselineRevisionMatches && overlayChangedFiles.length === 0),
        indexSource,
        overlayChangedFiles,
        baselineRevisionMatches,
        query: structuralQuery,
        entryPoints: graph.entryPoints.slice(0, 12).map((node) => ({
          id: node.id,
          kind: node.kind,
          name: node.name,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
        })),
        relatedFiles: Array.from(new Set(graph.relatedFiles)).slice(0, 80),
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
          const adjacency = queryCodeGraph(structuralIndexRoot, { operation: "file_dependencies", filePath, limit: 40 });
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

  const exactKnownFiles: string[] = [];
  let exactKnownFileScope = explicitKnownPaths.length > 0;
  for (const path of explicitKnownPaths) {
    const expanded = expandKnownPath(repoRoot, policy, path, Math.max(maxFiles * 4, 40));
    for (const file of expanded.files) {
      addReason(candidates, file, expanded.directory ? `explicit-known-directory:${expanded.directory}` : "explicit-known-path", 1);
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

  for (const glob of allowedPathGlobs) {
    if (!includeGlobs.includes(glob)) includeGlobs.push(glob);
  }

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
  if (searchQueries.length > 0 && candidates.size < maxFiles * 3) {
    const search = searchRepositoryMany(repoRoot, policy, {
      queries: searchQueries,
      files: scopedExactKnownFileSearch ? exactKnownFiles : undefined,
      includeGlobs: scopedExactKnownFileSearch ? undefined : searchIncludeGlobs,
      excludeGlobs,
      maxResultsPerQuery: Math.max(maxFiles * 4, 12),
      maxFiles: scopedExactKnownFileSearch ? exactKnownFiles.length : MAX_TOTAL_SEARCHED_FILES,
      caseSensitive: false,
      cacheKey: JSON.stringify({ head: git.head, status: git.status, diffStat: git.diffStat }),
    });
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

  const primarySearchReason = terms.length > 0 ? `search:${terms[0]}` : undefined;
  const rankedCandidates = Array.from(candidates.entries())
    .map(([path, entry]) => ({ path, reasons: Array.from(entry.reasons), lines: Array.from(entry.lines) }))
    .sort((left, right) => {
      const leftExplicit = left.reasons.some((reason) => reason === "explicit-known-path" || reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      const rightExplicit = right.reasons.some((reason) => reason === "explicit-known-path" || reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      if (leftExplicit !== rightExplicit) return rightExplicit - leftExplicit;
      const leftPrimary = primarySearchReason && left.reasons.includes(primarySearchReason) ? 1 : 0;
      const rightPrimary = primarySearchReason && right.reasons.includes(primarySearchReason) ? 1 : 0;
      if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
      if (left.reasons.length !== right.reasons.length) return right.reasons.length - left.reasons.length;
      if (left.lines.length !== right.lines.length) return right.lines.length - left.lines.length;
      return left.path.localeCompare(right.path);
    });
  const selected = rankedCandidates.slice(0, maxFiles);
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
  for (const entry of selected) {
    if (remainingSnippets <= 0) {
      omitted.push({ path: entry.path, reason: "max_snippets" });
      continue;
    }
    const hitLines = mergeHitLines(entry.lines.length > 0 ? entry.lines : [1]).slice(0, remainingSnippets);
    const snippets: ControllerContextPackSnippet[] = [];
    for (const line of hitLines) {
      if (remainingSnippets <= 0) break;
      try {
        const raw = readRepositoryRange(
          repoRoot,
          policy,
          entry.path,
          Math.max(1, line - DEFAULT_SNIPPET_CONTEXT_BEFORE),
          line + DEFAULT_SNIPPET_CONTEXT_AFTER,
        );
        const redacted = redactMcpText(raw.content);
        const bounded = boundedSnippet(redacted.text, maxCharsPerSnippet);
        snippets.push({
          path: raw.path,
          startLine: raw.startLine,
          endLine: raw.endLine,
          totalLines: raw.totalLines,
          sha256: raw.sha256,
          content: bounded.content,
          truncated: bounded.truncated,
          redactions: redacted.redactions,
          reason: entry.reasons.join(", "),
        });
        remainingSnippets -= 1;
      } catch (error) {
        deniedPaths.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      }
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
  const primaryTargets = Array.from(new Set(structuralContext.entryPoints.map((entry) => entry.filePath).filter(Boolean))).slice(0, 20);
  const structuralUniverse = Array.from(new Set([
    ...primaryTargets,
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
  const mustInspect = Array.from(new Set([...primaryTargets, ...graphImpactFiles, ...relevantTests, ...architectureContracts])).slice(0, 80);
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
    },
    structuralContext,
    impactContext,
    files,
    deniedPaths: deniedPaths.slice(0, 20),
    omitted: omitted.slice(0, 30),
    limits: { maxFiles, maxSnippets, maxCharsPerSnippet },
    validation: {
      policy: taskChecks.length > 0 ? "task-targeted" : "minimal",
      checks: taskChecks,
    },
    contextContract: {
      strategy: retrievalMode === "implementation"
        ? "Use the returned current raw snippets plus bounded impact evidence as the implementation decision input. ChatGPT owns semantic sufficiency; do not re-read source solely because it arrived through search."
        : "Use this pack as investigation evidence and deliberately expand the evidence surface when the selected mode requires planning, debugging, or review.",
      retrievalMode,
      semanticSufficiencyAuthority: "chatgpt",
      rawCodeRequiredForImplementation,
      expansionSignals,
      notes: [
        retrievalMode === "implementation"
          ? "The pack already contains policy-approved current raw source snippets with file SHA identities. Request wider/exact ranges only when ChatGPT judges the impact surface ambiguous or an expansion signal makes the raw evidence mechanically incomplete."
          : "Investigation modes may intentionally expand exact ranges, structural relationships, tests, and neighboring modules before any implementation decision.",
        "Search/CodeGraph ranking is discovery evidence, not a business-semantics authority. impactContext makes the bounded evidence surface and coverage gaps explicit; ChatGPT still decides semantic sufficiency.",
        impactDomains.length > 0 ? `Impact domains were selected by ChatGPT and expanded mechanically in this same retrieval call: ${impactDomains.join(", ")}. Missing or omitted domain evidence is an ambiguity signal, not proof that the domain is irrelevant.` : "No explicit cross-cutting impact domains were requested; ChatGPT may add them when state, scheduling, notifications, events, caching, API, or concurrency could materially change the implementation.",
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
          ? "ChatGPT should decide whether the impact coverage is sufficient; if yes, edit directly from the returned current raw snippets and SHA identities instead of issuing a mandatory second read."
          : "Expand exact ranges or neighboring evidence when that investigation can materially change the plan, diagnosis, or review conclusion."
        : "Provide known_paths or narrower search_terms before attempting implementation.",
      "After editing, review the bounded diff/evidence for the coherent edit batch.",
      "Use targeted validation before acceptance; defer expensive full-suite validation to a stable candidate or release boundary unless the task specifically requires it earlier.",
    ],
  };
}
