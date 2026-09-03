import { resolveControllerHome } from '../../../cli/repositories/controller-home';
import { buildBootstrapSnapshot } from './state-machine';
import { readBootstrapSnapshot, writeBootstrapSnapshot } from './store';
import type { BootstrapAction, BootstrapEvaluation, BootstrapSnapshot } from './types';

export interface BootstrapControlAdapter {
  observe(): Promise<BootstrapEvaluation> | BootstrapEvaluation;
  /** Optional synchronous observation for product surfaces that are intentionally synchronous. */
  observeSync?(): BootstrapEvaluation;
  perform?(action: BootstrapAction): Promise<void> | void;
}

export function reconcileBootstrapSnapshot(input: { controllerHome: string; evaluation: BootstrapEvaluation; now?: () => Date }): BootstrapSnapshot {
  const controllerHome = resolveControllerHome(input.controllerHome);
  const previous = readBootstrapSnapshot(controllerHome);
  const snapshot = buildBootstrapSnapshot({ controllerHome, evaluation: input.evaluation, previous, now: input.now });
  return writeBootstrapSnapshot(controllerHome, snapshot);
}

export function readBootstrapControlState(controllerHome: string): BootstrapSnapshot | undefined {
  return readBootstrapSnapshot(resolveControllerHome(controllerHome));
}

export interface BootstrapControlApi {
  read(): BootstrapSnapshot | undefined;
  refresh(): Promise<BootstrapSnapshot>;
  refreshSync(): BootstrapSnapshot;
  act(actionId: string): Promise<BootstrapSnapshot>;
}

export function createBootstrapControlApi(input: {
  controllerHome: string;
  adapter: BootstrapControlAdapter;
  now?: () => Date;
}): BootstrapControlApi {
  const controllerHome = resolveControllerHome(input.controllerHome);
  const persist = (evaluation: BootstrapEvaluation): BootstrapSnapshot => reconcileBootstrapSnapshot({ controllerHome, evaluation, now: input.now });
  const refresh = async (): Promise<BootstrapSnapshot> => persist(await input.adapter.observe());
  const refreshSync = (): BootstrapSnapshot => {
    if (!input.adapter.observeSync) throw new Error('BOOTSTRAP_SYNC_OBSERVER_UNAVAILABLE');
    return persist(input.adapter.observeSync());
  };
  return {
    read: () => readBootstrapSnapshot(controllerHome),
    refresh,
    refreshSync,
    act: async (actionId: string) => {
      const snapshot = await refresh();
      const action = snapshot.actions.find((entry) => entry.id === actionId);
      if (!action) throw new Error(`BOOTSTRAP_ACTION_NOT_FOUND: ${actionId}`);
      if (action.owner === 'user') throw new Error(`BOOTSTRAP_USER_ACTION_REQUIRED: ${actionId}`);
      if (!input.adapter.perform) throw new Error(`BOOTSTRAP_ACTION_EXECUTOR_UNAVAILABLE: ${actionId}`);
      await input.adapter.perform(action);
      return refresh();
    },
  };
}
