import type { RepositoryReadSession } from '../../repository/inspector';
import type { CodeGraphIndexMetadata, CodeGraphNodeSummary, CodeGraphReadProviderResponse } from '../../../runtime/context/codegraph-read-provider';
import type { queryCodeGraphReadProvider } from '../../../runtime/context/codegraph-read-provider';
import type { MaterializedSourceSnippet } from './source-materializer';

export const CONTEXT_PACK_SCHEMA_VERSION = 7;
export type StructuralContextMode = 'off' | 'auto' | 'required';
export type ControllerContextRetrievalMode = 'implementation' | 'plan' | 'debug' | 'review';
export const CONTROLLER_CONTEXT_IMPACT_DOMAINS = [
  'persistence', 'scheduler', 'notification', 'timeline', 'events', 'cache', 'api', 'concurrency',
] as const;
export type ControllerContextImpactDomain = (typeof CONTROLLER_CONTEXT_IMPACT_DOMAINS)[number];

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
  structuralIndexRoot?: string;
  retrievalMode?: ControllerContextRetrievalMode;
  impactDomains?: ControllerContextImpactDomain[];
  session?: RepositoryReadSession;
}

export interface ControllerContextPackDependencies {
  queryCodeGraph?: typeof queryCodeGraphReadProvider;
}

export type ControllerContextPackSnippet = MaterializedSourceSnippet;

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
  source: 'controller-context-pack';
  focus: { issueId?: string; issueTitle?: string; taskId?: string; taskTitle?: string; taskStatus?: string };
  goal: string;
  git: { branch: string | null; status: string; diffStat: string; dirty: boolean };
  search: {
    terms: string[];
    impactDomains: ControllerContextImpactDomain[];
    impactCoverage: Array<{
      domain: ControllerContextImpactDomain;
      queries: string[];
      matchedFiles: string[];
      selectedFiles: string[];
      omittedFileCount: number;
      status: 'selected' | 'matched_not_selected' | 'no_evidence';
    }>;
    includeGlobs: string[];
    excludeGlobs: string[];
    scannedFiles: number;
    policyDeniedFiles: number;
    skippedLargeFiles: number;
    skippedBinaryFiles: number;
    truncated: boolean;
    cacheHit: boolean;
  };
  structuralContext: {
    provider: 'codegraph';
    requestedMode: StructuralContextMode;
    status: 'disabled' | 'ready' | 'stale' | 'unavailable' | 'degraded';
    requiredSatisfied: boolean;
    indexSource: 'current_checkout' | 'repository_baseline';
    overlayChangedFiles: string[];
    baselineRevisionMatches: boolean;
    query?: string;
    entryPoints: Array<Pick<CodeGraphNodeSummary, 'id' | 'kind' | 'name' | 'filePath' | 'startLine' | 'endLine'>>;
    relatedFiles: string[];
    metadata?: Pick<CodeGraphIndexMetadata, 'initialized' | 'lastIndexedAt' | 'buildVersion' | 'extractionVersion' | 'staleEngine' | 'changedFiles' | 'ignoredChangedFileCount'>;
    fallbackReason?: string;
    timingsMs?: CodeGraphReadProviderResponse['timingsMs'];
    truncated: boolean;
  };
  impactContext: {
    status: 'not_requested' | 'ready' | 'degraded';
    confidence: 'low' | 'medium' | 'high';
    primaryTargets: string[];
    structuralHints: string[];
    mustInspect: string[];
    likelyAffected: string[];
    relevantTests: string[];
    relevantChecks: string[];
    architectureContracts: string[];
    coverageGaps: string[];
    relationSources: Array<'codegraph' | 'lexical' | 'forge_checks'>;
    freshness: {
      structuralStatus: 'disabled' | 'ready' | 'stale' | 'unavailable' | 'degraded';
      lastIndexedAt?: number | null;
      changedFileCount: number;
      indexSource: 'current_checkout' | 'repository_baseline';
      overlayChangedFileCount: number;
      baselineRevisionMatches: boolean;
    };
  };
  files: ControllerContextPackFile[];
  coverage: {
    inspectedFiles: string[];
    likelyRelatedNotInspected: string[];
    unresolvedRelationships: string[];
    relevantTests: string[];
    exactKnownPaths: { requested: string[]; materialized: string[]; missing: string[] };
    skippedCandidates: {
      omittedFiles: number;
      policyDeniedFiles: number;
      largeFiles: number;
      binaryFiles: number;
      searchTruncated: boolean;
      structuralTruncated: boolean;
    };
    materialization: { completeFiles: number; symbols: number; fallbackWindows: number };
  };
  cache: {
    sessionBound: boolean;
    lexicalHit: boolean;
    structuralHits: number;
    structuralMisses: number;
    rangeHits: number;
    rangeMisses: number;
    reused: boolean;
  };
  timingsMs: {
    gitAndFocus: number;
    structural: number;
    lexical: number;
    materialization: number;
    total: number;
    parallelFirstPass?: boolean;
    parallelPrefetch?: number;
  };
  deniedPaths: Array<{ path: string; reason: string }>;
  omitted: Array<{ path: string; reason: string }>;
  limits: {
    maxFiles: number;
    maxSnippets: number;
    maxCharsPerSnippet: number;
    requestedMaxFiles: number;
    requestedMaxSnippets: number;
    reservedExactKnownFiles: number;
  };
  validation: { policy: 'task-targeted' | 'minimal'; checks: string[] };
  contextContract: {
    strategy: string;
    retrievalMode: ControllerContextRetrievalMode;
    semanticSufficiencyAuthority: 'chatgpt';
    rawCodeRequiredForImplementation: boolean;
    expansionSignals: string[];
    notes: string[];
  };
  next: string[];
}
