import { runMcpSetupChatgpt } from '../../../../adapters/mcp/setup';
import {
  detectSetupPlatform,
  readSetupProfile,
  resolveControllerGuidance,
  resolveTunnelGuidance,
  setupConnectorAuthMode,
  type SetupControllerKind,
  type SetupPlatformSnapshot,
  type SetupTunnelProvider,
} from '../../../cli/commands/setup-profile';

export interface ControllerConnectionSnapshot {
  schemaVersion: 1;
  configured: boolean;
  ready: boolean;
  profile?: {
    primaryController: SetupControllerKind;
    controllers: SetupControllerKind[];
    tunnelProvider: SetupTunnelProvider;
  };
  controller: {
    ready: boolean;
    controller?: SetupControllerKind;
    title: string;
    detail: string;
  };
  tunnel: {
    ready: boolean;
    provider: SetupTunnelProvider;
    title: string;
    detail: string;
  };
  repair: {
    available: boolean;
    action: 'repair_connector';
    label: string;
  };
}

export interface ControllerConnectionOptions {
  setupRoot?: string;
  platform?: SetupPlatformSnapshot;
  env?: NodeJS.ProcessEnv;
}

export function readControllerConnectionSnapshot(
  controllerHome: string,
  options: ControllerConnectionOptions = {},
): ControllerConnectionSnapshot {
  const profile = readSetupProfile({ setupRoot: options.setupRoot });
  if (!profile) {
    return {
      schemaVersion: 1,
      configured: false,
      ready: false,
      controller: {
        ready: false,
        title: 'Configure a Forge controller',
        detail: 'No Forge setup profile is configured yet. Choose the controller and transport through Forge setup before connecting this client.',
      },
      tunnel: {
        ready: false,
        provider: 'none',
        title: 'Remote connection not configured',
        detail: 'Remote transport status becomes available after Forge setup has a controller profile.',
      },
      repair: { available: false, action: 'repair_connector', label: 'Refresh Forge Connector' },
    };
  }

  const controllerGuidance = resolveControllerGuidance(profile, { controllerHome });
  const tunnelGuidance = resolveTunnelGuidance(
    profile,
    options.platform ?? detectSetupPlatform({ env: options.env }),
    { controllerHome, env: options.env },
  );
  const repairAvailable = controllerGuidance?.ready === false
    && (controllerGuidance.controller === 'chatgpt' || controllerGuidance.controller === 'mcp');
  const controllerReady = controllerGuidance === undefined;

  return {
    schemaVersion: 1,
    configured: true,
    ready: controllerReady && tunnelGuidance.ready,
    profile: {
      primaryController: profile.primaryController,
      controllers: [...profile.controllers],
      tunnelProvider: profile.tunnel.provider,
    },
    controller: controllerGuidance ?? {
      ready: true,
      controller: profile.primaryController,
      title: 'Forge controller configured',
      detail: 'The configured controller endpoints match the current Forge setup profile.',
    },
    tunnel: {
      ready: tunnelGuidance.ready,
      provider: tunnelGuidance.provider,
      title: tunnelGuidance.title,
      detail: tunnelGuidance.detail,
    },
    repair: {
      available: repairAvailable,
      action: 'repair_connector',
      label: 'Refresh Forge Connector',
    },
  };
}

export function repairControllerConnection(
  controllerHome: string,
  options: ControllerConnectionOptions = {},
): { changed: boolean; changedCount: number; connection: ControllerConnectionSnapshot } {
  const profile = readSetupProfile({ setupRoot: options.setupRoot });
  if (!profile) throw new Error('CONTROLLER_CONNECTION_PROFILE_REQUIRED');
  const guidance = resolveControllerGuidance(profile, { controllerHome });
  if (!guidance || (guidance.controller !== 'chatgpt' && guidance.controller !== 'mcp')) {
    throw new Error('CONTROLLER_CONNECTION_REPAIR_UNAVAILABLE');
  }

  const repaired = runMcpSetupChatgpt({
    controllerHome,
    userLevel: true,
    connectorAuthMode: setupConnectorAuthMode(profile),
    ...(profile.tunnel.endpoint
      ? { endpoint: profile.tunnel.endpoint }
      : { clearEndpoint: true }),
  });
  return {
    changed: repaired.changed.length > 0,
    changedCount: repaired.changed.length,
    connection: readControllerConnectionSnapshot(controllerHome, options),
  };
}
