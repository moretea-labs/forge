import { resolveControllerHome } from '../repositories/controller-home';
import {
  createBootstrapControlApi,
  type BootstrapControlApi,
  type BootstrapAction,
  resolveBootstrapCapabilityProviders,
  type BootstrapBlocker,
  type BootstrapCapabilityProviderResolution,
  type BootstrapDesiredState,
  type BootstrapEvaluation,
  type BootstrapObservation,
  type BootstrapSnapshot,
  type BootstrapStep,
} from '../../runtime/control-plane/bootstrap';
import {
  detectSetupPlatform,
  readSetupProfile,
  resolveControllerGuidance,
  resolveRuntimeGuidance,
  resolveTunnelGuidance,
  setupNeedsRemoteAccess,
  type ControllerGuidance,
  type RuntimeGuidance,
  type SetupPlatformSnapshot,
  type SetupProfile,
  type SetupProfileOptions,
  type TunnelGuidance,
} from './setup-profile';
import { controllerPluginRepository, listAssistantPluginManifests } from '../../runtime/plugins/store';
import { officialPluginCatalogItems } from './plugin';
import { bootstrapWslWindowsBridgeBrowser, observeWslWindowsBridgeBrowser } from '../chatgpt-browser/bridge-provider';

export interface SetupBridgeGuidance {
  required: boolean;
  ready: boolean;
  automatic: boolean;
  summary: string;
}

export interface SetupBootstrapDependencies {
  capabilities(intents: readonly string[], options: { controllerHome: string; platform: SetupPlatformSnapshot }): BootstrapCapabilityProviderResolution[];
  bridge(profile: SetupProfile | undefined, platform: SetupPlatformSnapshot, options: { controllerHome: string }): SetupBridgeGuidance;
  controller(profile: SetupProfile | undefined, options: { controllerHome?: string; home?: string }): ControllerGuidance | undefined;
  runtime(profile: SetupProfile | undefined, options: { controllerHome?: string }): RuntimeGuidance | undefined;
  tunnel(profile: SetupProfile | undefined, platform: SetupPlatformSnapshot, options: { controllerHome?: string; env?: NodeJS.ProcessEnv }): TunnelGuidance;
}

export interface SetupBootstrapOptions extends SetupProfileOptions {
  controllerHome?: string;
  accountHome?: string;
  profile?: SetupProfile;
  platform?: SetupPlatformSnapshot;
  capabilities?: string[];
  dependencies?: Partial<SetupBootstrapDependencies>;
}

function setupBridgeRoot(controllerHome: string): string | undefined {
  try {
    const repository = controllerPluginRepository(controllerHome);
    return repository.canonicalRoot ?? repository.localRoot;
  } catch {
    return undefined;
  }
}

const DEFAULT_DEPENDENCIES: SetupBootstrapDependencies = {
  capabilities: (intents, options) => {
    if (intents.length === 0) return [];
    const repository = controllerPluginRepository(options.controllerHome);
    const installedManifests = listAssistantPluginManifests(options.controllerHome, repository, { preferStored: true });
    const catalog = officialPluginCatalogItems(options.platform.platform);
    return resolveBootstrapCapabilityProviders({ capabilityIntents: intents, installedManifests, catalog });
  },
  bridge: (profile, platform, options) => {
    if (!profile?.controllers.includes('chatgpt') || platform.environment !== 'wsl2') {
      return { required: false, ready: true, automatic: false, summary: 'Windows ChatGPT bridge browser is not required for this setup.' };
    }
    const bridgeRoot = setupBridgeRoot(options.controllerHome);
    if (!bridgeRoot) {
      return { required: true, ready: false, automatic: false, summary: 'Forge cannot resolve the controller-system repository used by the WSL ChatGPT bridge.' };
    }
    const readiness = observeWslWindowsBridgeBrowser(bridgeRoot, { platform: 'linux', wslDistroName: 'ForgeSetup' });
    return { required: readiness.required, ready: readiness.ready, automatic: readiness.automatic, summary: readiness.summary };
  },
  controller: resolveControllerGuidance,
  runtime: resolveRuntimeGuidance,
  tunnel: resolveTunnelGuidance,
};

function desiredState(profile: SetupProfile | undefined, capabilities: readonly string[] = []): BootstrapDesiredState {
  const primaryController = profile?.primaryController ?? 'chatgpt';
  const controllers = profile?.controllers ?? [primaryController];
  const remote = setupNeedsRemoteAccess(profile ?? { schemaVersion: 1, primaryController, controllers, tunnel: { provider: 'auto' }, createdAt: '', updatedAt: '' });
  const provider = profile?.tunnel.provider ?? 'auto';
  const preferredTransport = !remote || provider === 'none'
    ? 'none'
    : provider === 'openai' || provider === 'auto'
      ? 'openai-secure-tunnel'
      : 'https-endpoint';
  return {
    schemaVersion: 1,
    primaryController,
    controllers,
    connectivity: {
      mode: remote ? 'remote' : 'local',
      preferredTransport,
      ...(profile?.tunnel.endpoint ? { endpoint: profile.tunnel.endpoint } : {}),
      ...(profile?.tunnel.tunnelId ? { tunnelId: profile.tunnel.tunnelId } : {}),
    },
    capabilityIntents: [...new Set([...(profile?.capabilityIntents ?? []), ...capabilities])],
  };
}

function actionFromGuidance(input: {
  id: string;
  kind: BootstrapAction['kind'];
  title: string;
  detail: string;
  command?: string;
  owner?: BootstrapAction['owner'];
}): BootstrapAction {
  return {
    id: input.id,
    kind: input.kind,
    owner: input.owner ?? 'forge',
    summary: `${input.title}: ${input.detail}`,
    ...(input.command ? { command: input.command } : {}),
    verification: 'forge setup next',
  };
}

function blockerFor(stepId: string, code: string, action: BootstrapAction, summary: string): BootstrapBlocker {
  return {
    code,
    kind: action.owner === 'user' ? 'user_action' : 'automatic_retry',
    stepId,
    summary,
    actionIds: [action.id],
  };
}

function step(input: {
  id: string;
  label: string;
  state: BootstrapStep['state'];
  dependsOn?: string[];
  observation?: BootstrapObservation;
  blocker?: BootstrapBlocker;
  action?: BootstrapAction;
}): BootstrapStep {
  return {
    id: input.id,
    label: input.label,
    state: input.state,
    dependsOn: input.dependsOn ?? [],
    observationIds: input.observation ? [input.observation.id] : [],
    blockerCodes: input.blocker ? [input.blocker.code] : [],
    actionIds: input.action ? [input.action.id] : [],
  };
}

function userOwnsTunnelGuidance(guidance: TunnelGuidance): boolean {
  return guidance.title === 'Create an OpenAI Secure MCP Tunnel'
    || guidance.title === 'Install OpenAI tunnel-client'
    || guidance.title === 'Record existing HTTPS endpoint'
    || guidance.title === 'Create a stable Cloudflare Tunnel'
    || guidance.title === 'Install Cloudflare Tunnel'
    || guidance.title === 'Install Tailscale';
}

export function observeSetupBootstrap(options: SetupBootstrapOptions = {}): BootstrapEvaluation {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const profile = options.profile ?? readSetupProfile(options);
  const platform = options.platform ?? detectSetupPlatform({ env: options.env });
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const observations: BootstrapObservation[] = [];
  const actions: BootstrapAction[] = [];
  const blockers: BootstrapBlocker[] = [];
  const steps: BootstrapStep[] = [];

  const profileObservation: BootstrapObservation = profile
    ? { id: 'setup.profile', component: 'platform', status: 'ready', summary: `Setup profile selects ${profile.primaryController} as primary controller.`, observedAt }
    : { id: 'setup.profile', component: 'platform', status: 'missing', summary: 'No Forge setup profile is configured yet.', reasonCodes: ['SETUP_PROFILE_MISSING'], observedAt };
  observations.push(profileObservation);
  if (!profile) {
    const action = actionFromGuidance({ id: 'controller.select', kind: 'configure', title: 'Configure Forge controller', detail: 'Create the instance-level setup profile.', command: 'forge setup configure --controller chatgpt' });
    const blocker = blockerFor('profile', 'BOOTSTRAP_SETUP_PROFILE_MISSING', action, profileObservation.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: 'profile', label: 'Desired setup profile', state: 'blocked', observation: profileObservation, blocker, action }));
  } else {
    steps.push(step({ id: 'profile', label: 'Desired setup profile', state: 'ready', observation: profileObservation }));
  }

  const controllerGuidance = profile ? dependencies.controller(profile, { controllerHome, home: options.accountHome }) : undefined;
  const controllerObservation: BootstrapObservation = !profile
    ? { id: 'controller.primary', component: 'controller', status: 'unknown', summary: 'Controller readiness waits for setup profile selection.', observedAt }
    : controllerGuidance && !controllerGuidance.ready
      ? { id: 'controller.primary', component: 'controller', status: 'blocked', summary: `${controllerGuidance.title}: ${controllerGuidance.detail}`, provider: controllerGuidance.controller, reasonCodes: ['CONTROLLER_NOT_READY'], observedAt }
      : { id: 'controller.primary', component: 'controller', status: 'ready', summary: 'Configured controller set is ready.', observedAt };
  observations.push(controllerObservation);
  if (!profile) {
    steps.push(step({ id: 'controller', label: 'Controller connectivity', state: 'pending', dependsOn: ['profile'], observation: controllerObservation }));
  } else if (controllerGuidance && !controllerGuidance.ready) {
    const owner: BootstrapAction['owner'] = controllerGuidance.command ? 'forge' : 'user';
    const action = actionFromGuidance({ id: `controller.${controllerGuidance.controller}.configure`, kind: controllerGuidance.command ? 'configure' : 'authenticate', title: controllerGuidance.title, detail: controllerGuidance.detail, command: controllerGuidance.command, owner });
    const blocker = blockerFor('controller', `BOOTSTRAP_CONTROLLER_${controllerGuidance.controller.toUpperCase()}_NOT_READY`, action, controllerObservation.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: 'controller', label: 'Controller connectivity', state: 'blocked', dependsOn: ['profile'], observation: controllerObservation, blocker, action }));
  } else {
    steps.push(step({ id: 'controller', label: 'Controller connectivity', state: 'ready', dependsOn: ['profile'], observation: controllerObservation }));
  }

  const runtimeGuidance = profile ? dependencies.runtime(profile, { controllerHome }) : undefined;
  const runtimeRequired = Boolean(profile && setupNeedsRemoteAccess(profile));
  const runtimeObservation: BootstrapObservation = !profile
    ? { id: 'runtime.package', component: 'runtime', status: 'unknown', summary: 'Runtime readiness waits for setup profile selection.', observedAt }
    : !runtimeRequired
      ? { id: 'runtime.package', component: 'runtime', status: 'ready', summary: 'Packaged Runtime is not required by the configured local-only controller set.', observedAt }
      : runtimeGuidance?.ready
        ? { id: 'runtime.package', component: 'runtime', status: 'ready', summary: runtimeGuidance.detail, observedAt }
        : { id: 'runtime.package', component: 'runtime', status: 'blocked', summary: runtimeGuidance ? `${runtimeGuidance.title}: ${runtimeGuidance.detail}` : 'Packaged Runtime is not ready.', reasonCodes: ['RUNTIME_NOT_READY'], observedAt };
  observations.push(runtimeObservation);
  if (!profile) {
    steps.push(step({ id: 'runtime', label: 'Packaged Runtime', state: 'pending', dependsOn: ['controller'], observation: runtimeObservation }));
  } else if (!runtimeRequired || runtimeGuidance?.ready) {
    steps.push(step({ id: 'runtime', label: 'Packaged Runtime', state: runtimeRequired ? 'ready' : 'skipped', dependsOn: ['controller'], observation: runtimeObservation }));
  } else {
    const action = actionFromGuidance({ id: 'runtime.package.install', kind: 'repair', title: runtimeGuidance?.title ?? 'Repair packaged Runtime', detail: runtimeGuidance?.detail ?? 'Install or repair the packaged Runtime.', command: runtimeGuidance?.command });
    const blocker = blockerFor('runtime', 'BOOTSTRAP_RUNTIME_NOT_READY', action, runtimeObservation.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: 'runtime', label: 'Packaged Runtime', state: 'blocked', dependsOn: ['controller'], observation: runtimeObservation, blocker, action }));
  }

  const tunnelGuidance = profile ? dependencies.tunnel(profile, platform, { controllerHome, env: options.env }) : undefined;
  const connectivityObservation: BootstrapObservation = !profile
    ? { id: 'connectivity.controller', component: 'connectivity', status: 'unknown', summary: 'Connectivity policy waits for setup profile selection.', observedAt }
    : tunnelGuidance?.ready
      ? { id: 'connectivity.controller', component: 'connectivity', status: 'ready', summary: tunnelGuidance.detail, provider: tunnelGuidance.provider, endpoint: profile.tunnel.endpoint, observedAt }
      : { id: 'connectivity.controller', component: 'connectivity', status: 'blocked', summary: tunnelGuidance ? `${tunnelGuidance.title}: ${tunnelGuidance.detail}` : 'Controller connectivity is not ready.', provider: tunnelGuidance?.provider, reasonCodes: ['CONNECTIVITY_NOT_READY'], observedAt };
  observations.push(connectivityObservation);
  if (!profile) {
    steps.push(step({ id: 'connectivity', label: 'Controller transport', state: 'pending', dependsOn: ['runtime'], observation: connectivityObservation }));
  } else if (tunnelGuidance?.ready) {
    steps.push(step({ id: 'connectivity', label: 'Controller transport', state: setupNeedsRemoteAccess(profile) ? 'ready' : 'skipped', dependsOn: ['runtime'], observation: connectivityObservation }));
  } else {
    const userOwned = tunnelGuidance ? userOwnsTunnelGuidance(tunnelGuidance) : true;
    const action = actionFromGuidance({ id: `tunnel.${tunnelGuidance?.provider ?? 'unknown'}.configure`, kind: userOwned ? 'authenticate' : 'reconnect', title: tunnelGuidance?.title ?? 'Configure controller transport', detail: tunnelGuidance?.detail ?? 'Configure controller transport.', command: tunnelGuidance?.command, owner: userOwned ? 'user' : 'forge' });
    const blocker = blockerFor('connectivity', `BOOTSTRAP_CONNECTIVITY_${(tunnelGuidance?.provider ?? 'UNKNOWN').toUpperCase().replaceAll('-', '_')}_NOT_READY`, action, connectivityObservation.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: 'connectivity', label: 'Controller transport', state: 'blocked', dependsOn: ['runtime'], observation: connectivityObservation, blocker, action }));
  }

  const bridgeGuidance = dependencies.bridge(profile, platform, { controllerHome });
  const bridgeObservation: BootstrapObservation = !bridgeGuidance.required
    ? { id: 'provider.chatgpt.wsl-bridge', component: 'provider', status: 'ready', summary: bridgeGuidance.summary, observedAt }
    : bridgeGuidance.ready
      ? { id: 'provider.chatgpt.wsl-bridge', component: 'provider', status: 'ready', summary: bridgeGuidance.summary, provider: 'controlled-windows-chromium', observedAt }
      : { id: 'provider.chatgpt.wsl-bridge', component: 'provider', status: 'missing', summary: bridgeGuidance.summary, provider: 'controlled-windows-chromium', reasonCodes: ['CHATGPT_WSL_BRIDGE_BROWSER_NOT_READY'], observedAt };
  observations.push(bridgeObservation);
  if (!bridgeGuidance.required) {
    steps.push(step({ id: 'chatgpt-wsl-bridge', label: 'WSL ChatGPT bridge browser', state: 'skipped', dependsOn: ['connectivity'], observation: bridgeObservation }));
  } else if (bridgeGuidance.ready) {
    steps.push(step({ id: 'chatgpt-wsl-bridge', label: 'WSL ChatGPT bridge browser', state: 'ready', dependsOn: ['connectivity'], observation: bridgeObservation }));
  } else {
    const action: BootstrapAction = bridgeGuidance.automatic
      ? { id: 'chatgpt.bridge.bootstrap', kind: 'install', owner: 'forge', summary: bridgeGuidance.summary, command: 'forge setup bridge-browser', verification: 'forge setup next' }
      : { id: 'chatgpt.bridge.user-action', kind: 'install', owner: 'user', summary: bridgeGuidance.summary, verification: 'forge setup next' };
    const blocker = blockerFor('chatgpt-wsl-bridge', 'BOOTSTRAP_CHATGPT_WSL_BRIDGE_BROWSER_NOT_READY', action, bridgeGuidance.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: 'chatgpt-wsl-bridge', label: 'WSL ChatGPT bridge browser', state: 'blocked', dependsOn: ['connectivity'], observation: bridgeObservation, blocker, action }));
  }

  const desired = desiredState(profile, options.capabilities);
  for (const resolution of dependencies.capabilities(desired.capabilityIntents, { controllerHome, platform })) {
    const safeCapabilityId = resolution.capabilityId.replace(/[^a-zA-Z0-9_.-]+/g, '-');
    const observation: BootstrapObservation = {
      id: `capability.${safeCapabilityId}`,
      component: 'plugin',
      status: resolution.status === 'ready' ? 'ready' : resolution.status === 'unsupported' ? 'unsupported' : 'degraded',
      summary: resolution.summary,
      ...(resolution.providerId ? { provider: resolution.providerId } : {}),
      ...(resolution.status === 'ready' ? {} : { reasonCodes: [`CAPABILITY_${resolution.status.toUpperCase()}`] }),
      observedAt,
    };
    observations.push(observation);
    const stepId = `capability.${safeCapabilityId}`;
    if (resolution.status === 'ready') {
      steps.push(step({ id: stepId, label: `Capability ${resolution.capabilityId}`, state: 'ready', dependsOn: ['connectivity'], observation }));
      continue;
    }
    if (resolution.status === 'unsupported' || !resolution.providerId) {
      const blocker: BootstrapBlocker = {
        code: `BOOTSTRAP_CAPABILITY_${safeCapabilityId.toUpperCase().replaceAll('.', '_').replaceAll('-', '_')}_UNSUPPORTED`,
        kind: 'unsupported',
        stepId,
        summary: resolution.summary,
        actionIds: [],
      };
      blockers.push(blocker);
      steps.push(step({ id: stepId, label: `Capability ${resolution.capabilityId}`, state: 'blocked', dependsOn: ['connectivity'], observation, blocker }));
      continue;
    }
    const action: BootstrapAction = {
      id: `capability.${safeCapabilityId}.${resolution.status === 'installable' ? 'install' : 'repair'}`,
      kind: resolution.status === 'installable' ? 'install' : 'repair',
      owner: 'forge',
      summary: `${resolution.status === 'installable' ? 'Install' : 'Repair'} ${resolution.providerName ?? resolution.providerId} for ${resolution.capabilityId}.`,
      command: `forge plugin install ${resolution.providerId} --controller-home ${JSON.stringify(controllerHome)}`,
      verification: 'forge setup next',
    };
    const blocker = blockerFor(stepId, `BOOTSTRAP_CAPABILITY_${safeCapabilityId.toUpperCase().replaceAll('.', '_').replaceAll('-', '_')}_${resolution.status.toUpperCase()}`, action, resolution.summary);
    actions.push(action); blockers.push(blocker);
    steps.push(step({ id: stepId, label: `Capability ${resolution.capabilityId}`, state: 'blocked', dependsOn: ['connectivity'], observation, blocker, action }));
  }

  return { desired, observations, steps, blockers, actions };
}

export function createSetupBootstrapControlApi(options: SetupBootstrapOptions = {}): BootstrapControlApi {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const observe = (): BootstrapEvaluation => observeSetupBootstrap({ ...options, controllerHome });
  return createBootstrapControlApi({
    controllerHome,
    now: options.now,
    adapter: {
      observe,
      observeSync: observe,
      perform: async (action) => {
        if (action.id !== 'chatgpt.bridge.bootstrap') throw new Error(`BOOTSTRAP_ACTION_EXECUTOR_UNSUPPORTED: ${action.id}`);
        const platform = options.platform ?? detectSetupPlatform({ env: options.env });
        if (platform.environment !== 'wsl2') throw new Error('CHATGPT_BRIDGE_BOOTSTRAP_WSL_REQUIRED');
        const bridgeRoot = setupBridgeRoot(controllerHome);
        if (!bridgeRoot) throw new Error('CHATGPT_CONTROLLER_BROWSER_ROOT_UNAVAILABLE');
        await bootstrapWslWindowsBridgeBrowser(bridgeRoot, { platform: 'linux', wslDistroName: 'ForgeSetup' });
      },
    },
  });
}

export function refreshSetupBootstrap(options: SetupBootstrapOptions = {}): BootstrapSnapshot {
  return createSetupBootstrapControlApi(options).refreshSync();
}
