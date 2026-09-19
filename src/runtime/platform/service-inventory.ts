import { createHash } from 'crypto';
import { resolve } from 'path';
import type { PlatformServiceManagerHost } from './service-manager';

export type ForgePersistentServiceOwner = 'forge-core' | 'provider';
export type ForgePersistentServiceState = 'current' | 'retired';

export interface ForgePersistentServiceIdentity {
  id: string;
  owner: ForgePersistentServiceOwner;
  state: ForgePersistentServiceState;
  launchdLabel: string;
  systemdUnitName: string;
}

export const FORGE_RECOVERY_GATEWAY_LABEL = 'com.moretea.forge-recovery-gateway';
export const FORGE_RECOVERY_WATCHDOG_LABEL = 'com.moretea.forge-recovery-watchdog';

const RETIRED_CORE_LABELS = [
  ['legacy-runtime', 'com.moretea.forge.runtime'],
  ['legacy-mcp-gateway', 'com.moretea.forge.mcp-gateway'],
  ['bootstrap-supervisor', 'com.moretea.forge-bootstrap-supervisor'],
  ['evolution-supervisor', 'com.moretea.forge-evolution-supervisor'],
] as const;

/**
 * These identities are intentionally outside Forge core lifecycle authority.
 * They are listed to make the negative ownership boundary machine-visible,
 * not to authorize any retirement action.
 */
export const FORGE_PROVIDER_OWNED_PERSISTENT_SERVICES = [
  'com.moretea.forge.desktop-operator',
  'com.moretea.desktop-operator',
] as const;

function controllerHomeSuffix(controllerHome: string): string {
  return createHash('sha256').update(resolve(controllerHome)).digest('hex').slice(0, 12);
}

export function forgeRuntimePersistentServiceLabel(controllerHome: string): string {
  return `com.moretea.forge.runtime.${controllerHomeSuffix(controllerHome)}`;
}

export function forgeConnectorPersistentServiceLabel(controllerHome: string): string {
  return `com.moretea.forge.mcp-gateway.${controllerHomeSuffix(controllerHome)}`;
}

function identity(
  id: string,
  label: string,
  state: ForgePersistentServiceState,
): ForgePersistentServiceIdentity {
  return {
    id,
    owner: 'forge-core',
    state,
    launchdLabel: label,
    systemdUnitName: `${label}.service`,
  };
}

export const FORGE_RETIRED_PERSISTENT_SERVICES: readonly ForgePersistentServiceIdentity[] =
  RETIRED_CORE_LABELS.map(([id, label]) => identity(id, label, 'retired'));

export function forgeOwnedPersistentServiceInventory(controllerHome: string): {
  current: ForgePersistentServiceIdentity[];
  retired: readonly ForgePersistentServiceIdentity[];
  providerOwnedExcludedLabels: readonly string[];
} {
  return {
    current: [
      identity('runtime', forgeRuntimePersistentServiceLabel(controllerHome), 'current'),
      identity('mcp-gateway', forgeConnectorPersistentServiceLabel(controllerHome), 'current'),
      identity('recovery-gateway', FORGE_RECOVERY_GATEWAY_LABEL, 'current'),
      identity('recovery-watchdog', FORGE_RECOVERY_WATCHDOG_LABEL, 'current'),
    ],
    retired: FORGE_RETIRED_PERSISTENT_SERVICES,
    providerOwnedExcludedLabels: FORGE_PROVIDER_OWNED_PERSISTENT_SERVICES,
  };
}

export interface ForgeRetiredServiceReconciliation {
  id: string;
  label: string;
  platform: 'launchd' | 'systemd-user';
  serviceWasPresent: boolean;
  artifactWasPresent: boolean;
  retired: boolean;
}

export async function reconcileRetiredForgePersistentServices(input: {
  host: PlatformServiceManagerHost;
  env?: NodeJS.ProcessEnv;
  accountHome?: string;
}): Promise<ForgeRetiredServiceReconciliation[]> {
  if (!input.host.selection.persistent || input.host.selection.kind === 'portable') return [];
  const results: ForgeRetiredServiceReconciliation[] = [];
  for (const service of FORGE_RETIRED_PERSISTENT_SERVICES) {
    if (input.host.selection.kind === 'launchd') {
      const result = await input.host.retireLaunchdExact({
        label: service.launchdLabel,
        accountHome: input.accountHome,
      });
      results.push({
        id: service.id,
        label: service.launchdLabel,
        platform: 'launchd',
        serviceWasPresent: result.serviceWasPresent,
        artifactWasPresent: result.plistWasPresent,
        retired: result.absentAfter,
      });
    } else {
      const result = input.host.retireSystemdUserExact({
        unitName: service.systemdUnitName,
        env: input.env,
      });
      results.push({
        id: service.id,
        label: service.systemdUnitName,
        platform: 'systemd-user',
        serviceWasPresent: result.serviceWasPresent,
        artifactWasPresent: result.unitFileWasPresent,
        retired: result.absentAfter,
      });
    }
  }
  return results;
}
