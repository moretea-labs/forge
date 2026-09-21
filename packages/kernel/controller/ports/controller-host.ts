import type { ControllerBinding, ControllerRoundContext } from '../domain/types';

export interface ControllerHostResumeResult {
  accepted: boolean;
  dispatchId?: string;
  reason?: string;
  /** Explicit provider/user blocker. Valid only when accepted=false; callers persist a resumable wait instead of terminal rejection. */
  waitForUser?: boolean;
  /** Durable user-action Handoff created by the provider adapter when waitForUser=true. */
  handoffId?: string;
  /** Known non-ambiguous provider failure that may retry the same semantic round under its existing failure budget. */
  recoverable?: boolean;
}

/** Provider-neutral continuation port. Implementations live in adapters/*. */
export interface ControllerHost {
  resume(binding: ControllerBinding, roundContext: ControllerRoundContext): Promise<ControllerHostResumeResult> | ControllerHostResumeResult;
}
