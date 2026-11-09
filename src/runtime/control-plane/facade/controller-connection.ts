import { openSetupSession, readSetupSession, type SetupSession } from '../../../cli/commands/init-hook';
import { runMcpSetupChatgpt } from '../../../../adapters/mcp/setup';
import {
  configureSetupProfile,
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
  setup?: {
    status: SetupSession['status'];
    nextAction?: {
      id: string;
      summary: string;
      risk: string;
      requiresUser: boolean;
    };
  };
}

function setupProjection(session: SetupSession | undefined): ControllerConnectionSnapshot['setup'] | undefined {
  if (!session) return undefined;
  const bootstrapAction = session.nextAction
    ? session.bootstrap?.actions.find((entry) => entry.id === session.nextAction?.id)
    : undefined;
  return {
    status: session.status,
    ...(session.nextAction ? {
      nextAction: {
        id: session.nextAction.id,
        summary: session.nextAction.reason,
        risk: session.nextAction.risk,
        requiresUser: bootstrapAction?.owner === 'user',
      },
    } : {}),
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
  const setup = setupProjection(readSetupSession({ setupRoot: options.setupRoot, env: options.env }));
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
      ...(setup ? { setup } : {}),
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
    ...(setup ? { setup } : {}),
  };
}

export function configureInitialControllerConnection(
  controllerHome: string,
  input: { controller: string; tunnel?: string },
  options: ControllerConnectionOptions = {},
): { connection: ControllerConnectionSnapshot } {
  if (readSetupProfile({ setupRoot: options.setupRoot })) {
    throw new Error('CONTROLLER_CONNECTION_ALREADY_CONFIGURED');
  }
  const controller = input.controller.trim();
  const tunnel = input.tunnel?.trim()
    || (controller === 'chatgpt' || controller === 'mcp' ? 'auto' : 'none');
  if (!['chatgpt', 'codex', 'claude', 'mcp'].includes(controller)) {
    throw new Error('CONTROLLER_CONNECTION_CONTROLLER_INVALID');
  }
  if (!['auto', 'none'].includes(tunnel)) {
    throw new Error('CONTROLLER_CONNECTION_TUNNEL_INVALID');
  }
  const profile = configureSetupProfile({
    setupRoot: options.setupRoot,
    controller,
    tunnel,
  });
  if (profile.controllers.some((entry) => entry === 'chatgpt' || entry === 'mcp')) {
    runMcpSetupChatgpt({
      controllerHome,
      userLevel: true,
      ...(profile.tunnel.endpoint ? { endpoint: profile.tunnel.endpoint } : {}),
      clearEndpoint: !profile.tunnel.endpoint,
      connectorAuthMode: setupConnectorAuthMode(profile),
    });
  }
  openSetupSession({
    setupRoot: options.setupRoot,
    env: options.env,
    controllerHome,
    profile,
  });
  return { connection: readControllerConnectionSnapshot(controllerHome, options) };
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
