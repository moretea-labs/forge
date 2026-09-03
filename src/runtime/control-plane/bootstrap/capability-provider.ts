import type { AssistantPluginManifest } from '../../plugins/types';

export interface BootstrapCapabilityCatalogEntry {
  id: string;
  name: string;
  platforms: NodeJS.Platform[];
  compatible: boolean;
  semanticCapabilities?: string[];
}

export type BootstrapCapabilityProviderStatus = 'ready' | 'repairable' | 'installable' | 'unsupported';

export interface BootstrapCapabilityProviderResolution {
  capabilityId: string;
  status: BootstrapCapabilityProviderStatus;
  providerId?: string;
  providerName?: string;
  summary: string;
}

function manifestProvides(manifest: AssistantPluginManifest, capabilityId: string): boolean {
  return manifest.capabilities.some((capability) => capability.capabilityId === capabilityId);
}

export function resolveBootstrapCapabilityProviders(input: {
  capabilityIntents: readonly string[];
  installedManifests: readonly AssistantPluginManifest[];
  catalog: readonly BootstrapCapabilityCatalogEntry[];
}): BootstrapCapabilityProviderResolution[] {
  return [...new Set(input.capabilityIntents.map((value) => value.trim()).filter(Boolean))]
    .sort()
    .map((capabilityId) => {
      const installed = input.installedManifests
        .filter((manifest) => manifestProvides(manifest, capabilityId))
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
      const ready = installed.find((manifest) => manifest.enabled && manifest.lifecycle.state === 'enabled' && manifest.health.ready);
      if (ready) {
        return {
          capabilityId,
          status: 'ready' as const,
          providerId: ready.pluginId,
          providerName: ready.displayName,
          summary: `${ready.displayName} provides ${capabilityId} and is ready.`,
        };
      }
      const repairable = installed[0];
      if (repairable) {
        return {
          capabilityId,
          status: 'repairable' as const,
          providerId: repairable.pluginId,
          providerName: repairable.displayName,
          summary: `${repairable.displayName} provides ${capabilityId} but is ${repairable.health.state}.`,
        };
      }
      const catalog = input.catalog
        .filter((entry) => entry.compatible && entry.semanticCapabilities?.includes(capabilityId))
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      if (catalog) {
        return {
          capabilityId,
          status: 'installable' as const,
          providerId: catalog.id,
          providerName: catalog.name,
          summary: `${catalog.name} can provide ${capabilityId} on this platform.`,
        };
      }
      return {
        capabilityId,
        status: 'unsupported' as const,
        summary: `No installed or compatible official provider advertises ${capabilityId}.`,
      };
    });
}
