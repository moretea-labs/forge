import {
  advanceReleaseSession,
  listReleaseSessions,
  releaseSessionIsTerminal,
  type ReleaseSession,
} from './release-session';

export interface RuntimeReleaseContext {
  controllerHome: string;
}

export interface RuntimeReleaseProgressResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  releaseSession?: ReleaseSession;
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

export function activeRuntimeReleaseSessions(controllerHome: string): ReleaseSession[] {
  const inventory = listReleaseSessions(controllerHome, { maxEntries: 512 });
  if (inventory.truncated || inventory.invalidSessionFiles.length > 0) {
    throw new Error(`RELEASE_SESSION_INVENTORY_INCOMPLETE: truncated=${inventory.truncated}; invalid=${inventory.invalidSessionFiles.join(',') || 'none'}`);
  }
  return inventory.sessions.filter((session) => !releaseSessionIsTerminal(session));
}

export function decideConfiguredRuntimeReleaseAction(controllerHome: string): RuntimeReleaseCoordinatorDecision {
  const active = activeRuntimeReleaseSessions(controllerHome);
  if (active.length > 1) {
    throw new Error(`RELEASE_SESSION_MULTIPLE_ACTIVE: ${active.map((session) => `${session.sessionId}:${session.phase}`).join(',')}`);
  }
  const session = active[0];
  if (!session) return { action: 'prepare' };
  switch (session.phase) {
    case 'source_frozen': return { action: 'prepare', session };
    case 'built': return { action: 'verify_static', session };
    case 'static_verified':
    case 'candidate_booted': return { action: 'verify_candidate', session };
    case 'candidate_verified': return { action: 'mark_cutover_eligible', session };
    case 'cutover_eligible':
    case 'cutover_attempting':
    case 'cutover_committed': return { action: 'cutover', session };
    case 'soaking': return { action: 'promote_known_good', session };
    case 'known_good':
    case 'rolled_back':
    case 'failed':
      throw new Error(`RELEASE_SESSION_TERMINAL_NOT_ACTIVE: ${session.sessionId}:${session.phase}`);
  }
}

/**
 * Stateless normal-release coordinator. ReleaseSession is the only durable
 * progression authority. Repeated calls derive exactly one next action from
 * its persisted phase; no Work or coordinator-local state is created per phase.
 */
export async function advanceConfiguredRuntimeRelease<C extends RuntimeReleaseContext>(
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
