import type { ControllerBinding, ControllerRoundContext } from '../domain/types';

export interface ControllerHostResumeResult {
  accepted: boolean;
  dispatchId?: string;
  reason?: string;
}

/** Provider-neutral continuation port. Implementations live in adapters/*. */
export interface ControllerHost {
  resume(binding: ControllerBinding, roundContext: ControllerRoundContext): Promise<ControllerHostResumeResult> | ControllerHostResumeResult;
}
