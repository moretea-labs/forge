import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { createDesktopOperatorRegistrationInput } from './desktop-operator-registration';
import {
  getExternalPluginRegistration,
  installExternalPluginRegistration,
  type ExternalPluginRegistration,
  type ExternalPluginUnixSocketTransport,
} from './external-registration';

function isForgeDesktopOperatorBinding(
  registration: ExternalPluginRegistration,
): registration is ExternalPluginRegistration & { transport: ExternalPluginUnixSocketTransport } {
  return registration.pluginId === 'desktop_operator'
    && registration.providerPluginId === 'desktop_operator'
    && registration.provider === 'local-macos'
    && registration.scope === 'controller'
    && registration.transport.kind === 'unix_socket_jsonl';
}

const DESKTOP_OPERATOR_BUNDLE_ID = 'com.moretea.forge.desktop-operator';
const DESKTOP_OPERATOR_APP_NAME = 'Forge Desktop Operator.app';

interface DesktopOperatorInstallReceipt {
  schemaVersion: 1;
  pluginId: string;
  pluginVersion: string;
  protocolVersion: string;
  socketPath: string;
  executablePath: string;
  manifestPath: string;
  serviceManager: string;
  bundleIdentifier: string;
  launchAgentLabel: string;
  expectedProgramContains: string;
}

interface DesktopOperatorInstalledManifest {
  id?: unknown;
  version?: unknown;
  protocolVersion?: unknown;
}

export interface FirstPartyExternalRegistrationReconcileOptions {
  /** Test/repair seams only. Production uses the stable provider-owned installation paths. */
  desktopOperatorInstallReceiptPath?: string;
  desktopOperatorCanonicalSocketPath?: string;
  desktopOperatorCanonicalExecutablePath?: string;
}

function canonicalDesktopOperatorSocketPath(): string {
  return join(homedir(), 'Library', 'Caches', 'Forge', 'desktop-operator.sock');
}

function canonicalDesktopOperatorExecutablePath(): string {
  return join(homedir(), 'Applications', DESKTOP_OPERATOR_APP_NAME, 'Contents', 'MacOS', 'desktop-operator');
}

function defaultDesktopOperatorInstallReceiptPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Forge', 'DesktopOperator', 'registration', 'registration.json');
}

function parseJsonObject(path: string, code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function installedDesktopOperatorReleaseIdentity(
  existing: ExternalPluginRegistration & { transport: ExternalPluginUnixSocketTransport },
  options: FirstPartyExternalRegistrationReconcileOptions,
): { pluginVersion: string; protocolVersion: string } | undefined {
  const lifecycle = existing.lifecycle?.kind === 'verified_user_launch_agent' ? existing.lifecycle : undefined;
  if (!lifecycle) return undefined;

  const expectedSocketPath = options.desktopOperatorCanonicalSocketPath?.trim() || canonicalDesktopOperatorSocketPath();
  const expectedExecutablePath = options.desktopOperatorCanonicalExecutablePath?.trim() || canonicalDesktopOperatorExecutablePath();
  // Only the stable first-party installation may contribute release metadata.
  // Synthetic/custom registrations keep their existing version authority.
  if (!isAbsolute(expectedSocketPath)
    || !isAbsolute(expectedExecutablePath)
    || resolve(existing.transport.socketPath) !== resolve(expectedSocketPath)
    || lifecycle.label !== DESKTOP_OPERATOR_BUNDLE_ID
    || !isAbsolute(lifecycle.expectedProgramContains)
    || resolve(lifecycle.expectedProgramContains) !== resolve(expectedExecutablePath)) return undefined;

  const receiptPath = resolve(options.desktopOperatorInstallReceiptPath?.trim() || defaultDesktopOperatorInstallReceiptPath());
  if (!existsSync(receiptPath)) return undefined;
  const raw = parseJsonObject(receiptPath, 'DESKTOP_OPERATOR_INSTALL_RECEIPT_INVALID');
  const receipt = raw as unknown as DesktopOperatorInstallReceipt;

  // The receipt is evidence for installed release metadata only. It may never
  // replace the already-trusted endpoint or lifecycle identity.
  if (receipt.schemaVersion !== 1
    || receipt.pluginId !== 'desktop_operator'
    || typeof receipt.pluginVersion !== 'string' || !receipt.pluginVersion.trim()
    || typeof receipt.protocolVersion !== 'string' || !receipt.protocolVersion.trim()
    || typeof receipt.socketPath !== 'string'
    || resolve(receipt.socketPath) !== resolve(existing.transport.socketPath)
    || receipt.bundleIdentifier !== DESKTOP_OPERATOR_BUNDLE_ID
    || receipt.launchAgentLabel !== lifecycle.label
    || typeof receipt.expectedProgramContains !== 'string' || !receipt.expectedProgramContains.trim()
    || receipt.serviceManager !== 'launchd-user-agent'
    || typeof receipt.executablePath !== 'string'
    || !isAbsolute(receipt.executablePath)
    || resolve(receipt.executablePath) !== resolve(lifecycle.expectedProgramContains)
    || !receipt.executablePath.includes(receipt.expectedProgramContains)
    || !receipt.executablePath.endsWith(`/${DESKTOP_OPERATOR_APP_NAME}/Contents/MacOS/desktop-operator`)
    || typeof receipt.manifestPath !== 'string'
    || resolve(receipt.manifestPath) !== resolve(join(dirname(receiptPath), 'forge-plugin.json'))) {
    throw new Error('DESKTOP_OPERATOR_INSTALL_RECEIPT_IDENTITY_MISMATCH');
  }

  const manifest = parseJsonObject(receipt.manifestPath, 'DESKTOP_OPERATOR_INSTALLED_MANIFEST_INVALID') as DesktopOperatorInstalledManifest;
  if (manifest.id !== 'desktop_operator'
    || manifest.version !== receipt.pluginVersion
    || manifest.protocolVersion !== receipt.protocolVersion) {
    throw new Error('DESKTOP_OPERATOR_INSTALLED_MANIFEST_IDENTITY_MISMATCH');
  }
  return { pluginVersion: receipt.pluginVersion, protocolVersion: receipt.protocolVersion };
}

/**
 * Reconcile one installed first-party external provider to the current Forge-owned
 * policy contract while preserving installation/runtime identity. The external
 * registration store remains the only persistence, fingerprint and revision
 * authority; this layer only materializes desired state from current source.
 */
export function reconcileFirstPartyExternalPluginRegistration(
  controllerHome: string,
  pluginId: string,
  options: FirstPartyExternalRegistrationReconcileOptions = {},
): ExternalPluginRegistration | undefined {
  const existing = getExternalPluginRegistration(controllerHome, pluginId);
  if (!existing) return undefined;
  if (pluginId !== 'desktop_operator' || !isForgeDesktopOperatorBinding(existing)) return existing;

  const lifecycle = existing.lifecycle?.kind === 'verified_user_launch_agent'
    ? existing.lifecycle
    : undefined;
  const installedRelease = installedDesktopOperatorReleaseIdentity(existing, options);
  const desired = createDesktopOperatorRegistrationInput({
    socketPath: existing.transport.socketPath,
    launchAgentLabel: lifecycle?.label,
    expectedProgramContains: lifecycle?.expectedProgramContains,
    pluginVersion: installedRelease?.pluginVersion ?? existing.pluginVersion,
    protocolVersion: installedRelease?.protocolVersion ?? existing.protocolVersion,
    enabled: existing.enabled,
  });
  return installExternalPluginRegistration(controllerHome, desired);
}

/** Reconcile every currently installed first-party external provider. */
export function reconcileFirstPartyExternalPluginRegistrations(controllerHome: string): ExternalPluginRegistration[] {
  const desktop = reconcileFirstPartyExternalPluginRegistration(controllerHome, 'desktop_operator');
  return desktop ? [desktop] : [];
}
