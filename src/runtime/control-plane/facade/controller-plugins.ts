import { installOfficialPlugin, officialPluginCatalogItems } from '../../../cli/commands/plugin';
import { listExternalPluginRegistrations } from '../../plugins/external-registration';
import { listCanonicalPluginCapabilityAuthorizations } from '../../plugins/capability-authorization-grants';

export interface ControllerPluginManagementItem {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  compatible: boolean;
  compatibilityReason?: string;
  installedVersion?: string;
  enabled?: boolean;
  authorizationCount: number;
  authorizationExpiresAt?: string;
}

export interface ControllerPluginManagementSnapshot {
  schemaVersion: 1;
  plugins: ControllerPluginManagementItem[];
}

export function readControllerPluginManagement(controllerHome: string): ControllerPluginManagementSnapshot {
  const installed = new Map(
    listExternalPluginRegistrations(controllerHome).map((registration) => [registration.pluginId, registration]),
  );
  const now = Date.now();
  const activeGrants = listCanonicalPluginCapabilityAuthorizations(controllerHome)
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > now);

  return {
    schemaVersion: 1,
    plugins: officialPluginCatalogItems().map((entry) => {
      const registration = installed.get(entry.id);
      const grants = activeGrants.filter((grant) => grant.pluginId === entry.id);
      const expiresAt = grants
        .map((grant) => grant.expiresAt)
        .sort()
        .at(-1);
      return {
        pluginId: entry.id,
        name: entry.name,
        version: entry.version,
        description: entry.description,
        compatible: entry.compatible,
        ...(entry.reason ? { compatibilityReason: entry.reason } : {}),
        ...(registration ? {
          installedVersion: registration.pluginVersion,
          enabled: registration.enabled,
        } : {}),
        authorizationCount: grants.length,
        ...(expiresAt ? { authorizationExpiresAt: expiresAt } : {}),
      };
    }),
  };
}

export function installControllerOfficialPlugin(controllerHome: string, pluginId: string): {
  installation: Record<string, unknown>;
  management: ControllerPluginManagementSnapshot;
} {
  const normalized = pluginId.trim();
  if (!normalized) throw new Error('CONTROLLER_PLUGIN_ID_REQUIRED');
  const installation = installOfficialPlugin(normalized, controllerHome);
  return {
    installation,
    management: readControllerPluginManagement(controllerHome),
  };
}
