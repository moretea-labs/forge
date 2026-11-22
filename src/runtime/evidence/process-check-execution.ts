/**
 * Content-bound Check identity shared by Process Runtime and repository checks.
 *
 * This is durable evidence metadata, not Process lifecycle state. Keeping the
 * contract outside Process Runtime prevents check receipts from depending on
 * the Process implementation layer.
 */
export interface ProcessCheckExecutionIdentity {
  schemaVersion: 1;
  checkId: string;
  cacheKey: string;
  revision: string;
  definitionDigest: string;
  environmentFingerprint: string;
  timeoutMs: number;
  reuseScope: 'repository' | 'checkout';
  scopeKey: string;
}
