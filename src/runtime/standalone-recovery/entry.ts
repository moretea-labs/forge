import { createHash, randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { readMcpServiceOAuthPassphrase } from '../../cli/mcp/auth';
import { FORGE_VERSION } from '../../version';
import {
  activateRuntimeRelease,
  attestKnownGood,
  diagnose,
  gatewayToken,
  listReleases,
  loadRecoveryConfig,
  loadWatchdogState,
  saveWatchdogState,
  reconnectMain,
  recoverPrimaryRuntime,
  repairPublicTunnel,
  restartPrimaryConnector,
  restartPrimaryRuntime,
  restartRecoveryWatchdog,
  stageAndActivateConfiguredRuntimeRelease,
  rollbackPrevious,
  secureEqual,
  runtimeStatus,
  verifyStableRuntime,
  watchdogTick,
  type WatchdogState,
  type RecoveryConfig,
} from './core';
import {
  createRecoveryWatchdogHeartbeat,
  observeRecoveryWatchdogHealth,
  writeRecoveryWatchdogHeartbeat,
  type RecoveryWatchdogHeartbeat,
} from './watchdog-heartbeat';
import {
  RECOVERY_RELEASE_ROLE_CANARY_ARG,
  writeRecoveryRuntimeIdentity,
  type RecoveryRuntimeIdentity,
  type RecoveryRuntimeRole,
} from './release';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function controllerHome(): string {
  const home = option('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME;
  if (!home) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return resolve(home);
}

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export const RECOVERY_CLI_COMMANDS = [
  'status',
  'verify',
  'verify-external',
  'list-releases',
  'attest-known-good',
  'rollback-previous',
  'restart-primary-runtime',
  'restart-primary-connector',
  'recover-primary-runtime',
  'activate-runtime-release',
  'stage-and-activate-runtime-release',
  'restart-public-tunnel',
  'diagnose',
  'reconnect-main',
] as const;

function usage(): never {
  throw new Error(`RECOVERY_USAGE: ${RECOVERY_CLI_COMMANDS.join(' | ')}`);
}

export function recoveryRuntimeRoleFromExecutable(executable = process.execPath): RecoveryRuntimeRole | undefined {
  const name = basename(executable);
  if (name === 'forge-recovery-gateway') return 'gateway';
  if (name === 'forge-recovery-watchdog') return 'watchdog';
  return undefined;
}

async function cli(): Promise<void> {
  const command = process.argv.find((value, index) => index >= 2 && !value.startsWith('-') && process.argv[index - 1] !== '--controller-home') ?? 'status';
  const config = loadRecoveryConfig(controllerHome(), option('--config'));
  const executableRole = recoveryRuntimeRoleFromExecutable();
  if (executableRole) {
    if (command !== executableRole) {
      throw new Error(executableRole === 'gateway' ? 'RECOVERY_GATEWAY_ROLE_ONLY' : 'RECOVERY_WATCHDOG_ROLE_ONLY');
    }
    if (process.argv.includes(RECOVERY_RELEASE_ROLE_CANARY_ARG)) {
      output({ status: 'ok', role: executableRole, executable: basename(process.execPath) });
      return;
    }
    if (executableRole === 'gateway') await startGateway(config);
    else await startWatchdog(config);
    return;
  }
  switch (command) {
    case 'status': output(await runtimeStatus(config)); return;
    case 'verify': output(await verifyStableRuntime(config)); return;
    case 'verify-external': {
      const verified = await verifyStableRuntime(config);
      output({ ok: verified.probes.external_mcp_http?.ok === true, external: verified.probes.external_mcp_http, mcp: verified.probes.mcp_initialize });
      return;
    }
    case 'list-releases': output(await listReleases(config)); return;
    case 'attest-known-good': output(await attestKnownGood(config)); return;
    case 'rollback-previous': output(await rollbackPrevious(config)); return;
    case 'restart-primary-runtime': output(await restartPrimaryRuntime(config)); return;
    case 'restart-primary-connector': output(await restartPrimaryConnector(config)); return;
    case 'recover-primary-runtime': output(await recoverPrimaryRuntime(config)); return;
    case 'activate-runtime-release': {
      const releasePath = option('--release-manifest') ?? option('--release-path');
      const expectedActiveReleaseId = option('--expected-active-release');
      const expectedAuthorityRevisionRaw = option('--expected-authority-revision');
      const expectedAuthorityRevision = Number(expectedAuthorityRevisionRaw);
      if (!releasePath) throw new Error('RECOVERY_RELEASE_MANIFEST_REQUIRED: pass --release-manifest <absolute-path>');
      if (!expectedActiveReleaseId?.trim()) throw new Error('RECOVERY_EXPECTED_ACTIVE_RELEASE_REQUIRED: run list-releases and pass --expected-active-release <release-id>');
      if (!Number.isInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 1) throw new Error('RECOVERY_EXPECTED_AUTHORITY_REVISION_REQUIRED: run list-releases and pass --expected-authority-revision <revision>');
      output(await activateRuntimeRelease(config, releasePath, {}, {
        requestId: `recovery-cli:${process.pid}:${Date.now()}`,
        expectedActiveReleaseId: expectedActiveReleaseId.trim(),
        expectedAuthorityRevision,
      }));
      return;
    }
    case 'stage-and-activate-runtime-release': output(await stageAndActivateConfiguredRuntimeRelease(config, {}, `recovery-cli:${process.pid}:${Date.now()}`)); return;
    case 'restart-public-tunnel': output(await repairPublicTunnel(config)); return;
    case 'diagnose': output(await diagnose(config)); return;
    case 'reconnect-main': output(await reconnectMain(config)); return;
    default: usage();
  }
}

export function resetWatchdogStateForRecoveryRelease(
  state: WatchdogState,
  releaseRevision: string,
): WatchdogState {
  if (state.recoveryReleaseRevision === releaseRevision) return state;
  return {
    ...state,
    // Recovery binary handoff must never mint a new primary Runtime restart
    // budget. Those counters are bound to the Runtime release and survive both
    // watchdog process exits and immutable Recovery release activation.
    recoveryGatewayRestartUsed: false,
    primaryConnectorFailures: 0,
    primaryConnectorFirstFailureAt: undefined,
    primaryConnectorRestartAttempts: 0,
    primaryConnectorRestartFailures: 0,
    primaryConnectorRestartLastAttemptAt: undefined,
    recoveryReleaseRevision: releaseRevision,
  };
}

async function startWatchdog(config: RecoveryConfig): Promise<void> {
  const runtimeIdentity = writeRecoveryRuntimeIdentity(config.controllerHome, 'watchdog');
  let heartbeat: RecoveryWatchdogHeartbeat = createRecoveryWatchdogHeartbeat(runtimeIdentity);
  const persistHeartbeat = (patch: Partial<RecoveryWatchdogHeartbeat> = {}) => {
    heartbeat = writeRecoveryWatchdogHeartbeat(config.controllerHome, { ...heartbeat, ...patch });
  };
  persistHeartbeat();
  const pulse = setInterval(() => persistHeartbeat({ lastPulseAt: new Date().toISOString() }), 5_000);
  pulse.unref?.();
  process.stdout.write(JSON.stringify({ status: 'ready', role: 'watchdog', runtimeIdentity }) + '\n');
  const loadedState = loadWatchdogState(config);
  let state = runtimeIdentity?.releaseRevision
    ? resetWatchdogStateForRecoveryRelease(loadedState, runtimeIdentity.releaseRevision)
    : loadedState;
  if (state !== loadedState) state = saveWatchdogState(config, state);
  for (;;) {
    const tickStartedAt = new Date().toISOString();
    persistHeartbeat({ lastPulseAt: tickStartedAt, lastTickStartedAt: tickStartedAt, lastError: undefined });
    try {
      const result = await watchdogTick(config, state);
      state = saveWatchdogState(config, result.state);
      const tickCompletedAt = new Date().toISOString();
      persistHeartbeat({ lastPulseAt: tickCompletedAt, lastTickCompletedAt: tickCompletedAt, lastError: undefined });
      process.stdout.write(JSON.stringify({
        at: new Date().toISOString(),
        action: result.decision.action,
        reason: result.decision.reason,
        failures: state.failures,
        publicTunnelFailures: state.publicTunnelFailures ?? 0,
        runtimeRestartAttempts: state.runtimeRestartAttempts ?? 0,
        runtimeRestartFailures: state.runtimeRestartFailures ?? 0,
        runtimeRestartBudgetIdentity: state.runtimeRestartBudgetIdentity,
        runtimeHealthySince: state.runtimeHealthySince,
        runtimeRestartBudgetExhaustedAt: state.runtimeRestartBudgetExhaustedAt,
        primaryRuntimeRestartDetail: result.primaryRuntimeRestart?.detail,
        primaryRuntimeRecoveryDetail: result.primaryRuntimeRecovery?.detail,
        rollbackDetail: result.rollback?.detail,
        publicTunnelDetail: result.publicTunnelRepair?.detail,
        primaryConnectorRestartDetail: result.primaryConnectorRestart?.detail,
      }) + '\n');
    } catch (error) {
      state = saveWatchdogState(config, { ...state, failures: state.failures + 1, firstFailureAt: state.firstFailureAt ?? Date.now() });
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      persistHeartbeat({ lastPulseAt: failedAt, lastTickFailedAt: failedAt, lastError: detail.slice(0, 500) });
      process.stderr.write(`watchdog probe failed: ${detail}\n`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000));
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  setCorsHeaders(response);
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

function html(response: ServerResponse, status: number, payload: string): void {
  response.statusCode = status;
  setCorsHeaders(response);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(payload);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version');
  response.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id');
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function auditGateway(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

function matchesPath(url: string | undefined, path: string): boolean {
  return url === path || Boolean(url?.startsWith(`${path}?`));
}

function matchesAnyPath(url: string | undefined, paths: string[]): boolean {
  return paths.some((path) => matchesPath(url, path));
}

export const RECOVERY_TOOLS = [
  { name: 'runtime_status', description: 'Read canonical Runtime ownership, readiness, endpoint, and release observation.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'list_releases', description: 'Read active, previous, and known-good whole-Runtime release evidence.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_stable_runtime', description: 'Run independent stable runtime verification.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'verify_external_runtime', description: 'Verify the external primary MCP endpoint.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'attest_known_good', description: 'Record the active release as known-good only after full independent verification succeeds.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'rollback_previous', description: 'While Canonical Runtime is stopped, atomically restore its attested previous whole-Runtime release and SQLite backup.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'restart_primary_runtime', description: 'Restart the installed canonical Forge Runtime service and require whole-Runtime verification.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'restart_primary_connector', description: 'Restart the explicitly configured primary OAuth/Connector launchd service only after local Canonical Runtime verification succeeds.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'recover_primary_runtime', description: 'Stop the canonical Runtime, restore the attested previous whole release and SQLite backup, restart it, and require verification.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'activate_runtime_release', description: 'Activate an already staged immutable Runtime release only if the caller-observed active release/authority revision are still current. Reverse activation of current.previous is rejected; use rollback_previous/recover_primary_runtime instead.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 }, release_path: { type: 'string', minLength: 8, maxLength: 1024, description: 'Absolute path to the staged immutable Runtime release directory.' }, expected_active_release_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_authority_revision: { type: 'integer', minimum: 1 } }, required: ['request_id', 'release_path', 'expected_active_release_id', 'expected_authority_revision'], additionalProperties: false } },
  { name: 'stage_and_activate_runtime_release', description: 'Build one immutable Runtime release from the fixed Recovery-configured source root, then activate it transactionally with rollback protection. No arbitrary source path is accepted.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'restart_public_tunnel', description: 'Restart the explicitly configured public tunnel only after local runtime verification succeeds and the external endpoint is unavailable.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 120 } }, required: ['request_id'], additionalProperties: false } },
  { name: 'reconnect_primary_connector', description: 'Check canonical Runtime Gateway and primary MCP reconnection readiness without publishing a release.', inputSchema: { type: 'object', additionalProperties: false } },
] as const;

const RECOVERY_OAUTH_SCOPE = 'forge';
const RECOVERY_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;
const TOOL_SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [RECOVERY_OAUTH_SCOPE] }] as const;
const SUPPORTED_TOKEN_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'] as const;
type TokenAuthMethod = typeof SUPPORTED_TOKEN_AUTH_METHODS[number];

type PendingOAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  scope?: string;
  createdAt: number;
};

type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: TokenAuthMethod;
  createdAt: number;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) { request.destroy(); reject(new Error('RECOVERY_REQUEST_TOO_LARGE')); }
    });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}

function requestUrl(request: IncomingMessage): URL {
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim() || '127.0.0.1';
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwardedProto || (/^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?$/i.test(host) ? 'http' : 'https');
  return new URL(request.url ?? '/', `${proto}://${host}`);
}

function publicOrigin(request: IncomingMessage, config?: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  if (config?.recoveryPublicUrl) return new URL(config.recoveryPublicUrl).origin;
  const url = requestUrl(request);
  return `${url.protocol}//${url.host}`;
}

function resourcePathFromRequest(_request: IncomingMessage): '/recovery/mcp' {
  // Tailscale Serve path-prefix handlers strip the public prefix before
  // proxying to this process. The externally configured Recovery Connector is
  // always advertised at /recovery/mcp even when the local request path is /mcp.
  return '/recovery/mcp';
}

function recoveryResource(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  return `${publicOrigin(request, config)}${resourcePathFromRequest(request)}`;
}

function recoveryAuthorizationServerMetadata(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): Record<string, unknown> {
  const origin = publicOrigin(request, config);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/recovery/oauth/authorize`,
    token_endpoint: `${origin}/recovery/oauth/token`,
    registration_endpoint: `${origin}/recovery/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_AUTH_METHODS,
    scopes_supported: [RECOVERY_OAUTH_SCOPE],
  };
}

function recoveryProtectedResourceMetadata(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): Record<string, unknown> {
  const origin = publicOrigin(request, config);
  return {
    resource: recoveryResource(request, config),
    authorization_servers: [origin],
    scopes_supported: [RECOVERY_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin}/recovery/health`,
  };
}

export function recoveryWwwAuthenticate(request: IncomingMessage, config: Pick<RecoveryConfig, 'recoveryPublicUrl'>): string {
  const metadata = `${publicOrigin(request, config)}/.well-known/oauth-protected-resource${resourcePathFromRequest(request)}`;
  return `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${metadata}"`;
}

export function recoveryUnauthorizedBody(): { error: string; message: string } {
  return { error: 'invalid_token', message: 'Missing Authorization header' };
}

export type RecoveryMcpRequestClassification = 'not_mcp' | 'auth_required' | 'method_not_supported' | 'mcp';

export function classifyRecoveryMcpRequest(
  request: Pick<IncomingMessage, 'method' | 'url' | 'headers'>,
  expectedToken: string | undefined,
): RecoveryMcpRequestClassification {
  if (!matchesAnyPath(request.url, ['/mcp', '/recovery/mcp'])) return 'not_mcp';
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!expectedToken || !supplied || !secureEqual(supplied, expectedToken)) return 'auth_required';
  if (request.method !== 'POST') return 'method_not_supported';
  return 'mcp';
}

function parseUrlEncoded(input: string): URLSearchParams {
  return new URLSearchParams(input);
}

async function parseRequestParameters(request: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(request);
  if (!raw.trim()) return new URLSearchParams();
  if (/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
    const jsonBody = JSON.parse(raw) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(jsonBody)) {
      if (typeof value === 'string') params.set(key, value);
      else if (typeof value === 'number' || typeof value === 'boolean') params.set(key, String(value));
    }
    return params;
  }
  return parseUrlEncoded(raw);
}

function parseBasicClientCredentials(request: IncomingMessage): { clientId: string; clientSecret: string } | undefined {
  const authorization = String(request.headers.authorization ?? '');
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

function tokenAuthMethod(value: unknown): TokenAuthMethod {
  return SUPPORTED_TOKEN_AUTH_METHODS.includes(value as TokenAuthMethod) ? value as TokenAuthMethod : 'client_secret_basic';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthorizeForm(params: URLSearchParams, error?: string): string {
  const hidden = Array.from(params.entries())
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize Forge Recovery</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 3rem auto; max-width: 38rem; line-height: 1.45; color: #111827; }
  label, input, button { display: block; width: 100%; box-sizing: border-box; }
  input { margin: .4rem 0 1rem; padding: .7rem; font: inherit; }
  button { padding: .75rem 1rem; font: inherit; border: 0; border-radius: .5rem; background: #111827; color: white; cursor: pointer; }
  .error { color: #b91c1c; }
  .hint { color: #4b5563; }
</style>
<h1>Authorize Forge Recovery</h1>
<p class="hint">Enter the local MCP passphrase to let ChatGPT use the recovery-only MCP connector.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post">
${hidden}
  <label>Passphrase
    <input name="passphrase" type="password" autocomplete="current-password" autofocus required>
  </label>
  <button type="submit">Authorize</button>
</form>`;
}

function codeChallengeMatches(verifier: string, challenge: string | undefined, method: string | undefined): boolean {
  if (!challenge) return true;
  if ((method ?? 'plain') === 'plain') return verifier === challenge;
  if (method !== 'S256') return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

function isOAuthMetadataPath(request: IncomingMessage): boolean {
  const path = requestUrl(request).pathname;
  return path === '/.well-known/oauth-authorization-server'
    || path === '/.well-known/openid-configuration'
    || path === '/oauth-authorization-server'
    || path === '/openid-configuration'
    || path === '/recovery/.well-known/oauth-authorization-server'
    || path === '/recovery/.well-known/openid-configuration';
}

function isProtectedResourceMetadataPath(request: IncomingMessage): boolean {
  const path = requestUrl(request).pathname;
  return path === '/.well-known/oauth-protected-resource'
    || path === '/.well-known/oauth-protected-resource/mcp'
    || path === '/.well-known/oauth-protected-resource/recovery/mcp'
    || path === '/oauth-protected-resource'
    || path === '/oauth-protected-resource/mcp'
    || path === '/oauth-protected-resource/recovery/mcp'
    || path === '/recovery/.well-known/oauth-protected-resource';
}

function isAuthorizePath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/authorize' || requestUrl(request).pathname === '/recovery/oauth/authorize';
}

function isTokenPath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/token' || requestUrl(request).pathname === '/recovery/oauth/token';
}

function isRegisterPath(request: IncomingMessage): boolean {
  return requestUrl(request).pathname === '/oauth/register' || requestUrl(request).pathname === '/recovery/oauth/register';
}

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,120}$/.test(value) ? value : undefined;
}

export async function dispatchRecoveryTool(config: RecoveryConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'runtime_status': return runtimeStatus(config);
    case 'list_releases': return listReleases(config);
    case 'verify_stable_runtime': return verifyStableRuntime(config);
    case 'verify_external_runtime': {
      const verified = await verifyStableRuntime(config);
      return { ok: verified.probes.external_mcp_http?.ok === true, external: verified.probes.external_mcp_http, mcp: verified.probes.mcp_initialize };
    }
    case 'attest_known_good': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return attestKnownGood(config);
    }
    case 'rollback_previous': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return rollbackPrevious(config, `recovery-gateway:${args.request_id}`);
    }
    case 'restart_primary_runtime': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return restartPrimaryRuntime(config);
    }
    case 'restart_primary_connector': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return restartPrimaryConnector(config);
    }
    case 'recover_primary_runtime': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return recoverPrimaryRuntime(config, `recovery-gateway:${args.request_id}`);
    }
    case 'activate_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      if (typeof args.release_path !== 'string' || !args.release_path.trim()) throw new Error('RECOVERY_RELEASE_PATH_REQUIRED');
      if (typeof args.expected_active_release_id !== 'string' || !args.expected_active_release_id.trim()) throw new Error('RECOVERY_EXPECTED_ACTIVE_RELEASE_REQUIRED');
      if (!Number.isInteger(args.expected_authority_revision) || Number(args.expected_authority_revision) < 1) throw new Error('RECOVERY_EXPECTED_AUTHORITY_REVISION_REQUIRED');
      const releasePath = args.release_path.trim();
      const manifestPath = basename(releasePath) === 'manifest.json' ? releasePath : join(releasePath, 'manifest.json');
      return activateRuntimeRelease(config, manifestPath, {}, {
        requestId: `recovery-gateway:${args.request_id}`,
        expectedActiveReleaseId: args.expected_active_release_id.trim(),
        expectedAuthorityRevision: Number(args.expected_authority_revision),
      });
    }
    case 'stage_and_activate_runtime_release': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return stageAndActivateConfiguredRuntimeRelease(config, {}, `recovery-gateway:${args.request_id}`);
    }
    case 'restart_public_tunnel': {
      if (!requestId(args.request_id)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
      return repairPublicTunnel(config);
    }
    case 'reconnect_primary_connector': return reconnectMain(config);
    default: throw new Error('RECOVERY_TOOL_NOT_FOUND');
  }
}

async function startGateway(config: RecoveryConfig): Promise<void> {
  const gateway = config.gateway;
  if (!gateway || gateway.host !== '127.0.0.1' || !Number.isInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535) {
    throw new Error('RECOVERY_GATEWAY_CONFIG_INVALID');
  }
  let runtimeIdentity: RecoveryRuntimeIdentity | undefined;
  let watchdogRestartInFlight = false;
  const recentMutations = new Map<string, number[]>();
  const oauthCodes = new Map<string, PendingOAuthCode>();
  const oauthClients = new Map<string, OAuthClient>();
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      setCorsHeaders(response);
      response.end();
      return;
    }
    if (request.method === 'GET' && matchesAnyPath(request.url, ['/health', '/recovery/health'])) {
      const watchdog = observeRecoveryWatchdogHealth(config.controllerHome);
      json(response, 200, {
        status: watchdog.ok ? 'ok' : 'degraded',
        service: 'forge-standalone-recovery',
        watchdog: {
          ok: watchdog.ok,
          detail: watchdog.detail,
          pulseAgeMs: watchdog.pulseAgeMs,
          tickAgeMs: watchdog.tickAgeMs,
          releaseRevision: watchdog.runtimeIdentity?.releaseRevision,
          pid: watchdog.runtimeIdentity?.pid,
        },
        version: FORGE_VERSION,
        ...(runtimeIdentity ? {
          releasePath: runtimeIdentity.releasePath,
          releaseRevision: runtimeIdentity.releaseRevision,
          sourceCommit: runtimeIdentity.sourceCommit,
          manifestSha256: runtimeIdentity.manifestSha256,
        } : {}),
      });
      return;
    }
    if (request.method === 'GET' && isProtectedResourceMetadataPath(request)) { json(response, 200, recoveryProtectedResourceMetadata(request, config)); return; }
    if (request.method === 'GET' && isOAuthMetadataPath(request)) { json(response, 200, recoveryAuthorizationServerMetadata(request, config)); return; }
    if ((request.method === 'GET' || request.method === 'POST') && isAuthorizePath(request)) {
      const params = request.method === 'GET'
        ? requestUrl(request).searchParams
        : parseUrlEncoded(await readBody(request));
      const redirectUri = params.get('redirect_uri');
      const clientId = params.get('client_id');
      const responseType = params.get('response_type');
      if (!redirectUri || !clientId || responseType !== 'code') { json(response, 400, { error: 'invalid_request' }); return; }
      if (request.method === 'GET') { html(response, 200, renderAuthorizeForm(params)); return; }
      const expectedPassphrase = readMcpServiceOAuthPassphrase(config.controllerHome);
      const suppliedPassphrase = params.get('passphrase') ?? '';
      if (!expectedPassphrase || !secureEqual(suppliedPassphrase, expectedPassphrase)) {
        html(response, 401, renderAuthorizeForm(params, 'Invalid passphrase.'));
        return;
      }
      const code = randomUUID();
      oauthCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: params.get('code_challenge') ?? undefined,
        codeChallengeMethod: params.get('code_challenge_method') ?? undefined,
        resource: params.get('resource') ?? undefined,
        scope: params.get('scope') ?? undefined,
        createdAt: Date.now(),
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = params.get('state');
      if (state) callback.searchParams.set('state', state);
      response.statusCode = 302;
      response.setHeader('location', callback.toString());
      response.end();
      return;
    }
    if (request.method === 'POST' && isRegisterPath(request)) {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(request);
        body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch { /* tolerate minimal DCR clients */ }
      const clientId = typeof body.client_id === 'string' && body.client_id ? body.client_id : randomUUID();
      const clientSecret = randomUUID();
      const authMethod = tokenAuthMethod(body.token_endpoint_auth_method);
      oauthClients.set(clientId, {
        clientId,
        clientSecret: authMethod === 'none' ? undefined : clientSecret,
        tokenEndpointAuthMethod: authMethod,
        createdAt: Date.now(),
      });
      auditGateway({ oauth: 'register', outcome: 'created', token_endpoint_auth_method: authMethod });
      json(response, 201, {
        ...body,
        client_id: clientId,
        ...(authMethod === 'none' ? {} : { client_secret: clientSecret }),
        client_secret_expires_at: 0,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: authMethod,
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
      return;
    }
    if (request.method === 'POST' && isTokenPath(request)) {
      let params: URLSearchParams;
      try {
        params = await parseRequestParameters(request);
      } catch {
        auditGateway({ oauth: 'token', outcome: 'invalid_request' });
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      if (params.get('grant_type') !== 'authorization_code') {
        auditGateway({ oauth: 'token', outcome: 'unsupported_grant_type' });
        json(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      const basicCredentials = parseBasicClientCredentials(request);
      const code = params.get('code');
      const clientId = basicCredentials?.clientId ?? params.get('client_id') ?? '';
      const clientSecret = basicCredentials?.clientSecret ?? params.get('client_secret') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const pending = code ? oauthCodes.get(code) : undefined;
      if (!code || !pending || pending.clientId !== clientId || pending.redirectUri !== redirectUri || Date.now() - pending.createdAt > 10 * 60_000) {
        auditGateway({ oauth: 'token', outcome: 'invalid_grant' });
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      const registeredClient = oauthClients.get(clientId);
      if (registeredClient?.clientSecret && !secureEqual(clientSecret, registeredClient.clientSecret)) {
        auditGateway({ oauth: 'token', outcome: 'invalid_client', token_endpoint_auth_method: registeredClient.tokenEndpointAuthMethod });
        response.setHeader('www-authenticate', 'Basic realm="forge-recovery-oauth"');
        json(response, 401, { error: 'invalid_client' });
        return;
      }
      if (!codeChallengeMatches(verifier, pending.codeChallenge, pending.codeChallengeMethod)) {
        auditGateway({ oauth: 'token', outcome: 'invalid_grant_pkce' });
        json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      oauthCodes.delete(code);
      const token = gatewayToken(config);
      if (!token) {
        auditGateway({ oauth: 'token', outcome: 'server_error' });
        json(response, 503, { error: 'server_error', error_description: 'Recovery token is not configured' });
        return;
      }
      auditGateway({ oauth: 'token', outcome: 'issued' });
      json(response, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: RECOVERY_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
        scope: pending.scope || RECOVERY_OAUTH_SCOPE,
      });
      return;
    }
    const mcpRequest = classifyRecoveryMcpRequest(request, gatewayToken(config));
    if (mcpRequest === 'not_mcp' || mcpRequest === 'method_not_supported') { json(response, 404, { error: 'NOT_FOUND' }); return; }
    if (mcpRequest === 'auth_required') { response.setHeader('www-authenticate', recoveryWwwAuthenticate(request, config)); json(response, 401, recoveryUnauthorizedBody()); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) { json(response, 415, { error: 'RECOVERY_CONTENT_TYPE_REQUIRED' }); return; }
    let message: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    try { message = JSON.parse(await readBody(request)) as typeof message; } catch { json(response, 400, rpcError(null, -32700, 'Invalid JSON.')); return; }
    const id = message.id ?? null;
    if (message.method === 'initialize') { json(response, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'forge-standalone-recovery', version: FORGE_VERSION } } }); return; }
    if (message.method === 'notifications/initialized') { response.statusCode = 202; response.end(); return; }
    if (message.method === 'tools/list') {
      const tools = RECOVERY_TOOLS.map((tool) => ({
        ...tool,
        securitySchemes: TOOL_SECURITY_SCHEMES,
        _meta: { securitySchemes: TOOL_SECURITY_SCHEMES },
      }));
      json(response, 200, { jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (message.method !== 'tools/call' || typeof message.params?.name !== 'string') { json(response, 200, rpcError(id, -32601, 'Unsupported MCP method.')); return; }
    const name = message.params.name;
    const args = message.params.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments) ? message.params.arguments as Record<string, unknown> : {};
    if (name === 'attest_known_good' || name === 'rollback_previous' || name === 'restart_primary_runtime' || name === 'restart_primary_connector' || name === 'recover_primary_runtime' || name === 'activate_runtime_release' || name === 'stage_and_activate_runtime_release' || name === 'restart_public_tunnel') {
      const address = request.socket.remoteAddress ?? 'unknown'; const now = Date.now();
      const window = (recentMutations.get(address) ?? []).filter((at) => now - at < 60_000);
      if (window.length >= 3) { json(response, 429, rpcError(id, -32029, 'Recovery mutation rate limit exceeded.')); return; }
      window.push(now); recentMutations.set(address, window);
    }
    try {
      const payload = await dispatchRecoveryTool(config, name, args);
      json(response, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } });
    } catch (error) { json(response, 200, rpcError(id, -32602, error instanceof Error ? error.message : 'Recovery request rejected')); }
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(gateway.port, gateway.host, () => resolveListen()); });
  runtimeIdentity = writeRecoveryRuntimeIdentity(config.controllerHome, 'gateway');
  const superviseWatchdog = async () => {
    if (!runtimeIdentity || watchdogRestartInFlight) return;
    const watchdog = observeRecoveryWatchdogHealth(config.controllerHome);
    if (watchdog.ok) return;
    watchdogRestartInFlight = true;
    try {
      const recovery = await restartRecoveryWatchdog(config);
      auditGateway({
        watchdog_supervision: recovery.ok ? 'recovered' : 'failed',
        detail: recovery.detail,
        attempted: recovery.attempted,
        serviceTarget: recovery.serviceTarget,
      });
    } finally {
      watchdogRestartInFlight = false;
    }
  };
  const watchdogSupervisor = setInterval(() => { void superviseWatchdog(); }, 15_000);
  watchdogSupervisor.unref?.();
  process.stdout.write(JSON.stringify({ status: 'ready', host: gateway.host, port: gateway.port, runtimeIdentity }) + '\n');
}

const isDirectExecution = import.meta.main === true
  || Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

if (isDirectExecution) {
  void cli().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
