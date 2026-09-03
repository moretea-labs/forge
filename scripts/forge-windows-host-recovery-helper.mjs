#!/usr/bin/env node
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

export const PLUGIN_ID = 'windows_host_recovery';
export const PLUGIN_VERSION = '0.1.4';
export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = [
  'windows_host.identity.v1',
  'windows_host.recovery_task.v1',
  'forge_wsl.host_recovery.v1',
];
export const ACTIONS = [
  'host_status', 'task_status', 'task_install', 'task_run',
  'wsl_status', 'wsl_start',
  'forge_source_status', 'controller_status',
  'runtime_status', 'runtime_start', 'runtime_restart',
  'connector_status', 'connector_start', 'connector_restart',
  'recovery_status', 'recovery_start', 'recovery_restart',
  'tunnel_status', 'tunnel_start', 'tunnel_restart',
  'forge_cloud_verify', 'full_recover',
];

const READONLY_ACTIONS = new Set([
  'host_status', 'task_status', 'wsl_status', 'forge_source_status', 'controller_status',
  'runtime_status', 'connector_status', 'recovery_status', 'tunnel_status', 'forge_cloud_verify',
]);

function providerError(code, message, retryable = false, details) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (details) error.details = details;
  return error;
}

function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) {
    throw providerError('WINDOWS_RECOVERY_CONFIG_INVALID', 'Windows host recovery config schema is invalid.');
  }
  const expectedScriptSha256 = typeof raw.expectedScriptSha256 === 'string' ? raw.expectedScriptSha256.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expectedScriptSha256)) {
    throw providerError('WINDOWS_RECOVERY_CONFIG_INVALID', 'Expected Recovery script digest is invalid.');
  }
  const deployment = raw.deployment;
  const required = ['recoveryScriptHostPath', 'recoveryScriptWindowsPath', 'powershellHostPath', 'powershellWindowsPath', 'rescueRoot'];
  if (!deployment || deployment.schemaVersion !== 1 || required.some((key) => typeof deployment[key] !== 'string' || !deployment[key].trim())) {
    throw providerError('WINDOWS_RECOVERY_DEPLOYMENT_BINDING_INVALID', 'Windows host Recovery deployment binding is missing or invalid.');
  }
  return { schemaVersion: 1, expectedScriptSha256, deployment };

}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertTrustedAssets(config) {
  const { powershellHostPath, recoveryScriptHostPath } = config.deployment;
  if (!existsSync(powershellHostPath)) throw providerError('WINDOWS_RECOVERY_POWERSHELL_MISSING', 'Bound Windows PowerShell executable is unavailable.');
  if (!existsSync(recoveryScriptHostPath)) throw providerError('WINDOWS_RECOVERY_SCRIPT_MISSING', 'Bound ForgeRecovery.ps1 is unavailable.');
  const actual = sha256(recoveryScriptHostPath);
  if (actual !== config.expectedScriptSha256) {
    throw providerError('WINDOWS_RECOVERY_SCRIPT_IDENTITY_MISMATCH', 'Installed ForgeRecovery.ps1 does not match the registered immutable identity.', false, { expected: config.expectedScriptSha256, actual });
  }
  return actual;
}

function minimalEnv() {
  return Object.fromEntries(Object.entries({
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
  }).filter(([, value]) => typeof value === 'string'));
}

export function executeAction(actionId, input, configInput) {
  if (!ACTIONS.includes(actionId)) throw providerError('WINDOWS_RECOVERY_ACTION_UNSUPPORTED', 'Unsupported fixed Windows host recovery action.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
    throw providerError('WINDOWS_RECOVERY_ARGUMENTS_FORBIDDEN', 'Windows host recovery actions accept no caller-provided commands, paths, task names, service names, or shell arguments.');
  }
  const config = parseConfig(configInput);
  const scriptSha256 = assertTrustedAssets(config);
  const result = spawnSync(config.deployment.powershellHostPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', config.deployment.recoveryScriptWindowsPath, actionId,
  ], {
    encoding: 'utf8', env: minimalEnv(), timeout: actionId === 'full_recover' ? 120_000 : 30_000,
    maxBuffer: 256 * 1024, shell: false, windowsHide: true,
  });
  if (result.error) throw providerError('WINDOWS_RECOVERY_EXECUTION_FAILED', result.error.message, true);
  if (result.status !== 0) {
    throw providerError('WINDOWS_RECOVERY_ACTION_FAILED', String(result.stderr || result.stdout || 'fixed Windows recovery action failed').slice(-2000), false, { actionId, exitCode: result.status });
  }
  return {
    actionId,
    readonly: READONLY_ACTIONS.has(actionId),
    scriptSha256,
    output: String(result.stdout || '').trim().slice(0, 32 * 1024),
  };
}

function loadConfig() {
  const path = new URL('./config.json', pathToFileURL(`${process.cwd()}/`).href);
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export async function handleRequest(request, config = loadConfig()) {
  if (request.actionId === 'manifest') {
    return { id: PLUGIN_ID, name: 'Forge Windows Host Recovery', version: PLUGIN_VERSION, protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-wsl-windows', capabilities: CAPABILITIES, actions: ACTIONS };
  }
  if (request.actionId === 'health') {
    const scriptSha256 = assertTrustedAssets(config);
    return { state: 'ready', powershellPath: config.deployment.powershellHostPath, recoveryScriptPath: config.deployment.recoveryScriptHostPath, deployment: config.deployment, scriptSha256, warnings: [] };
  }
  return executeAction(request.actionId, request.input, config);
}

async function main() {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'handshake', protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID, helperVersion: PLUGIN_VERSION, capabilities: CAPABILITIES })}\n`);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let request;
  try { request = JSON.parse(raw); } catch { throw providerError('WINDOWS_RECOVERY_PROTOCOL_INVALID', 'Request JSON is invalid.'); }
  if (request.schemaVersion !== 1 || request.type !== 'execute' || typeof request.requestId !== 'string' || typeof request.actionId !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw providerError('WINDOWS_RECOVERY_PROTOCOL_INVALID', 'Request envelope is invalid.');
  }
  try {
    const result = await handleRequest(request);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: false, error: { code: error?.code || 'WINDOWS_RECOVERY_FAILED', message: String(error?.message || 'Windows host recovery failed.').slice(0, 2000), retryable: error?.retryable === true, ...(error?.details ? { details: error.details } : {}) } })}\n`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((error) => { process.stderr.write(`${String(error?.stack || error)}\n`); process.exitCode = 1; });
