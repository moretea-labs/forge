import { spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerCapabilityId,
} from '../../../packages/protocols/computer/index';
import { resolveControllerHome, controllerSystemRoot } from '../repositories/controller-home';
import { discoverPreferredNativeBrowserProduct } from '../../runtime/platform/browser-product-discovery';
import { getExternalPluginRegistration, removeExternalPluginRegistration } from '../../runtime/plugins/external-registration';
import {
  readControllerStoredPluginManifest,
  removeControllerPluginManifestProjection,
  syncControllerPluginManifest,
} from '../../runtime/plugins/store';
import {
  installOfficialPlugin,
  officialPluginCatalogEntry,
  pluginCatalogCompatibility,
  withOfficialPluginLifecycleLock,
} from './plugin';

export const COMPUTER_PROVIDER_PLUGIN_ID = 'desktop_operator';
const COMPUTER_PRODUCT_ID = 'computer';

interface ComputerCliOptions {
  controllerHome?: string;
  json?: boolean;
  purge?: boolean;
}

export interface ComputerProviderHealth {
  state: string;
  ready: boolean;
  probed: boolean;
  errors: string[];
  warnings: string[];
  details?: Record<string, unknown>;
}

export interface ComputerProviderStatus {
  implementation: 'Forge Desktop Operator';
  pluginId: typeof COMPUTER_PROVIDER_PLUGIN_ID;
  installedVersion?: string;
  protocolVersion?: string;
  catalogVersion: string;
  enabled: boolean;
  updateAvailable: boolean;
  releaseIndependent: true;
  transport?: string;
  lifecycle?: string;
  health: ComputerProviderHealth;
}

export type ComputerCapabilityState = 'ready' | 'missing' | 'degraded' | 'unsupported';

export interface ComputerCapabilityStatus {
  capabilityId: ComputerCapabilityId;
  provider: 'browser' | 'desktop_operator';
  supported: boolean;
  ready: boolean;
  state: ComputerCapabilityState;
  reason?: string;
}

export interface ComputerStatusReport {
  schemaVersion: 1;
  product: typeof COMPUTER_PRODUCT_ID;
  platform: NodeJS.Platform;
  supported: boolean;
  partial: boolean;
  installed: boolean;
  ready: boolean;
  capabilities: ComputerCapabilityStatus[];
  provider: ComputerProviderStatus;
  compatibilityReason?: string;
}

export interface ComputerDoctorReport {
  schemaVersion: 1;
  product: typeof COMPUTER_PRODUCT_ID;
  ok: boolean;
  status: ComputerStatusReport;
  checks: Array<{ id: string; state: 'pass' | 'warn' | 'fail'; message: string }>;
}

function catalogEntry() {
  const entry = officialPluginCatalogEntry(COMPUTER_PROVIDER_PLUGIN_ID);
  if (!entry) throw new Error('COMPUTER_PROVIDER_CATALOG_ENTRY_MISSING');
  return entry;
}

function providerPackageRoot(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugins', 'packages', COMPUTER_PROVIDER_PLUGIN_ID);
}

function unavailableHealth(state: string, message: string): ComputerProviderHealth {
  return {
    state,
    ready: false,
    probed: false,
    errors: [message],
    warnings: [],
  };
}

function providerHealth(controllerHome: string): ComputerProviderHealth {
  const registration = getExternalPluginRegistration(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
  if (!registration) return unavailableHealth('not_installed', 'Computer macOS provider is not installed.');
  const stored = readControllerStoredPluginManifest(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
  if (!stored) {
    return unavailableHealth('unprobed', 'Computer provider health has not been recorded yet; run forge computer doctor.');
  }
  const health = stored.health;
  return {
    state: health.state,
    ready: health.ready,
    probed: health.probed,
    errors: [...health.errors],
    warnings: [...health.warnings],
    details: health.details ? { ...health.details } : undefined,
  };
}

function browserCapabilityStatus(input: {
  platform: NodeJS.Platform;
  compatibility: ReturnType<typeof pluginCatalogCompatibility>;
  registration: ReturnType<typeof getExternalPluginRegistration>;
  health: ComputerProviderHealth;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}): ComputerCapabilityStatus {
  const supported = input.platform === 'darwin' || input.platform === 'linux' || input.platform === 'win32';
  if (!supported) return { capabilityId: COMPUTER_BROWSER_AUTOMATION_CAPABILITY, provider: 'browser', supported: false, ready: false, state: 'unsupported', reason: `Browser Computer capability is unsupported on ${input.platform}.` };

  const nativeDeclaresBrowser = input.registration?.capabilities.some((capability) => capability.capabilityId === COMPUTER_BROWSER_AUTOMATION_CAPABILITY) === true;
  if (input.compatibility.compatible && input.registration?.enabled && input.health.ready && nativeDeclaresBrowser) {
    return { capabilityId: COMPUTER_BROWSER_AUTOMATION_CAPABILITY, provider: 'desktop_operator', supported: true, ready: true, state: 'ready' };
  }

  const discoveredBrowser = discoverPreferredNativeBrowserProduct({
    platform: input.platform,
    env: input.env,
    fileExists: input.fileExists,
  });
  return {
    capabilityId: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
    provider: 'browser',
    supported: true,
    ready: false,
    state: 'missing',
    reason: discoveredBrowser
      ? `Discovered ${discoveredBrowser.appName}, but no generic Computer Browser provider readiness proof is bound yet.`
      : 'No ready Computer Browser provider is bound; run forge computer setup or forge setup to discover and configure one.',
  };
}

function desktopCapabilityStatus(
  capabilityId: typeof COMPUTER_OBSERVE_CAPABILITY | typeof COMPUTER_INPUT_CAPABILITY | typeof COMPUTER_CAPTURE_CAPABILITY,
  compatibility: ReturnType<typeof pluginCatalogCompatibility>,
  registration: ReturnType<typeof getExternalPluginRegistration>,
  health: ComputerProviderHealth,
): ComputerCapabilityStatus {
  if (!compatibility.compatible) return { capabilityId, provider: 'desktop_operator', supported: false, ready: false, state: 'unsupported', reason: compatibility.reason };
  if (!registration) return { capabilityId, provider: 'desktop_operator', supported: true, ready: false, state: 'missing', reason: 'Native Computer provider is not installed.' };
  const declared = registration.capabilities.some((capability) => capability.capabilityId === capabilityId);
  const ready = registration.enabled && health.ready && declared;
  return {
    capabilityId,
    provider: 'desktop_operator',
    supported: true,
    ready,
    state: ready ? 'ready' : 'degraded',
    reason: ready ? undefined : (!declared
      ? `Installed native Computer provider does not declare ${capabilityId}.`
      : (health.errors[0] ?? health.warnings[0] ?? `Native Computer provider health is ${health.state}.`)),
  };
}

export function readComputerStatus(options: { controllerHome?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fileExists?: (path: string) => boolean } = {}): ComputerStatusReport {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const platform = options.platform ?? process.platform;
  const entry = catalogEntry();
  const compatibility = pluginCatalogCompatibility(entry, platform);
  const registration = getExternalPluginRegistration(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
  const health = providerHealth(controllerHome);
  const installedVersion = registration?.pluginVersion;
  const provider: ComputerProviderStatus = {
    implementation: 'Forge Desktop Operator',
    pluginId: COMPUTER_PROVIDER_PLUGIN_ID,
    installedVersion,
    protocolVersion: registration?.protocolVersion,
    catalogVersion: entry.version,
    enabled: registration?.enabled === true,
    updateAvailable: Boolean(installedVersion && installedVersion !== entry.version),
    releaseIndependent: true,
    transport: registration?.transport.kind,
    lifecycle: registration?.lifecycle?.kind,
    health,
  };
  const capabilities = [
    browserCapabilityStatus({ platform, compatibility, registration, health, env: options.env, fileExists: options.fileExists }),
    desktopCapabilityStatus(COMPUTER_OBSERVE_CAPABILITY, compatibility, registration, health),
    desktopCapabilityStatus(COMPUTER_INPUT_CAPABILITY, compatibility, registration, health),
    desktopCapabilityStatus(COMPUTER_CAPTURE_CAPABILITY, compatibility, registration, health),
  ];
  const supportedCapabilities = capabilities.filter((capability) => capability.supported);
  return {
    schemaVersion: 1,
    product: COMPUTER_PRODUCT_ID,
    platform,
    supported: supportedCapabilities.length > 0,
    partial: supportedCapabilities.length > 0 && supportedCapabilities.length < capabilities.length,
    installed: Boolean(registration),
    ready: capabilities.every((capability) => capability.ready),
    capabilities,
    provider,
    compatibilityReason: compatibility.reason,
  };
}

export function runComputerSetup(options: { controllerHome?: string } = {}): {
  installed: Record<string, unknown>;
  status: ComputerStatusReport;
} {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const installed = installOfficialPlugin(COMPUTER_PROVIDER_PLUGIN_ID, controllerHome);
  return { installed, status: readComputerStatus({ controllerHome }) };
}

export function runComputerUpdate(options: { controllerHome?: string } = {}) {
  return runComputerSetup(options);
}

export function runComputerDoctor(options: { controllerHome?: string } = {}): ComputerDoctorReport {
  const controllerHome = resolveControllerHome(options.controllerHome);
  if (getExternalPluginRegistration(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID)) {
    syncControllerPluginManifest(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
  }
  const status = readComputerStatus({ controllerHome });
  const checks: ComputerDoctorReport['checks'] = [];
  checks.push({
    id: 'platform',
    state: status.partial ? 'warn' : (status.supported ? 'pass' : 'fail'),
    message: status.partial
      ? `Computer has partial capability support on ${status.platform}; capability details are reported individually.`
      : (status.supported ? `Computer capabilities are supported on ${status.platform}.` : `Computer is unsupported on ${status.platform}.`),
  });
  for (const capability of status.capabilities) {
    checks.push({
      id: `capability:${capability.capabilityId}`,
      state: capability.ready ? 'pass' : (capability.supported ? 'fail' : 'warn'),
      message: capability.ready ? `${capability.capabilityId} is ready.` : (capability.reason ?? `${capability.capabilityId} is ${capability.state}.`),
    });
  }
  const nativeProviderSupported = status.capabilities.some((capability) => capability.provider === 'desktop_operator' && capability.supported);
  checks.push({
    id: 'installed',
    state: nativeProviderSupported ? (status.installed ? 'pass' : 'fail') : 'warn',
    message: nativeProviderSupported
      ? (status.installed ? `Native Computer provider ${status.provider.installedVersion ?? 'unknown'} is installed.` : 'Native Computer provider is not installed.')
      : `Native Desktop Computer provider is not part of the supported capability set on ${status.platform}.`,
  });
  if (status.installed) {
    checks.push({
      id: 'registration',
      state: status.provider.enabled ? 'pass' : 'fail',
      message: status.provider.enabled
        ? 'Computer provider registration is enabled.'
        : 'Computer provider registration is disabled.',
    });
    checks.push({
      id: 'release',
      state: status.provider.updateAvailable ? 'warn' : 'pass',
      message: status.provider.updateAvailable
        ? `Computer provider ${status.provider.installedVersion ?? 'unknown'} differs from pinned ${status.provider.catalogVersion}; run forge computer update.`
        : `Computer provider matches pinned ${status.provider.catalogVersion}.`,
    });
    checks.push({
      id: 'provider-health',
      state: status.provider.health.ready
        ? 'pass'
        : (status.provider.health.state === 'degraded' ? 'warn' : 'fail'),
      message: status.provider.health.errors[0]
        ?? status.provider.health.warnings[0]
        ?? `Computer provider health is ${status.provider.health.state}.`,
    });
  }
  return {
    schemaVersion: 1,
    product: COMPUTER_PRODUCT_ID,
    ok: checks.every((check) => check.state !== 'fail'),
    status,
    checks,
  };
}

function runProviderUninstaller(scriptPath: string, packageRoot: string, purge: boolean): void {
  const result = spawnSync('/bin/bash', [scriptPath, ...(purge ? ['--purge'] : [])], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`COMPUTER_PROVIDER_UNINSTALL_FAILED: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`COMPUTER_PROVIDER_UNINSTALL_FAILED: provider uninstaller exited ${result.status}: ${String(result.stderr || result.stdout).slice(-4000)}`);
  }
}

export function runComputerUninstall(options: { controllerHome?: string; purge?: boolean } = {}): {
  removed: boolean;
  purged: boolean;
} {
  const controllerHome = resolveControllerHome(options.controllerHome);
  return withOfficialPluginLifecycleLock(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID, () => {
    const registration = getExternalPluginRegistration(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
    const packageRoot = providerPackageRoot(controllerHome);
    if (!registration && !existsSync(packageRoot)) return { removed: false, purged: options.purge === true };
    const scriptPath = join(packageRoot, 'scripts', 'uninstall.sh');
    if (registration && !existsSync(scriptPath)) {
      throw new Error('COMPUTER_PROVIDER_UNINSTALLER_MISSING: refusing to forget a registered provider while its native uninstall lifecycle cannot be proven.');
    }
    if (existsSync(scriptPath)) runProviderUninstaller(scriptPath, packageRoot, options.purge === true);
    if (registration) {
      removeExternalPluginRegistration(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID, { expectedRevision: registration.revision });
    }
    rmSync(packageRoot, { recursive: true, force: true });
    removeControllerPluginManifestProjection(controllerHome, COMPUTER_PROVIDER_PLUGIN_ID);
    return { removed: true, purged: options.purge === true };
  });
}

export function formatComputerStatus(report: ComputerStatusReport): string {
  const lines = [
    `Computer: ${report.ready ? 'ready' : (report.partial ? 'partial' : 'not ready')}`,
    ...report.capabilities.map((capability) => `capability ${capability.capabilityId}: ${capability.state}`),
    `native provider: Forge Desktop Operator ${report.provider.installedVersion ?? 'not installed'}${report.provider.updateAvailable ? ` (pinned ${report.provider.catalogVersion})` : ''}`,
    `native service: ${report.provider.health.state}`,
    `native protocol: ${report.provider.protocolVersion ?? 'n/a'}`,
    'provider release: independent',
  ];
  if (report.provider.health.errors[0]) lines.push(`error: ${report.provider.health.errors[0]}`);
  else if (report.provider.health.warnings[0]) lines.push(`warning: ${report.provider.health.warnings[0]}`);
  if (report.compatibilityReason) lines.push(`compatibility: ${report.compatibilityReason}`);
  return lines.join('\n');
}

export function formatComputerDoctor(report: ComputerDoctorReport): string {
  return [
    formatComputerStatus(report.status),
    '',
    ...report.checks.map((check) => `${check.state.toUpperCase()} ${check.id}: ${check.message}`),
  ].join('\n');
}

export function buildComputerCommand(): Command {
  const root = new Command('computer').description('Manage Forge Computer and its native platform provider');
  root.command('status')
    .description('Show Computer capability and native provider status')
    .option('--json', 'Output JSON')
    .option('--controller-home <path>', 'Override Controller Home')
    .action((options: ComputerCliOptions) => {
      const report = readComputerStatus(options);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatComputerStatus(report));
    });
  root.command('setup')
    .description('Install or repair the pinned native Computer provider')
    .option('--json', 'Output JSON')
    .option('--controller-home <path>', 'Override Controller Home')
    .action((options: ComputerCliOptions) => {
      const result = runComputerSetup(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatComputerStatus(result.status));
    });
  root.command('update')
    .description('Update the native Computer provider to the Forge-pinned release')
    .option('--json', 'Output JSON')
    .option('--controller-home <path>', 'Override Controller Home')
    .action((options: ComputerCliOptions) => {
      const result = runComputerUpdate(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatComputerStatus(result.status));
    });
  root.command('doctor')
    .description('Diagnose Computer provider compatibility, registration, release, and health')
    .option('--json', 'Output JSON')
    .option('--controller-home <path>', 'Override Controller Home')
    .action((options: ComputerCliOptions) => {
      const report = runComputerDoctor(options);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatComputerDoctor(report));
      if (!report.ok) process.exitCode = 1;
    });
  root.command('uninstall')
    .description('Uninstall the native Computer provider while retaining provider state by default')
    .option('--purge', 'Also remove Desktop Operator provider state')
    .option('--json', 'Output JSON')
    .option('--controller-home <path>', 'Override Controller Home')
    .action((options: ComputerCliOptions) => {
      const result = runComputerUninstall(options);
      if (options.json) {
        console.log(JSON.stringify({ schemaVersion: 1, product: COMPUTER_PRODUCT_ID, ...result }, null, 2));
      } else {
        console.log(result.removed
          ? `Computer provider uninstalled${result.purged ? ' and state purged' : ''}.`
          : 'Computer provider is not installed.');
      }
    });
  return root;
}
