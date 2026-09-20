import { migrateReleaseSessionState, type ReleaseSessionStateMigration } from './release-session';
import { migrateRuntimeReleaseAuthorityState, readRuntimeReleaseAuthority, type RuntimeReleaseAuthority } from '../root/release-store';

export interface ReleaseDurableStateMigration {
  authority?: RuntimeReleaseAuthority;
  sessions: ReleaseSessionStateMigration;
}

/**
 * One migration boundary for all persisted Runtime release semantics.
 * Runtime and Recovery cross this boundary before they declare themselves ready
 * or consume ReleaseSession state. Supported historical shapes are rewritten
 * once; steady-state readers remain current-schema-only.
 */
export function migrateReleaseDurableState(controllerHome: string): ReleaseDurableStateMigration {
  const authority = migrateRuntimeReleaseAuthorityState(controllerHome);
  const sessions = migrateReleaseSessionState(controllerHome, {
    readAuthority: () => authority ?? readRuntimeReleaseAuthority(controllerHome),
  });
  return {
    ...(authority ? { authority } : {}),
    sessions,
  };
}
