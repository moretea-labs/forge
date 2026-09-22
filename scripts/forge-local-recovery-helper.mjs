#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { resolveControllerHome } from '../src/cli/repositories/controller-home.ts';
import { findRegisteredRepositoryByCheckoutRoot } from '../src/cli/repositories/registry.ts';
import { createRecoveryConfig, gatewayToken, loadRecoveryConfig } from '../src/runtime/standalone-recovery/core.ts';

export const PLUGIN_ID = 'local_recovery';
export const PLUGIN_VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = ['forge.local_recovery.transport.v1'];
export const ACTIONS = [
  'runtime_status',
  'list_releases',
  'verify_stable_runtime',
  'stage_and_activate_runtime_release',
  'release_session_status',
  'advance_runtime_release_session',
  'verify_runtime_release_session_static',
  'verify_runtime_release_session_candidate',
  'cutover_runtime_release_session',
  'cancel_runtime_release_session',
  'rollback_runtime_release_session',
  'promote_runtime_release_session_known_good',
];
const RELEASE_SESSION_ACTIONS = new Set([
  'release_session_status',
  'verify_runtime_release_session_static',
  'verify_runtime_release_session_candidate',
  'cutover_runtime_release_session',
  'cancel_runtime_release_session',
  'rollback_runtime_release_session',
  'promote_runtime_release_session_known_good',
]);
const MUTATING_ACTIONS = new Set([
  'stage_and_activate_runtime_release',
  'advance_runtime_release_session',
  'verify_runtime_release_session_static',
  'verify_runtime_release_session_candidate',
  'cutover_runtime_release_session',
  'cancel_runtime_release_session',
  'rollback_runtime_release_session',
  'promote_runtime_release_session_known_good',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function providerError(code, message, retryable = false, details) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (details) error.details = details;
  return error;
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { throw providerError(code, 'Local Recovery provider JSON is invalid.'); }
}

export function validateProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerError('LOCAL_RECOVERY_CONFIG_INVALID', 'Local Recovery provider config must be an object.');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'controllerHome')) throw providerError('LOCAL_RECOVERY_CONFIG_INVALID', 'Local Recovery provider config accepts only controllerHome.');
  if (typeof value.controllerHome !== 'string' || !value.controllerHome.trim() || !isAbsolute(value.controllerHome.trim())) {
    throw providerError('LOCAL_RECOVERY_CONTROLLER_HOME_REQUIRED', 'Local Recovery provider requires one absolute controllerHome.');
  }
  return { controllerHome: resolve(value.controllerHome.trim()) };
}

export function loadProviderConfig() {
  const path = join(process.cwd(), 'config.json');
  if (!existsSync(path)) return { controllerHome: resolveControllerHome() };
  return validateProviderConfig(parseJson(readFileSync(path, 'utf8'), 'LOCAL_RECOVERY_CONFIG_INVALID'));
}

function recoveryEndpoint(config) {
  const gateway = config.gateway;
  if (!gateway || typeof gateway.host !== 'string' || !LOOPBACK_HOSTS.has(gateway.host) || !Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535) {
    throw providerError('LOCAL_RECOVERY_GATEWAY_INVALID', 'Installed Recovery Gateway must use one configured loopback endpoint.');
  }
  const host = gateway.host === '::1' ? '[::1]' : gateway.host;
  return `http://${host}:${gateway.port}/recovery/mcp`;
}

function rpcPayload(text, contentType = '') {
  if (/text\/event-stream/i.test(contentType)) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!data) throw providerError('LOCAL_RECOVERY_MCP_RESPONSE_INVALID', 'Recovery MCP SSE response did not contain data.');
    return parseJson(data.slice(6), 'LOCAL_RECOVERY_MCP_RESPONSE_INVALID');
  }
  return parseJson(text || '{}', 'LOCAL_RECOVERY_MCP_RESPONSE_INVALID');
}

async function postRpc(fetchImpl, endpoint, token, body, sessionId) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw providerError('LOCAL_RECOVERY_MCP_HTTP_FAILED', `Recovery MCP returned HTTP ${response.status}.`, true, { status: response.status });
  return { response, payload: text ? rpcPayload(text, response.headers.get('content-type') ?? '') : undefined };
}

export async function callRecoveryTool(controllerHome, toolName, args = {}, injected = {}) {
  const loadConfig = injected.loadRecoveryConfig ?? loadRecoveryConfig;
  const readToken = injected.gatewayToken ?? gatewayToken;
  const fetchImpl = injected.fetch ?? fetch;
  const config = loadConfig(controllerHome);
  if (resolve(config.controllerHome) !== resolve(controllerHome)) throw providerError('LOCAL_RECOVERY_CONTROLLER_HOME_MISMATCH', 'Installed Recovery config belongs to a different Controller Home.');
  const endpoint = recoveryEndpoint(config);
  const token = readToken(config);
  if (!token) throw providerError('LOCAL_RECOVERY_GATEWAY_TOKEN_UNAVAILABLE', 'Installed Recovery Gateway token is unavailable or expired.');
  const initialized = await postRpc(fetchImpl, endpoint, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'forge-local-recovery-provider', version: PLUGIN_VERSION },
    },
  });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  if (!sessionId) throw providerError('LOCAL_RECOVERY_MCP_SESSION_MISSING', 'Recovery MCP initialize did not return a session id.');
  try {
    await postRpc(fetchImpl, endpoint, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    const called = await postRpc(fetchImpl, endpoint, token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args },
    }, sessionId);
    if (called.payload?.error) throw providerError('LOCAL_RECOVERY_TOOL_FAILED', String(called.payload.error?.message ?? 'Recovery tool failed.'), false);
    const content = called.payload?.result?.content;
    const text = Array.isArray(content) ? content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text : undefined;
    if (text) return parseJson(text, 'LOCAL_RECOVERY_TOOL_RESULT_INVALID');
    return called.payload?.result ?? {};
  } finally {
    try {
      await fetchImpl(endpoint, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
      });
    } catch { /* Session cleanup is best effort; ReleaseSession durability is independent from this transport session. */ }
  }
}

function assertEmptyInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
    throw providerError('LOCAL_RECOVERY_ARGUMENTS_FORBIDDEN', 'Local Recovery actions accept no caller endpoint, path, command, token, release, source, or tunnel arguments.');
  }
}

function releaseSessionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.session_id !== 'string') {
    throw providerError('LOCAL_RECOVERY_RELEASE_SESSION_ARGUMENTS_INVALID', 'ReleaseSession actions accept only session_id.');
  }
  const sessionId = input.session_id.trim();
  if (sessionId.length < 8 || sessionId.length > 120) {
    throw providerError('LOCAL_RECOVERY_RELEASE_SESSION_ID_INVALID', 'ReleaseSession session_id must be 8 to 120 characters.');
  }
  return { session_id: sessionId };
}

function mutationRequestId(requestId) {
  return `local-recovery:${createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)}`;
}

export function ensureSourceRepositoryProvenance(controllerHome, injected = {}) {
  const loadConfig = injected.loadRecoveryConfig ?? loadRecoveryConfig;
  const persistConfig = injected.createRecoveryConfig ?? createRecoveryConfig;
  const findRepository = injected.findRegisteredRepositoryByCheckoutRoot ?? findRegisteredRepositoryByCheckoutRoot;
  const recoveryConfig = loadConfig(controllerHome);
  if (typeof recoveryConfig.primaryRuntimeSourceRepositoryId === 'string' && recoveryConfig.primaryRuntimeSourceRepositoryId.trim()) return recoveryConfig;
  const sourceRoot = typeof recoveryConfig.primaryRuntimeSourceRoot === 'string' ? recoveryConfig.primaryRuntimeSourceRoot.trim() : '';
  if (!sourceRoot) throw providerError('LOCAL_RECOVERY_SOURCE_ROOT_UNAVAILABLE', 'Installed Recovery config does not identify the primary Runtime source root.');
  const repository = findRepository(sourceRoot, controllerHome);
  if (!repository?.repoId) throw providerError('LOCAL_RECOVERY_SOURCE_REPOSITORY_UNRESOLVED', 'Configured primary Runtime source root is not owned by one registered repository.');
  return persistConfig(controllerHome, {
    primaryRuntimeSourceRoot: sourceRoot,
    primaryRuntimeSourceRepositoryId: repository.repoId,
  });
}

export async function executeAction(actionId, input, providerConfig, injected = {}) {
  const config = validateProviderConfig(providerConfig);
  if (!ACTIONS.includes(actionId)) throw providerError('LOCAL_RECOVERY_ACTION_UNSUPPORTED', 'Unsupported Local Recovery action.');
  const sessionArgs = RELEASE_SESSION_ACTIONS.has(actionId) ? releaseSessionInput(input) : undefined;
  if (!sessionArgs) assertEmptyInput(input);
  const callTool = injected.callRecoveryTool ?? callRecoveryTool;
  if (actionId === 'stage_and_activate_runtime_release' || actionId === 'advance_runtime_release_session') ensureSourceRepositoryProvenance(config.controllerHome, injected);
  const args = {
    ...(sessionArgs ?? {}),
    ...(MUTATING_ACTIONS.has(actionId) ? { request_id: mutationRequestId(injected.requestId ?? actionId) } : {}),
  };
  return await callTool(config.controllerHome, actionId, args, injected);
}

function manifest() {
  return {
    id: PLUGIN_ID,
    name: 'Forge Local Recovery Transport',
    version: PLUGIN_VERSION,
    protocolVersion: '1.0',
    mode: 'external',
    scope: 'controller',
    provider: 'local-recovery-gateway',
    capabilities: CAPABILITIES,
    actions: ACTIONS,
  };
}

async function providerAction(request) {
  const config = loadProviderConfig();
  if (request.actionId === 'manifest') return manifest();
  if (request.actionId === 'health') {
    try {
      const status = await executeAction('runtime_status', {}, config, { requestId: request.requestId });
      return { state: 'ready', recovery: status };
    } catch (error) {
      return { state: 'degraded', warnings: [error?.code || 'LOCAL_RECOVERY_UNAVAILABLE'] };
    }
  }
  return await executeAction(request.actionId, request.input, config, { requestId: request.requestId });
}

export async function runManagedHelper() {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'handshake', protocolVersion: PROTOCOL_VERSION, pluginId: PLUGIN_ID, helperVersion: PLUGIN_VERSION, capabilities: CAPABILITIES })}\n`);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const line = raw.split(/\r?\n/).find((entry) => entry.trim());
  if (!line) throw providerError('LOCAL_RECOVERY_REQUEST_MISSING', 'Managed plugin request is missing.');
  const request = parseJson(line, 'LOCAL_RECOVERY_REQUEST_INVALID');
  if (request.schemaVersion !== 1 || request.type !== 'execute' || typeof request.requestId !== 'string' || typeof request.actionId !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw providerError('LOCAL_RECOVERY_REQUEST_INVALID', 'Managed plugin request envelope is invalid.');
  }
  try {
    const result = await providerAction(request);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: false, error: { code: error?.code || 'LOCAL_RECOVERY_FAILED', message: String(error?.message || 'Local Recovery provider failed.').replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 1000), retryable: error?.retryable === true, ...(error?.details ? { details: error.details } : {}) } })}\n`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runManagedHelper().catch((error) => {
    process.stderr.write(`LOCAL_RECOVERY_HELPER_FATAL: ${String(error?.message || error).replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 1000)}\n`);
    process.exitCode = 1;
  });
}
