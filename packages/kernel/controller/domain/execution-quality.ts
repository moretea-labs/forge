/** Evidence-only hints: neither diagnoses nor authority to change Work or budgets. */
export interface ExecutionQualitySignal {
  code: 'repeated_semantic_state' | 'repeated_verification' | 'suspected_regression' | 'repeated_root_cause';
  fingerprint?: string;
  evidenceRefs: string[];
  observation: string;
}
export interface VerificationObservation {
  checkId: string; sourceDigest: string; environment: string; outcome: 'passed' | 'failed'; evidenceRef: string;
}
export interface RootCauseObservation {
  dispositionRef: string; rootCauseId: string; designScope: string; controllerConfirmed: boolean;
}

export function deriveExecutionQualitySignals(input: {
  repeatedStateCount: number; maxRepeatedState: number; waiting: boolean; roundRef: string;
  /** Unknown coverage is not evidence of absent progress. */
  hasNewVerifiedProgress?: boolean;
  verifications?: readonly VerificationObservation[];
  rootCauses?: readonly RootCauseObservation[];
}): ExecutionQualitySignal[] {
  const signals: ExecutionQualitySignal[] = [];
  const threshold = Math.max(1, input.maxRepeatedState - 1);
  if (!input.waiting && input.hasNewVerifiedProgress === false && input.repeatedStateCount >= threshold) {
    signals.push({ code: 'repeated_semantic_state', evidenceRefs: [input.roundRef],
      observation: `${input.repeatedStateCount} repeated semantic fingerprints without new verified evidence or accepted results. Investigate before changing strategy; this does not establish that investigation made no progress.` });
  }
  const uniqueChecks = new Map<string, VerificationObservation>();
  for (const check of input.verifications ?? []) if (!uniqueChecks.has(check.evidenceRef)) uniqueChecks.set(check.evidenceRef, check);
  const checks = [...uniqueChecks.values()].slice(-32).filter(check =>
    check.checkId && check.sourceDigest && check.environment && check.evidenceRef
    && (check.outcome === 'passed' || check.outcome === 'failed'));
  const buckets = new Map<string, VerificationObservation[]>();
  for (const check of checks) {
    const key = JSON.stringify([check.checkId, check.sourceDigest, check.environment]);
    const list = buckets.get(key) ?? [];
    if (!list.some(item => item.evidenceRef === check.evidenceRef)) list.push(check);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    if (list.length >= 3 && list.every(check => check.outcome === list[0]!.outcome)) signals.push({ code: 'repeated_verification',
      evidenceRefs: list.map(check => check.evidenceRef), observation: 'Same check, exact source, environment and outcome observed at least three times. Repetition may be intentional flaky-test diagnosis.' });
  }
  for (let index = 1; index < checks.length; index++) {
    const current = checks[index]!;
    const prior = checks.slice(0, index).reverse().find(check => check.checkId === current.checkId && check.environment === current.environment);
    if (prior?.outcome === 'passed' && current.outcome === 'failed' && prior.evidenceRef !== current.evidenceRef) {
      signals.push({ code: 'suspected_regression', evidenceRefs: [prior.evidenceRef, current.evidenceRef],
        observation: prior.sourceDigest === current.sourceDigest
          ? 'A passing check subsequently failed on the same source and declared environment. Intermittent failure remains a possible explanation; regression is unconfirmed.'
          : 'A passing check subsequently failed in the same declared environment. Changed source is correlated evidence, not established cause; regression is unconfirmed.' });
    }
  }
  const causes = new Map<string, Set<string>>();
  for (const cause of (input.rootCauses ?? []).slice(-32)) {
    if (!cause.controllerConfirmed || !cause.dispositionRef || !cause.rootCauseId || !cause.designScope) continue;
    const key = JSON.stringify([cause.rootCauseId, cause.designScope]);
    const refs = causes.get(key) ?? new Set<string>();
    refs.add(cause.dispositionRef); causes.set(key, refs);
  }
  for (const refs of causes.values()) if (refs.size >= 2) signals.push({ code: 'repeated_root_cause', evidenceRefs: [...refs],
    observation: 'At least two Controller-confirmed blocker dispositions name the same root cause and design scope. Apply the existing return_to_design contract.' });
  return signals.slice(0, 8);
}

export interface AssistantContextItemEvidence {
  kind: 'knowledge' | 'experience';
  itemId: string;
  digest?: string;
  revision?: number;
  sourceRevision?: string;
}

export interface AssistantContextSnapshot {
  digest: string;
  projectId?: string;
  items: AssistantContextItemEvidence[];
  gaps: string[];
  missingRequiredSources: string[];
  truncated: boolean;
}

export interface AssistantContextUsage {
  kind: AssistantContextItemEvidence['kind'];
  itemId: string;
  decision: 'used' | 'rejected';
  reason: string;
}

export interface ClosedRoundObservation {
  roundRef: string;
  workId: string;
  requirementId?: string;
  planId?: string;
  designVersion?: string;
  stateFingerprint: string;
  evidenceIdentities: string[];
  acceptedResultIdentities: string[];
  verifications: VerificationObservation[];
  rootCauses?: RootCauseObservation[];
  assistantContext?: AssistantContextSnapshot;
  assistantContextUsage?: AssistantContextUsage[];
  waiting: boolean;
  coverageGaps: string[];
}

export function deriveClosedRoundQualitySignals(window: readonly ClosedRoundObservation[], input: {
  repeatedStateCount: number; maxRepeatedState: number; waiting: boolean; roundRef: string;
}): ExecutionQualitySignal[] {
  const bounded = window.slice(-8), current = bounded.at(-1), previous = bounded.at(-2);
  const comparable = current && previous && current.workId === previous.workId && !current.coverageGaps.length && !previous.coverageGaps.length;
  const hasNewVerifiedProgress = comparable ? current.evidenceIdentities.some(id => !previous.evidenceIdentities.includes(id))
    || current.acceptedResultIdentities.some(id => !previous.acceptedResultIdentities.includes(id)) : undefined;
  return deriveExecutionQualitySignals({ ...input, hasNewVerifiedProgress, verifications: bounded.flatMap(round => round.verifications), rootCauses: bounded.flatMap(round => round.rootCauses ?? []) });
}

export interface ExecutionQualityDecision {
  fingerprint: string;
  action: 'no_adjustment' | 'adjustment';
  reason: string;
  verificationCondition?: string;
  /** Kernel-recorded time of the Controller decision. Callers do not supply this authority. */
  decidedAt?: string;
}

export interface ExecutionQualityAdjustmentResult {
  fingerprint: string;
  outcome: 'improved' | 'not_improved' | 'inconclusive';
  evidenceRefs: string[];
  reason: string;
  /** Kernel-recorded time after all referenced post-adjustment verification receipts exist. */
  verifiedAt: string;
}
