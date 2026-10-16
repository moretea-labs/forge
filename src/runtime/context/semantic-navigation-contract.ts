export type SemanticNavigationKind = 'definition' | 'references' | 'implementations';

export interface SemanticNavigationRequest {
  navigation: SemanticNavigationKind;
  path: string;
  line: number;
  column: number;
  tsconfigPath?: string;
  language?: string;
}

export interface SemanticNavigationLocation {
  path: string;
  line: number;
  column: number;
  name?: string;
  kind?: string;
}

export interface SemanticNavigationResult {
  providerId: string;
  providerIdentity?: string;
  language: string;
  navigation: SemanticNavigationKind;
  target: { path: string; line: number; column: number };
  locations: SemanticNavigationLocation[];
  policyDeniedReads?: number;
  /** Denied requested/material reads, excluding incidental dependency probes. */
  materialPolicyDeniedReads?: number;
  details?: Record<string, unknown>;
}

export type SemanticNavigationOutcome =
  | { ok: true; result: SemanticNavigationResult }
  | { ok: false; code: string; message: string };

export interface SemanticNavigationReadPolicy {
  profile: string;
  readGlobs: readonly string[];
  denyGlobs: readonly string[];
  maxFileBytes: number;
}

export interface SemanticNavigationAccess {
  cacheScope: string;
  sourceIdentity?: string;
  profile: string;
  /** Serializable policy used by disposable semantic sidecars. */
  readPolicy?: SemanticNavigationReadPolicy;
  allowRepositoryPath(relativePath: string): boolean;
}

export interface SemanticNavigationProvider {
  id: string;
  languages: readonly string[];
  supports(request: SemanticNavigationRequest): boolean;
  navigate(
    repoRoot: string,
    requests: SemanticNavigationRequest[],
    access: SemanticNavigationAccess,
  ): Promise<SemanticNavigationOutcome[]>;
}

export interface IndexedSemanticNavigationRequest {
  index: number;
  request: SemanticNavigationRequest;
}

export interface IndexedSemanticNavigationOutcome {
  index: number;
  outcome: SemanticNavigationOutcome;
}

/** Dependency probes rejected by policy cannot certify missing requested source relationships. */
export function isIncidentalSemanticDependencyProbe(path: string): boolean {
  return /(?:^|\/)node_modules\/[^/]+/.test(path.replace(/\\/g, '/'));
}
