import {
  advanceReleaseSession,
  listReleaseSessions,
  readReleaseSession,
  releaseSessionIsTerminal,
  type ReleaseSession,
} from './release-session';

export interface RuntimeReleaseContext {
  controllerHome: string;
}

export type RuntimeReleaseRunBoundary =
  | 'terminal'
  | 'provider_boundary'
  | 'provider_failure'
  | 'advance_budget_exhausted';

export interface RuntimeReleaseRunEvidence {
  actions: RuntimeReleaseCoordinatorAction[];
  boundary: RuntimeReleaseRunBoundary;
}

export interface RuntimeReleaseProgressResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  releaseSession?: ReleaseSession;
  releaseRun?: RuntimeReleaseRunEvidence;
}

/**
 * Port implemented by the standalone Recovery boundary. The release domain
 * decides semantic progression; the provider executes the physical operation
 * for the already-selected durable ReleaseSession phase.
 */
export interface RuntimeReleaseProvider<C extends RuntimeReleaseContext = RuntimeReleaseContext> {
  prepare(config: C, requestId?: string): Promise<RuntimeReleaseProgressResult>;
  verifyStatic(config: C, sessionId: string, requestId?: string): Promise<RuntimeReleaseProgressResult>;
  verifyCandidate(config: C, sessionId: string, requestId?: string): Promise<RuntimeReleaseProgressResult>;
  cutover(config: C, sessionId: string, requestId?: string): Promise<RuntimeReleaseProgressResult>;
  promoteKnownGood(config: C, sessionId: string, requestId?: string): Promise<RuntimeReleaseProgressResult>;
}

export type RuntimeReleaseCoordinatorAction =
  | 'prepare'
  | 'verify_static'
  | 'verify_candidate'
  | 'mark_cutover_eligible'
  | 'cutover'
  | 'promote_known_good';

export interface RuntimeReleaseCoordinatorDecision {
  action: RuntimeReleaseCoordinatorAction;
  session?: ReleaseSession;
}

export type RuntimeReleaseReconciliationReason =
  | 'active_session'
  | 'source_mismatch'
  | 'source_not_configured'
  | 'source_current'
  | 'source_already_attempted';

export interface RuntimeReleaseSourceState {
  configured: boolean;
  sourceRevision?: string;
  activeSourceCommit?: string;
}

export type RuntimeReleaseSourceObserver = () => RuntimeReleaseSourceState;

export interface RuntimeReleaseReconciliationDecision {
  required: boolean;
  reason: RuntimeReleaseReconciliationReason;
  action?: RuntimeReleaseCoordinatorAction;
  session?: ReleaseSession;
}

const MAX_AUTONOMOUS_RELEASE_ADVANCES = 8;

function completeRuntimeReleaseSessions(controllerHome: string): ReleaseSession[] {
  const inventory = listReleaseSessions(controllerHome, { maxEntries: 512 });
  if (inventory.truncated || inventory.invalidSessionFiles.length > 0) {
    throw new Error(`RELEASE_SESSION_INVENTORY_INCOMPLETE: truncated=${inventory.truncated}; invalid=${inventory.invalidSessionFiles.join(',') || 'none'}`);
  }
  return inventory.sessions;
}

export function activeRuntimeReleaseSessions(controllerHome: string): ReleaseSession[] {
  return completeRuntimeReleaseSessions(controllerHome)
    .filter((session) => !releaseSessionIsTerminal(session));
}

function runtimeReleaseActionForSession(session: ReleaseSession): RuntimeReleaseCoordinatorAction {
  switch (session.phase) {
    case 'source_frozen': return 'prepare';
    case 'built': return 'verify_static';
    case 'static_verified':
    case 'candidate_booted': return 'verify_candidate';
    case 'candidate_verified': return 'mark_cutover_eligible';
    case 'cutover_eligible':
    case 'cutover_attempting':
    case 'cutover_committed': return 'cutover';
    case 'soaking': return 'promote_known_good';
    case 'known_good':
    case 'rolled_back':
    case 'failed':
      throw new Error(`RELEASE_SESSION_TERMINAL_NOT_ACTIVE: ${session.sessionId}:${session.phase}`);
  }
}

export function decideConfiguredRuntimeReleaseAction(controllerHome: string): RuntimeReleaseCoordinatorDecision {
  const active = activeRuntimeReleaseSessions(controllerHome);
  if (active.length > 1) {
    throw new Error(`RELEASE_SESSION_MULTIPLE_ACTIVE: ${active.map((session) => `${session.sessionId}:${session.phase}`).join(',')}`);
  }
  const session = active[0];
  if (!session) return { action: 'prepare' };
  return { action: runtimeReleaseActionForSession(session), session };
}

/**
 * Decide whether the Recovery-hosted automatic trigger should invoke one
 * ReleaseCoordinator step. ReleaseSession remains the only durable progression
 * authority; source comparison merely decides whether an absent session should
 * be created. Unknown active source identity fails closed rather than implying
 * a source mismatch.
 */
export function decideConfiguredRuntimeReleaseReconciliation(
  controllerHome: string,
  observeSource: RuntimeReleaseSourceObserver,
): RuntimeReleaseReconciliationDecision {
  const sessions = completeRuntimeReleaseSessions(controllerHome);
  const active = sessions.filter((session) => !releaseSessionIsTerminal(session));
  if (active.length > 1) {
    throw new Error(`RELEASE_SESSION_MULTIPLE_ACTIVE: ${active.map((session) => `${session.sessionId}:${session.phase}`).join(',')}`);
  }
  const session = active[0];
  if (session) {
    return { required: true, reason: 'active_session', action: runtimeReleaseActionForSession(session), session };
  }

  // Source observation may spawn Git. Keep it lazy so an already-active
  // ReleaseSession can progress entirely from its durable authority without
  // periodic repository/process churn in the Recovery daemon.
  const source = observeSource();
  if (!source.configured) return { required: false, reason: 'source_not_configured' };
  const sourceRevision = source.sourceRevision?.trim();
  const activeSourceCommit = source.activeSourceCommit?.trim();
  if (!sourceRevision) throw new Error('RELEASE_AUTOMATION_SOURCE_REVISION_UNKNOWN');
  if (!activeSourceCommit) throw new Error('RELEASE_AUTOMATION_ACTIVE_SOURCE_COMMIT_UNKNOWN');
  if (sourceRevision === activeSourceCommit) return { required: false, reason: 'source_current' };

  // An autonomous release is one attempt per immutable source revision.
  // A terminal ReleaseSession is durable evidence that this exact commit was
  // already accepted, failed, or deliberately rolled back. Replaying it every
  // watchdog interval would turn a safety failure into a release/fork storm.
  // A human can still start an explicit release; automatic retry resumes when
  // HEAD changes and therefore produces a new source revision.
  const priorAttempt = sessions
    .filter((candidate) => releaseSessionIsTerminal(candidate) && candidate.sourceRevision === sourceRevision)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (priorAttempt) {
    return { required: false, reason: 'source_already_attempted', session: priorAttempt };
  }

  return { required: true, reason: 'source_mismatch', action: 'prepare' };
}

function decisionFingerprint(decision: RuntimeReleaseCoordinatorDecision): string {
  const session = decision.session;
  return session
    ? `${decision.action}:${session.sessionId}:${session.phase}:${session.revision}`
    : `${decision.action}:none`;
}

export async function advanceConfiguredRuntimeReleaseStep<C extends RuntimeReleaseContext>(
  config: C,
  provider: RuntimeReleaseProvider<C>,
  requestId?: string,
): Promise<RuntimeReleaseProgressResult> {
  const decision = decideConfiguredRuntimeReleaseAction(config.controllerHome);
  const request = requestId?.trim();
  switch (decision.action) {
    case 'prepare':
      return provider.prepare(config, request);
    case 'verify_static':
      return provider.verifyStatic(config, decision.session!.sessionId, request);
    case 'verify_candidate':
      return provider.verifyCandidate(config, decision.session!.sessionId, request);
    case 'mark_cutover_eligible': {
      const session = decision.session!;
      const advanced = advanceReleaseSession({
        controllerHome: config.controllerHome,
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        phase: 'cutover_eligible',
      });
      return {
        ok: true,
        attempted: false,
        noOp: true,
        detail: 'Durable Candidate B evidence already exists; advanced the same ReleaseSession to cutover_eligible without replaying canaries.',
        releaseSession: advanced,
      };
    }
    case 'cutover':
      return provider.cutover(config, decision.session!.sessionId, request);
    case 'promote_known_good':
      return provider.promoteKnownGood(config, decision.session!.sessionId, request);
  }
}

/**
 * Stateless run-to-boundary normal-release engine. ReleaseSession remains the
 * only durable progression authority: every iteration re-derives the next
 * action from persisted state, and no coordinator-local checkpoint is created.
 *
 * One invocation drains immediately executable phases. It stops only when the
 * session terminalizes, a provider reports failure, a provider deliberately
 * makes no durable progress (a genuine wait/safety boundary), or the fixed
 * advance budget is exhausted. The budget/no-progress fences make accidental
 * in-process loops fail closed while preserving crash-safe retry semantics.
 */
export async function advanceConfiguredRuntimeRelease<C extends RuntimeReleaseContext>(
  config: C,
  provider: RuntimeReleaseProvider<C>,
  requestId?: string,
): Promise<RuntimeReleaseProgressResult> {
  const actions: RuntimeReleaseCoordinatorAction[] = [];
  let attempted = false;
  let allNoOp = true;
  let lastResult: RuntimeReleaseProgressResult | undefined;

  for (let index = 0; index < MAX_AUTONOMOUS_RELEASE_ADVANCES; index += 1) {
    const before = decideConfiguredRuntimeReleaseAction(config.controllerHome);
    const beforeFingerprint = decisionFingerprint(before);
    const result = await advanceConfiguredRuntimeReleaseStep(config, provider, requestId);
    actions.push(before.action);
    attempted ||= result.attempted;
    allNoOp &&= result.noOp === true;
    lastResult = result;

    const observedSession = result.releaseSession
      ?? (before.session ? readReleaseSession(config.controllerHome, before.session.sessionId) : undefined);

    if (!result.ok) {
      return {
        ...result,
        attempted,
        ...(allNoOp ? { noOp: true } : { noOp: false }),
        releaseSession: observedSession ?? result.releaseSession,
        releaseRun: { actions, boundary: 'provider_failure' },
      };
    }

    if (observedSession && releaseSessionIsTerminal(observedSession)) {
      return {
        ...result,
        attempted,
        ...(allNoOp ? { noOp: true } : { noOp: false }),
        releaseSession: observedSession,
        releaseRun: { actions, boundary: 'terminal' },
      };
    }

    const after = decideConfiguredRuntimeReleaseAction(config.controllerHome);
    if (decisionFingerprint(after) === beforeFingerprint) {
      return {
        ...result,
        attempted,
        ...(allNoOp ? { noOp: true } : { noOp: false }),
        releaseSession: observedSession ?? result.releaseSession,
        releaseRun: { actions, boundary: 'provider_boundary' },
      };
    }
  }

  return {
    ok: false,
    attempted,
    ...(allNoOp ? { noOp: true } : { noOp: false }),
    detail: `RELEASE_SESSION_AUTONOMOUS_ADVANCE_BUDGET_EXHAUSTED: ${MAX_AUTONOMOUS_RELEASE_ADVANCES} durable advances without reaching a boundary`,
    releaseSession: lastResult?.releaseSession,
    releaseRun: { actions, boundary: 'advance_budget_exhausted' },
  };
}
