import { join } from 'path';
import { resolveControllerHome } from '../../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import type { BootstrapSnapshot } from './types';

export function bootstrapStatePath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'bootstrap', 'state.json');
}

export function readBootstrapSnapshot(controllerHome: string): BootstrapSnapshot | undefined {
  const value = readJsonFile<BootstrapSnapshot | undefined>(bootstrapStatePath(controllerHome), undefined);
  if (!value || value.schemaVersion !== 1 || typeof value.stateFingerprint !== 'string' || !Number.isInteger(value.revision)) return undefined;
  return value;
}

export function writeBootstrapSnapshot(controllerHome: string, snapshot: BootstrapSnapshot): BootstrapSnapshot {
  const previous = readBootstrapSnapshot(controllerHome);
  if (previous?.stateFingerprint === snapshot.stateFingerprint && previous.revision === snapshot.revision) return previous;
  writeJsonAtomic(bootstrapStatePath(controllerHome), snapshot);
  return snapshot;
}
