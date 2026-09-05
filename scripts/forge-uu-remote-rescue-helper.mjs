#!/usr/bin/env node
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createConnection } from 'net';
import { isAbsolute, join } from 'path';
import { pathToFileURL } from 'url';

export const PLUGIN_ID = 'uu_remote_rescue';
export const PLUGIN_VERSION = '0.1.1';
export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = [
  'uu_remote.device_identity.v1',
  'uu_remote.terminal_transport.v1',
  'forge_wsl.health.v1',
  'forge_wsl.service_recovery.v1',
  'forge_wsl.host_recovery.v1',
];
export const ACTIONS = [
  'device_status', 'wsl_status', 'forge_health',
  'runtime_start', 'runtime_restart', 'connector_start', 'connector_restart',
  'recovery_start', 'recovery_restart', 'runtime_recover',
  'host_tunnel_restart_dispatch', 'host_full_recover_dispatch',
];

const MUTATING_ACTIONS = new Set(['runtime_start', 'runtime_restart', 'connector_start', 'connector_restart', 'recovery_start', 'recovery_restart', 'runtime_recover']);
const HOST_RECOVERY_DISPATCH_ACTIONS = new Map([
  ['host_tunnel_restart_dispatch', 'tunnel_restart'],
  ['host_full_recover_dispatch', 'full_recover'],
]);
const TERMINAL_ACTIONS = new Set(ACTIONS.filter((action) => action !== 'device_status'));
const TERMINAL_WORD = /terminal|powershell|cmd|wsl|shell|终端/i;

function rescueError(code, message, retryable = false, details) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (details) error.details = details;
  return error;
}

function boundedString(value, field, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw rescueError('UU_RESCUE_CONFIG_INVALID', `Invalid ${field}.`);
  }
  return value.trim();
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw rescueError('UU_RESCUE_CONFIG_INVALID', 'UU Remote rescue config schema is invalid.');
  }
  const device = value.device && typeof value.device === 'object' && !Array.isArray(value.device) ? value.device : {};
  const wsl = value.wsl && typeof value.wsl === 'object' && !Array.isArray(value.wsl) ? value.wsl : {};
  const id = boundedString(device.id, 'device.id', 64);
  const name = boundedString(device.name, 'device.name', 128);
  const platform = boundedString(device.platform, 'device.platform', 32).toLowerCase();
  const distro = boundedString(wsl.distro, 'wsl.distro', 128);
  const controllerHome = boundedString(wsl.controllerHome, 'wsl.controllerHome', 1024);
  const uuycCliPath = boundedString(value.uuycCliPath, 'uuycCliPath', 1024);
  const desktopOperatorSocketPath = boundedString(value.desktopOperatorSocketPath, 'desktopOperatorSocketPath', 1024);
  const uuBundleId = boundedString(value.uuBundleId, 'uuBundleId', 128);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw rescueError('UU_RESCUE_CONFIG_INVALID', 'Configured device id is invalid.');
  if (platform !== 'windows') throw rescueError('UU_RESCUE_CONFIG_INVALID', 'Configured rescue target must be Windows.');
  if (!/^[A-Za-z0-9._ -]{1,128}$/.test(distro)) throw rescueError('UU_RESCUE_CONFIG_INVALID', 'Configured WSL distro is invalid.');
  if (!controllerHome.startsWith('/')) throw rescueError('UU_RESCUE_CONFIG_INVALID', 'Configured remote Controller Home must be an absolute WSL path.');
  if (!isAbsolute(uuycCliPath) || !isAbsolute(desktopOperatorSocketPath)) throw rescueError('UU_RESCUE_CONFIG_INVALID', 'Configured local IPC paths must be absolute.');
  return { schemaVersion: 1, device: { id, name, platform }, wsl: { distro, controllerHome }, uuycCliPath, desktopOperatorSocketPath, uuBundleId };
}

export function serviceUnits(controllerHome) {
  const suffix = createHash('sha256').update(controllerHome).digest('hex').slice(0, 12);
  return {
    runtime: `com.moretea.forge.runtime.${suffix}.service`,
    connector: `com.moretea.forge.mcp-gateway.${suffix}.service`,
    recoveryGateway: 'com.moretea.forge-recovery-gateway.service',
    recoveryWatchdog: 'com.moretea.forge-recovery-watchdog.service',
  };
}

function minimalEnv() {
  return Object.fromEntries(Object.entries({
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  }).filter(([, value]) => typeof value === 'string'));
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { throw rescueError(code, 'Provider returned invalid JSON.', true); }
}

function runCliDefault(config, args) {
  if (!existsSync(config.uuycCliPath)) throw rescueError('UU_RESCUE_UUYC_CLI_UNAVAILABLE', 'Configured uuyc-cli is unavailable.');
  const result = spawnSync(config.uuycCliPath, args, { encoding: 'utf8', env: minimalEnv(), timeout: 15_000, maxBuffer: 256 * 1024, shell: false, windowsHide: true });
  if (result.error) throw rescueError('UU_RESCUE_UUYC_CLI_FAILED', result.error.message, true);
  if (result.status !== 0) throw rescueError('UU_RESCUE_UUYC_CLI_FAILED', String(result.stderr || result.stdout || 'uuyc-cli failed').slice(-1000), true);
  const parsed = parseJson(String(result.stdout || '').trim(), 'UU_RESCUE_UUYC_PROTOCOL_INVALID');
  if (parsed?.success !== true) throw rescueError('UU_RESCUE_UUYC_OPERATION_FAILED', 'uuyc-cli reported failure.', true);
  return parsed;
}

async function desktopCallDefault(config, requestId, action, args) {
  const socketPath = config.desktopOperatorSocketPath;
  const envelope = `${JSON.stringify({ id: requestId, method: 'execute', params: { action, arguments: args } })}\n`;
  return await new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(() => reject(rescueError('UU_RESCUE_DESKTOP_TIMEOUT', 'Desktop Operator request timed out.', true))), 12_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      callback();
    };
    try { socket = createConnection({ path: socketPath }); } catch (error) { finish(() => reject(error)); return; }
    socket.once('connect', () => socket.write(envelope));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish(() => reject(rescueError('UU_RESCUE_DESKTOP_RESPONSE_TOO_LARGE', 'Desktop Operator response exceeded the bounded limit.')));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = parseJson(buffer.subarray(0, newline).toString('utf8'), 'UU_RESCUE_DESKTOP_PROTOCOL_INVALID');
        if (response.id !== requestId || typeof response.ok !== 'boolean') throw rescueError('UU_RESCUE_DESKTOP_PROTOCOL_INVALID', 'Desktop Operator returned a mismatched response.');
        if (!response.ok) throw rescueError(response.error?.code || 'UU_RESCUE_DESKTOP_ACTION_FAILED', response.error?.message || 'Desktop Operator action failed.', response.error?.retryable === true);
        finish(() => resolve(response.result && typeof response.result === 'object' ? response.result : {}));
      } catch (error) { finish(() => reject(error)); }
    });
    socket.once('error', (error) => finish(() => reject(rescueError('UU_RESCUE_DESKTOP_UNAVAILABLE', error.message, true))));
  });
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, output));
  return output;
}

function findStringKey(value, keys) {
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value)) {
    for (const key of keys) if (typeof value[key] === 'string') return value[key];
    for (const nested of Object.values(value)) { const found = findStringKey(nested, keys); if (found !== undefined) return found; }
  } else {
    for (const nested of value) { const found = findStringKey(nested, keys); if (found !== undefined) return found; }
  }
  return undefined;
}

function accessibilityWindows(value) {
  const windows = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.role === 'AXWindow') {
      windows.push({
        title: typeof node.title === 'string' ? node.title : '',
        identifier: typeof node.identifier === 'string' ? node.identifier : '',
        focused: node.focused === true,
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return windows;
}

function exactTerminalWindows(observation, config) {
  return accessibilityWindows(observation).filter((window) =>
    window.title.includes(config.device.name) && TERMINAL_WORD.test(window.title));
}

async function ensureTerminalWindowFocused(config, requestId, interactionId, initialObservation, deps) {
  let observation = initialObservation;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const terminals = exactTerminalWindows(observation, config);
    if (terminals.length > 1) {
      throw rescueError('UU_RESCUE_TERMINAL_WINDOW_AMBIGUOUS', 'More than one exact configured-device UU terminal window is visible; refusing remote input.');
    }
    if (terminals.length === 1 && terminals[0].focused) return observation;
    if (attempt === 5) break;
    if (terminals.length === 1) {
      await deps.desktopCall(config, `${requestId}:focus-cycle:${attempt}`, 'desktop_key', { interaction_id: interactionId, keys: ['COMMAND', '`'] });
    }
    await deps.sleep(terminals.length === 0 ? 250 : 150);
    observation = await deps.desktopCall(config, `${requestId}:focus-observe:${attempt}`, 'desktop_observe', { interaction_id: interactionId, max_depth: 8, max_nodes: 1200, include_values: true, include_actions: false, include_windows: true });
  }
  throw rescueError('UU_RESCUE_TERMINAL_FOCUS_UNPROVEN', 'The exact configured-device UU terminal window could not be proven focused; refusing remote input.', true);
}

function markerPair(requestId) {
  const suffix = createHash('sha256').update(requestId).digest('hex').slice(0, 16);
  return { begin: `__FORGE_UU_RESCUE_BEGIN_${suffix}__`, end: `__FORGE_UU_RESCUE_END_${suffix}__` };
}

function extractMarkedText(observation, markers) {
  const candidates = [...collectStrings(observation), collectStrings(observation).join('\n')];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const text = candidates[index];
    const start = text.lastIndexOf(markers.begin);
    if (start < 0) continue;
    const end = text.indexOf(markers.end, start + markers.begin.length);
    if (end < 0) continue;
    return text.slice(start + markers.begin.length, end).trim();
  }
  return undefined;
}

function b64(value) { return Buffer.from(String(value), 'utf8').toString('base64'); }
function decodeB64(value) { try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return ''; } }

export function buildWslStatusCommand(markers) {
  return `$ErrorActionPreference='Continue'; $d=@(wsl.exe --list --quiet 2>$null | ForEach-Object { ($_ -replace [char]0,'').Trim() } | Where-Object { $_ }); $s=(wsl.exe --status 2>&1 | Out-String).Trim(); Write-Output '${markers.begin}'; foreach($x in $d){ Write-Output ('distro_b64|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x))) }; Write-Output ('status_b64|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))); Write-Output '${markers.end}'`;
}

export function buildHostRecoveryDispatchCommand(action) {
  const recoveryAction = HOST_RECOVERY_DISPATCH_ACTIONS.get(action);
  if (!recoveryAction) throw rescueError('UU_RESCUE_ACTION_UNSUPPORTED', 'Unsupported fixed host Recovery dispatch action.');
  const recoveryScript = String.raw`C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1`;
  const powershellSuffix = String.raw`System32\WindowsPowerShell\v1.0\powershell.exe`;
  return `$recoveryScript='${recoveryScript}'; $powershell=Join-Path $env:SystemRoot '${powershellSuffix}'; if (-not (Test-Path -LiteralPath $recoveryScript -PathType Leaf)) { throw 'FORGE_RECOVERY_SCRIPT_MISSING' }; if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw 'WINDOWS_POWERSHELL_MISSING' }; Start-Process -WindowStyle Hidden -FilePath $powershell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$recoveryScript,'${recoveryAction}')`;
}

export function buildForgeCommand(action, config, markers) {
  const units = serviceUnits(config.wsl.controllerHome);
  const operation = {
    forge_health: '',
    runtime_start: `systemctl --user start '${units.runtime}'; emit action_exit "$?"`,
    runtime_restart: `systemctl --user restart '${units.runtime}'; emit action_exit "$?"`,
    connector_start: `systemctl --user start '${units.connector}'; emit action_exit "$?"`,
    connector_restart: `systemctl --user restart '${units.connector}'; emit action_exit "$?"`,
    recovery_start: `systemctl --user start '${units.recoveryGateway}' '${units.recoveryWatchdog}'; emit action_exit "$?"`,
    recovery_restart: `systemctl --user restart '${units.recoveryGateway}' '${units.recoveryWatchdog}'; emit action_exit "$?"`,
    runtime_recover: `if command -v forge >/dev/null 2>&1; then recovery_out="$(forge recovery recover --controller-home "$CH" 2>&1)"; recovery_code="$?"; emit recovery_output_b64 "$(printf %s "$recovery_out" | base64 | tr -d '\\n')"; emit action_exit "$recovery_code"; else emit recovery_output_b64 "$(printf %s 'forge CLI unavailable' | base64 | tr -d '\\n')"; emit action_exit 127; fi`,
  }[action];
  if (operation === undefined) throw rescueError('UU_RESCUE_ACTION_UNSUPPORTED', 'Unsupported fixed Forge rescue action.');
  const script = `set +e\nCH="$(printf %s '${b64(config.wsl.controllerHome)}' | base64 -d)"\nemit(){ printf '%s|%s\\n' "$1" "$2"; }\nstatus(){ unit="$2"; load="$(systemctl --user show "$unit" -p LoadState --value 2>/dev/null)"; active="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)"; sub="$(systemctl --user show "$unit" -p SubState --value 2>/dev/null)"; pid="$(systemctl --user show "$unit" -p MainPID --value 2>/dev/null)"; printf 'service|%s|%s|%s|%s|%s\\n' "$1" "\${load:-unknown}" "\${active:-unknown}" "\${sub:-unknown}" "\${pid:-0}"; }\nprintf '%s\\n' '${markers.begin}'\nemit distro_b64 "$(printf %s "\${WSL_DISTRO_NAME:-}" | base64 | tr -d '\\n')"\nemit controller_home_present "$([ -d "$CH" ] && echo 1 || echo 0)"\nemit control_plane_present "$([ -f "$CH/control-plane.sqlite" ] && echo 1 || echo 0)"\nemit runtime_owner_present "$([ -f "$CH/runtime/active-runtime-owner.json" ] && echo 1 || echo 0)"\nemit runtime_status_present "$([ -f "$CH/runtime/status.json" ] && echo 1 || echo 0)"\nemit connector_authority_present "$([ -f "$CH/runtime/connector-service/authority.json" ] && echo 1 || echo 0)"\nemit recovery_config_present "$([ -d "$CH/recovery/config" ] && echo 1 || echo 0)"\nif command -v sqlite3 >/dev/null 2>&1 && [ -f "$CH/control-plane.sqlite" ]; then migration="$(sqlite3 -json "$CH/control-plane.sqlite" \"select json_extract(payload,'$.status') as status,json_extract(payload,'$.sourceHome') as sourceHome,json_extract(payload,'$.destinationHome') as destinationHome,updated_at as updatedAt from control_plane_records where namespace='controller_home_migration' order by updated_at desc limit 1;\" 2>/dev/null)"; emit migration_json_b64 "$(printf %s "$migration" | base64 | tr -d '\\n')"; else emit migration_unavailable_b64 "$(printf %s 'sqlite3 unavailable or control-plane missing' | base64 | tr -d '\\n')"; fi\n${operation}\nstatus runtime '${units.runtime}'\nstatus connector '${units.connector}'\nstatus recoveryGateway '${units.recoveryGateway}'\nstatus recoveryWatchdog '${units.recoveryWatchdog}'\nprintf '%s\\n' '${markers.end}'`;
  const payload = b64(script);
  const distro = config.wsl.distro.replaceAll("'", "''");
  return `wsl.exe -d '${distro}' -- bash -lc "printf %s '${payload}' | base64 -d | bash"`;
}

export function parseRecords(text) {
  const result = { services: {} };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts[0] === 'service' && parts.length >= 6) {
      result.services[parts[1]] = { unitLoadState: parts[2], activeState: parts[3], subState: parts[4], mainPid: Number(parts[5]) || 0 };
      continue;
    }
    const key = parts.shift();
    const value = parts.join('|');
    if (!key) continue;
    if (key.endsWith('_b64')) result[key.slice(0, -4)] = decodeB64(value);
    else if (key === 'action_exit') result.actionExit = Number(value);
    else if (['controller_home_present', 'control_plane_present', 'runtime_owner_present', 'runtime_status_present', 'connector_authority_present', 'recovery_config_present'].includes(key)) result[key] = value === '1';
    else result[key] = value;
  }
  if (typeof result.migration_json === 'string' && result.migration_json.trim()) {
    try { result.migration = JSON.parse(result.migration_json); } catch { result.migration = { parseError: true }; }
    delete result.migration_json;
  }
  return result;
}

async function verifyDevice(config, deps, requireOnline) {
  const response = await deps.runCli(config, ['device', 'info', config.device.id]);
  const data = response?.data || {};
  const item = data.matchedItem || {};
  if (data.isUniqueMatch !== true || item.deviceId !== config.device.id || item.deviceName !== config.device.name || String(item.platform || '').toLowerCase() !== 'windows') {
    throw rescueError('UU_RESCUE_DEVICE_MISMATCH', 'UU Remote device identity did not match the registration-bound Windows target.');
  }
  if (requireOnline && item.isOnline !== true) throw rescueError('UU_RESCUE_DEVICE_OFFLINE', 'The registration-bound UU Remote device is offline.', true);
  return { deviceId: item.deviceId, deviceName: item.deviceName, platform: 'windows', isOnline: item.isOnline === true };
}

async function runTerminalCommand(config, requestId, command, deps, options = {}) {
  await verifyDevice(config, deps, true);
  await deps.runCli(config, ['term', 'open', config.device.id]);
  await deps.sleep(700);
  let interactionId;
  let originalClipboard;
  let clipboardCaptured = false;
  try {
    const opened = await deps.desktopCall(config, `${requestId}:session`, 'desktop_session_open', { bundle_id: config.uuBundleId, launch: false, activate: true });
    interactionId = findStringKey(opened, ['interaction_id', 'interactionId']);
    if (!interactionId) throw rescueError('UU_RESCUE_TERMINAL_SESSION_UNBOUND', 'Desktop Operator did not return a bound UURemote interaction session.');
    const observed = await deps.desktopCall(config, `${requestId}:preflight`, 'desktop_observe', { interaction_id: interactionId, max_depth: 8, max_nodes: 1200, include_values: true, include_actions: false, include_windows: true });
    await ensureTerminalWindowFocused(config, requestId, interactionId, observed, deps);
    const clipboard = await deps.desktopCall(config, `${requestId}:clipboard-read`, 'desktop_clipboard_read', {});
    originalClipboard = findStringKey(clipboard, ['text', 'value']) ?? '';
    clipboardCaptured = true;
    await deps.desktopCall(config, `${requestId}:clipboard-command`, 'desktop_clipboard_write', { text: command });
    await deps.desktopCall(config, `${requestId}:paste`, 'desktop_paste', { interaction_id: interactionId });
    await deps.desktopCall(config, `${requestId}:return`, 'desktop_key', { interaction_id: interactionId, keys: ['RETURN'] });
    if (options.awaitResult === false) {
      await deps.sleep(300);
      return undefined;
    }
    const markers = markerPair(requestId);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await deps.sleep(attempt === 0 ? 300 : 250);
      const next = await deps.desktopCall(config, `${requestId}:observe:${attempt}`, 'desktop_observe', { interaction_id: interactionId, max_depth: 10, max_nodes: 2500, include_values: true, include_actions: false, include_windows: false });
      const payload = extractMarkedText(next, markers);
      if (payload !== undefined) return payload;
    }
    throw rescueError('UU_RESCUE_REMOTE_RESULT_TIMEOUT', 'The fixed UU Remote terminal command did not produce its bounded result marker.', true);
  } finally {
    if (clipboardCaptured) {
      try { await deps.desktopCall(config, `${requestId}:clipboard-restore`, 'desktop_clipboard_write', { text: originalClipboard }); } catch { /* never expose prior clipboard */ }
    }
    if (interactionId) {
      try { await deps.desktopCall(config, `${requestId}:session-close`, 'desktop_session_close', { interaction_id: interactionId }); } catch { /* best effort */ }
    }
    try { await deps.runCli(config, ['term', 'exit', config.device.id, '--clear']); } catch { /* best effort */ }
  }
}

export async function executeAction(actionId, input, configInput, injected = {}) {
  const config = validateConfig(configInput);
  if (!ACTIONS.includes(actionId)) throw rescueError('UU_RESCUE_ACTION_UNSUPPORTED', 'Unsupported UU Remote rescue action.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) throw rescueError('UU_RESCUE_ARGUMENTS_FORBIDDEN', 'UU Remote rescue actions do not accept caller-provided commands, service names, devices, paths, or shell arguments.');
  const deps = { runCli: runCliDefault, desktopCall: desktopCallDefault, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ...injected };
  if (actionId === 'device_status') return { device: await verifyDevice(config, deps, false) };
  const effectiveRequestId = injected.requestId || `${actionId}:${Date.now()}`;
  if (HOST_RECOVERY_DISPATCH_ACTIONS.has(actionId)) {
    const command = buildHostRecoveryDispatchCommand(actionId);
    await runTerminalCommand(config, effectiveRequestId, command, deps, { awaitResult: false });
    return {
      device: config.device,
      wsl: { configuredDistro: config.wsl.distro },
      dispatch: {
        accepted: true,
        action: HOST_RECOVERY_DISPATCH_ACTIONS.get(actionId),
        authority: 'C:\\ProgramData\\ForgeRecovery\\ForgeRecovery.ps1',
        recoveryStatus: 'unverified',
        verificationRequired: 'Forge Cloud connectivity',
      },
    };
  }
  const markers = markerPair(effectiveRequestId);
  const command = actionId === 'wsl_status' ? buildWslStatusCommand(markers) : buildForgeCommand(actionId, config, markers);
  const payload = await runTerminalCommand(config, effectiveRequestId, command, deps);
  if (actionId === 'wsl_status') {
    const records = parseRecords(payload);
    const distros = payload.split(/\r?\n/).filter((line) => line.startsWith('distro_b64|')).map((line) => decodeB64(line.slice('distro_b64|'.length))).filter(Boolean);
    return { device: config.device, configuredDistro: config.wsl.distro, distros, status: records.status || '' };
  }
  const result = parseRecords(payload);
  result.device = config.device;
  result.wsl = { configuredDistro: config.wsl.distro, observedDistro: result.distro || '' };
  result.controllerHome = config.wsl.controllerHome;
  result.units = serviceUnits(config.wsl.controllerHome);
  if (MUTATING_ACTIONS.has(actionId) && result.actionExit !== 0) throw rescueError('UU_RESCUE_REMOTE_ACTION_FAILED', `Fixed remote action ${actionId} exited with code ${String(result.actionExit ?? 'unknown')}.`, false, { actionId, actionExit: result.actionExit });
  return result;
}

function loadConfig() {
  const path = join(process.cwd(), 'config.json');
  if (!existsSync(path)) throw rescueError('UU_RESCUE_CONFIG_MISSING', 'UU Remote rescue config is missing.');
  return validateConfig(parseJson(readFileSync(path, 'utf8'), 'UU_RESCUE_CONFIG_INVALID'));
}

async function providerAction(request) {
  const config = loadConfig();
  if (request.actionId === 'manifest') return { id: PLUGIN_ID, name: 'Forge UU Remote Rescue', version: PLUGIN_VERSION, protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-macos', capabilities: CAPABILITIES, actions: ACTIONS };
  if (request.actionId === 'health') {
    const system = runCliDefault(config, ['status']);
    let device;
    try { device = await verifyDevice(config, { runCli: runCliDefault }, false); } catch (error) { return { state: 'degraded', warnings: [error.code || 'UU_RESCUE_DEVICE_UNAVAILABLE'], xpcServiceStatus: system?.data?.xpcServiceStatus, networkStatus: system?.data?.networkStatus }; }
    const ready = system?.data?.xpcServiceStatus === 'running' && system?.data?.isLoggedIn === true && device.isOnline;
    return { state: ready ? 'ready' : 'degraded', warnings: ready ? [] : ['Configured UU Remote target is not currently ready for rescue.'], device, xpcServiceStatus: system?.data?.xpcServiceStatus, networkStatus: system?.data?.networkStatus };
  }
  return await executeAction(request.actionId, request.input, config, { requestId: request.requestId });
}

export async function runManagedHelper() {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'handshake', protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID, helperVersion: PLUGIN_VERSION, capabilities: CAPABILITIES })}\n`);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const line = raw.split(/\r?\n/).find((entry) => entry.trim());
  if (!line) throw rescueError('UU_RESCUE_REQUEST_MISSING', 'Managed plugin request is missing.');
  const request = parseJson(line, 'UU_RESCUE_REQUEST_INVALID');
  if (request.schemaVersion !== 1 || request.type !== 'execute' || typeof request.requestId !== 'string' || typeof request.actionId !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw rescueError('UU_RESCUE_REQUEST_INVALID', 'Managed plugin request envelope is invalid.');
  }
  try {
    const result = await providerAction(request);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: false, error: { code: error?.code || 'UU_RESCUE_FAILED', message: String(error?.message || 'UU Remote rescue failed.').replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]').slice(0, 1000), retryable: error?.retryable === true, ...(error?.details ? { details: error.details } : {}) } })}\n`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runManagedHelper().catch((error) => {
    process.stderr.write(`UU_RESCUE_HELPER_FATAL: ${String(error?.message || error).replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]').slice(0, 1000)}\n`);
    process.exitCode = 1;
  });
}
