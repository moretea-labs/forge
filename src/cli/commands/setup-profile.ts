import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { loadMcpServiceLocalConfig } from '../mcp/auth';
import { resolveControllerHome } from '../repositories/controller-home';
import { observeRuntimeStatus } from '../../runtime/root/status';
import { dirname, join, resolve } from 'path';

export type SetupControllerKind = 'chatgpt' | 'codex' | 'claude' | 'mcp';
export type SetupTunnelProvider = 'auto' | 'openai' | 'cloudflare' | 'tailscale' | 'existing' | 'none';
export type SetupHostTarget = 'none' | 'codex' | 'claude' | 'both';

export interface SetupProfile {
  schemaVersion: 1;
  primaryController: SetupControllerKind;
  controllers: SetupControllerKind[];
  tunnel: {
    provider: SetupTunnelProvider;
    endpoint?: string;
    tunnelId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SetupPlatformSnapshot {
  platform: NodeJS.Platform;
  arch: string;
  environment: 'macos' | 'linux' | 'wsl2' | 'windows' | 'other';
  serviceManager: 'launchd' | 'systemd-user' | 'windows-preview' | 'foreground';
  commands: {
    brew: boolean;
    cloudflared: boolean;
    tailscale: boolean;
    tunnelClient: boolean;
    systemctl: boolean;
    winget: boolean;
  };
}

export interface SetupProfileOptions {
  setupRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface ConfigureSetupProfileOptions extends SetupProfileOptions {
  controller?: string;
  addControllers?: string[];
  tunnel?: string;
  endpoint?: string;
  tunnelId?: string;
}

export interface TunnelGuidance {
  provider: SetupTunnelProvider;
  ready: boolean;
  title: string;
  detail: string;
  command?: string;
}

const CONTROLLERS: readonly SetupControllerKind[] = ['chatgpt', 'codex', 'claude', 'mcp'];
const TUNNELS: readonly SetupTunnelProvider[] = ['auto', 'openai', 'cloudflare', 'tailscale', 'existing', 'none'];

function setupHome(options: SetupProfileOptions = {}): string {
  const env = options.env ?? process.env;
  return resolve(options.setupRoot ?? env.FORGE_SETUP_HOME ?? join(env.HOME ?? homedir(), '.forge'));
}

export function setupProfilePath(options: SetupProfileOptions = {}): string {
  return join(setupHome(options), 'setup', 'profile.json');
}

function normalizeController(value: string | undefined, label: string): SetupControllerKind | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!CONTROLLERS.includes(normalized as SetupControllerKind)) {
    throw new Error(`${label}: invalid controller "${value}" (expected: ${CONTROLLERS.join(', ')})`);
  }
  return normalized as SetupControllerKind;
}

function normalizeTunnel(value: string | undefined): SetupTunnelProvider | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!TUNNELS.includes(normalized as SetupTunnelProvider)) {
    throw new Error(`invalid tunnel provider "${value}" (expected: ${TUNNELS.join(', ')})`);
  }
  return normalized as SetupTunnelProvider;
}

function normalizeTunnelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^tunnel_[0-9a-f]{32}$/.test(trimmed)) throw new Error('invalid OpenAI tunnel id: expected tunnel_ followed by 32 lowercase hexadecimal characters');
  return trimmed;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`invalid setup endpoint "${value}": expected HTTPS URL ending in /mcp`); }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/mcp' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`invalid setup endpoint "${value}": expected HTTPS URL ending in /mcp`);
  }
  return parsed.toString();
}

export function readSetupProfile(options: SetupProfileOptions = {}): SetupProfile | undefined {
  try {
    const value = JSON.parse(readFileSync(setupProfilePath(options), 'utf8')) as SetupProfile;
    if (value.schemaVersion !== 1 || !CONTROLLERS.includes(value.primaryController)) return undefined;
    const controllers = Array.isArray(value.controllers)
      ? value.controllers.filter((entry): entry is SetupControllerKind => CONTROLLERS.includes(entry))
      : [];
    return { ...value, controllers: Array.from(new Set([value.primaryController, ...controllers])) };
  } catch {
    return undefined;
  }
}

export function configureSetupProfile(options: ConfigureSetupProfileOptions): SetupProfile {
  const previous = readSetupProfile(options);
  const primaryController = normalizeController(options.controller, 'forge setup configure --controller')
    ?? previous?.primaryController
    ?? 'chatgpt';
  const additions = (options.addControllers ?? []).map((entry) => normalizeController(entry, 'forge setup configure --add-controller')!);
  const controllers = Array.from(new Set([primaryController, ...(previous?.controllers ?? []), ...additions]));
  const provider = normalizeTunnel(options.tunnel)
    ?? previous?.tunnel.provider
    ?? (controllers.some((entry) => entry === 'chatgpt' || entry === 'mcp') ? 'auto' : 'none');
  const explicitTunnel = normalizeTunnel(options.tunnel);
  const endpoint = provider === 'openai' || provider === 'none'
    ? undefined
    : normalizeEndpoint(options.endpoint) ?? (previous?.tunnel.provider === provider ? previous.tunnel.endpoint : undefined);
  const tunnelId = provider === 'openai'
    ? normalizeTunnelId(options.tunnelId) ?? (previous?.tunnel.provider === 'openai' ? previous.tunnel.tunnelId : undefined)
    : undefined;
  if (provider === 'existing' && !endpoint) {
    throw new Error('forge setup configure --tunnel existing requires --endpoint https://.../mcp');
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const profile: SetupProfile = {
    schemaVersion: 1,
    primaryController,
    controllers,
    tunnel: { provider, ...(endpoint ? { endpoint } : {}), ...(tunnelId ? { tunnelId } : {}) },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const path = setupProfilePath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  return profile;
}

export function setupHostTarget(profile: SetupProfile | undefined): SetupHostTarget {
  if (!profile) return 'none';
  const codex = profile.controllers.includes('codex');
  const claude = profile.controllers.includes('claude');
  if (codex && claude) return 'both';
  if (codex) return 'codex';
  if (claude) return 'claude';
  return 'none';
}

export function setupNeedsRemoteAccess(profile: SetupProfile | undefined): boolean {
  return Boolean(profile?.controllers.some((entry) => entry === 'chatgpt' || entry === 'mcp'));
}

function commandExists(command: string, platform = process.platform): boolean {
  const probe = platform === 'win32'
    ? spawnSync('where.exe', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

export function detectSetupPlatform(options: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv } = {}): SetupPlatformSnapshot {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wsl = platform === 'linux' && isWsl(env);
  const systemctl = platform === 'linux' && commandExists('systemctl', platform);
  return {
    platform,
    arch: options.arch ?? process.arch,
    environment: platform === 'darwin' ? 'macos' : platform === 'linux' ? (wsl ? 'wsl2' : 'linux') : platform === 'win32' ? 'windows' : 'other',
    serviceManager: platform === 'darwin' ? 'launchd' : platform === 'linux' && systemctl ? 'systemd-user' : platform === 'win32' ? 'windows-preview' : 'foreground',
    commands: {
      brew: platform === 'darwin' && commandExists('brew', platform),
      cloudflared: commandExists('cloudflared', platform),
      tailscale: commandExists('tailscale', platform),
      tunnelClient: commandExists('tunnel-client', platform),
      systemctl,
      winget: platform === 'win32' && commandExists('winget', platform),
    },
  };
}


function isLoopbackMcpEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
      && parsed.pathname === '/mcp'
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

export interface ControllerGuidance {
  controller: SetupControllerKind;
  ready: boolean;
  title: string;
  detail: string;
  command?: string;
}

function codexUserControllerConfigured(home = homedir()): boolean {
  const path = join(home, '.codex', 'config.toml');
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, 'utf8');
    const block = text.match(/\[mcp_servers\.forge\][\s\S]*?(?=\n\[|$)/)?.[0] ?? '';
    return block.includes('"mcp"') && block.includes('"serve"') && block.includes('"controller"');
  } catch { return false; }
}

function claudeUserControllerConfigured(): boolean {
  if (!commandExists('claude')) return false;
  const probe = spawnSync('claude', ['mcp', 'get', 'forge'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  if (probe.status !== 0) return false;
  const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  return /forge\s+mcp\s+serve|"mcp".*"serve"/is.test(text) && /controller/i.test(text);
}

export function resolveControllerGuidance(
  profile: SetupProfile | undefined,
  options: { controllerHome?: string; home?: string } = {},
): ControllerGuidance | undefined {
  if (!profile) return undefined;
  const controllerHome = resolveControllerHome(options.controllerHome);
  const localConfig = loadMcpServiceLocalConfig(controllerHome);
  for (const controller of profile.controllers) {
    if (controller === 'chatgpt' || controller === 'mcp') {
      const localReady = localConfig?.profile === 'controller'
        && localConfig.server?.host === '127.0.0.1'
        && Number.isInteger(localConfig.server?.port);
      const connectorReady = controller !== 'chatgpt' || isLoopbackMcpEndpoint(localConfig?.chatgpt?.localEndpoint);
      const endpointReady = !profile.tunnel.endpoint || localConfig?.chatgpt?.endpoint === profile.tunnel.endpoint;
      if (!localReady || !connectorReady || !endpointReady) {
        const endpoint = profile.tunnel.endpoint ? ` --endpoint ${profile.tunnel.endpoint}` : '';
        return {
          controller,
          ready: false,
          title: controller === 'chatgpt' ? 'Configure the ChatGPT controller endpoint' : 'Configure the remote MCP controller endpoint',
          detail: 'Create the user-level Forge OAuth/MCP configuration. This does not install Codex or Claude and does not require a repository.',
          command: `forge mcp setup chatgpt --user-level${endpoint}`,
        };
      }
      continue;
    }
    if (controller === 'codex') {
      if (!codexUserControllerConfigured(options.home)) {
        return {
          controller, ready: false, title: 'Configure Codex as a Forge controller',
          detail: 'Codex is optional. Configure it only because it was explicitly selected as a controller entry.',
          command: 'forge mcp setup codex --scope user --profile controller',
        };
      }
      continue;
    }
    if (!commandExists('claude')) {
      return {
        controller, ready: false, title: 'Install Claude Code only for this selected controller',
        detail: 'Claude is not a Forge dependency. Install and authenticate Claude Code, then continue setup.',
      };
    }
    if (!claudeUserControllerConfigured()) {
      return {
        controller, ready: false, title: 'Configure Claude Code as a Forge controller',
        detail: 'Forge delegates MCP registration to the official Claude CLI at user scope.',
        command: 'forge mcp setup claude --scope user --profile controller',
      };
    }
  }
  return undefined;
}


export interface RuntimeGuidance {
  ready: boolean;
  title: string;
  detail: string;
  command?: string;
}

export function resolveRuntimeGuidance(
  profile: SetupProfile | undefined,
  options: { controllerHome?: string } = {},
): RuntimeGuidance | undefined {
  if (!profile || !setupNeedsRemoteAccess(profile)) return undefined;
  const controllerHome = resolveControllerHome(options.controllerHome);
  const status = observeRuntimeStatus(controllerHome);
  if (status.ready) return { ready: true, title: 'Forge Runtime', detail: 'Canonical Runtime is running and ready.' };
  if (status.running) {
    return {
      ready: false,
      title: 'Forge Runtime is starting or unhealthy',
      detail: `Runtime owner is running but not ready (${status.reasonCodes.join(', ') || 'unknown'}). Inspect status before continuing.`,
      command: `forge runtime status --controller-home ${controllerHome}`,
    };
  }
  return {
    ready: false,
    title: 'Install the user-level Forge Runtime',
    detail: 'Use the packaged Runtime path. It does not require a Git checkout, Bun compilation, CodeGraph, or Standalone Recovery.',
    command: 'forge runtime service install-package',
  };
}

export function resolveTunnelGuidance(
  profile: SetupProfile | undefined,
  platform = detectSetupPlatform(),
  options: { controllerHome?: string; env?: NodeJS.ProcessEnv } = {},
): TunnelGuidance {
  if (!profile || !setupNeedsRemoteAccess(profile)) {
    return { provider: 'none', ready: true, title: 'Remote controller connection', detail: 'Not required by the configured local controller set.' };
  }
  if (profile.tunnel.endpoint) {
    return { provider: profile.tunnel.provider, ready: true, title: 'HTTPS endpoint configured', detail: `Configured: ${profile.tunnel.endpoint}. Live connector reachability is verified in the ChatGPT connection step.` };
  }
  let provider = profile.tunnel.provider;
  if (provider === 'auto') {
    // ChatGPT's private outbound path is the default. Do not silently choose a
    // public ingress provider merely because cloudflared/tailscale happens to
    // be installed; users without Secure Tunnel access can explicitly select a
    // fallback provider.
    provider = 'openai';
  }
  if (provider === 'openai') {
    if (!profile.tunnel.tunnelId) {
      return {
        provider, ready: false, title: 'Create an OpenAI Secure MCP Tunnel',
        detail: 'Create a tunnel in OpenAI Platform Tunnels, associate it with the target ChatGPT workspace, then record the non-secret tunnel_id in Forge. Do not paste a runtime API key into Forge setup.',
        command: 'forge setup configure --controller chatgpt --tunnel openai --tunnel-id tunnel_...',
      };
    }
    if (!platform.commands.tunnelClient) {
      return {
        provider, ready: false, title: 'Install OpenAI tunnel-client',
        detail: 'Install the supported tunnel-client binary from OpenAI Platform Tunnels or the official openai/tunnel-client release. The runtime API key remains an environment/file reference owned by tunnel-client; Forge does not store it.',
      };
    }
    const preferredAlias = 'forge';
    const aliases = [preferredAlias];
    const listed = spawnSync('tunnel-client', ['runtimes', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, env: options.env ?? process.env });
    if (listed.status === 0) {
      try {
        const value = JSON.parse(listed.stdout || '{}') as { aliases?: Array<{ alias?: string; tunnel_id?: string }> };
        for (const entry of value.aliases ?? []) {
          if (entry.tunnel_id === profile.tunnel.tunnelId && entry.alias) aliases.push(entry.alias);
        }
      } catch {
        // Older clients may not expose local aliases as JSON. Keep the preferred alias fallback.
      }
    }
    for (const alias of Array.from(new Set(aliases))) {
      const status = spawnSync('tunnel-client', ['runtimes', 'status', alias, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, env: options.env ?? process.env });
      if (status.status !== 0) continue;
      try {
        const value = JSON.parse(status.stdout || '{}') as { process_running?: boolean; healthy?: boolean; ready?: boolean; tunnel_id?: string };
        if (value.process_running === true && value.healthy === true && value.ready === true
          && (!value.tunnel_id || value.tunnel_id === profile.tunnel.tunnelId)) {
          return {
            provider, ready: true, title: 'OpenAI Secure MCP Tunnel',
            detail: `Managed runtime ${alias} is running, healthy, and ready for ${profile.tunnel.tunnelId}.`,
          };
        }
      } catch {
        // Treat malformed or older status output as not-ready instead of claiming success.
      }
    }
    const alias = preferredAlias;
    const localConfig = loadMcpServiceLocalConfig(resolveControllerHome(options.controllerHome));
    const localEndpoint = localConfig?.chatgpt?.localEndpoint;
    if (!isLoopbackMcpEndpoint(localEndpoint)) {
      return {
        provider, ready: false, title: 'Prepare the local ChatGPT OAuth endpoint',
        detail: 'Secure Tunnel must terminate at Forge’s loopback OAuth Gateway, not the bearer-only Canonical Runtime. Refresh the user-level ChatGPT MCP configuration first.',
        command: 'forge mcp setup chatgpt --user-level',
      };
    }
    return {
      provider, ready: false, title: 'Connect OpenAI Secure MCP Tunnel',
      detail: 'Create a supervised tunnel-client runtime and verify it with runtimes status. Keep the runtime API key in an environment or file reference owned by tunnel-client; Forge never reads or stores the key.',
      command: `tunnel-client runtimes connect --alias ${alias} --tunnel-id ${profile.tunnel.tunnelId} --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url ${localEndpoint}`,
    };
  }
  if (provider === 'none') {
    return {
      provider, ready: false, title: 'Remote controller access is deferred',
      detail: 'The selected controller set includes ChatGPT/remote MCP, but remote connectivity is deferred.',
      command: 'forge setup configure --controller chatgpt --tunnel auto',
    };
  }
  if (provider === 'existing') {
    return {
      provider, ready: false, title: 'Record existing HTTPS endpoint',
      detail: 'Provide the existing public HTTPS URL ending in /mcp.',
      command: 'forge setup configure --tunnel existing --endpoint https://forge.example.com/mcp',
    };
  }
  if (provider === 'cloudflare') {
    if (!platform.commands.cloudflared) {
      const install = platform.environment === 'macos' && platform.commands.brew ? 'brew install cloudflared' : undefined;
      return {
        provider, ready: false, title: 'Install Cloudflare Tunnel',
        detail: platform.environment === 'windows'
          ? 'Install the official cloudflared executable or MSI, then run forge setup next.'
          : platform.environment === 'linux' || platform.environment === 'wsl2'
            ? 'Install cloudflared from Cloudflare’s official package repository for this Linux distribution, then run forge setup next.'
            : 'Install cloudflared, then run forge setup next.',
        ...(install ? { command: install } : {}),
      };
    }
    return {
      provider, ready: false, title: 'Create a stable Cloudflare Tunnel',
      detail: 'Authenticate cloudflared, create/route a named tunnel to 127.0.0.1:8765, then record its HTTPS /mcp URL.',
      command: 'cloudflared tunnel login',
    };
  }
  if (!platform.commands.tailscale) {
    return {
      provider: 'tailscale', ready: false, title: 'Install Tailscale',
      detail: platform.environment === 'macos'
        ? 'Install Tailscale for macOS and enable CLI integration, then run forge setup next.'
        : platform.environment === 'windows'
          ? 'Install the official Tailscale Windows client, sign in, then run forge setup next.'
          : 'Install Tailscale for Linux, sign in, then run forge setup next.',
    };
  }
  return {
    provider: 'tailscale', ready: false, title: 'Enable Tailscale Funnel',
    detail: 'Expose only the local Forge MCP service and then record the generated HTTPS /mcp URL.',
    command: 'tailscale funnel --bg 8765',
  };
}

export function formatSetupProfile(profile: SetupProfile, platform = detectSetupPlatform()): string {
  const tunnel = resolveTunnelGuidance(profile, platform);
  return [
    `Primary controller: ${profile.primaryController}`,
    `Configured controllers: ${profile.controllers.join(', ')}`,
    `Platform: ${platform.environment}/${platform.arch}; service=${platform.serviceManager}`,
    `Remote access: ${profile.tunnel.provider}${profile.tunnel.endpoint ? ` (${profile.tunnel.endpoint})` : profile.tunnel.tunnelId ? ` (${profile.tunnel.tunnelId})` : ''}`, 
    `Tunnel readiness: ${tunnel.ready ? 'ready' : 'needs setup'} — ${tunnel.detail}`,
    'Forge itself remains the execution/runtime layer; it does not choose semantic actions without an external controller.',
  ].join('\n');
}
