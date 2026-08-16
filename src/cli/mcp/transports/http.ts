import { randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, watch } from 'fs';
import { dirname } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  buildMultiRepositoryToolDefinitions,
  createMcpToolContext,
  createForgeMcpServerFromContext,
  readCanonicalRuntimeToolSchema,
  type CanonicalRuntimeToolSchema,
  type McpServerOptions,
} from '../server';
import {
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpServiceOAuthTokenStoreFallbackPaths,
  mcpServiceOAuthTokenStorePath,
  parseMcpHttpAuthMode,
  readMcpServiceBearerToken,
  readMcpServiceOAuthPassphrase,
  type McpLocalConfig,
  type McpHttpAuthMode,
} from '../auth';
import { createMcpOAuthProvider, McpOAuthTokenStore } from '../oauth';
import { resolveMcpRepoRoot } from '../repo';
import { buildMcpToolDefinitions } from '../tools';
import { resolveControllerHome } from '../../repositories/controller-home';
import {
  controllerExposureSnapshot,
} from '../toolset';
import { readForgeRuntimeStatus } from '../../../runtime/control-plane/runtime-status-client';
import { runtimeIdentitySnapshot } from '../../../runtime/gateway/mcp/runtime-tools';
import { projectionBlocksReadiness, readRepositoryProjectionSnapshot } from '../../../runtime/projections/materialized-view';
import { readRuntimeGeneration } from '../../../runtime/control-plane/runtime-generation';
import { readRuntimeStatusSnapshot, runtimeStatusPath } from '../../../runtime/root/status';
import { getRepository, listRepositories } from '../../repositories/registry';
import { buildControllerTaskLedgerProjection } from '../../controller/task-ledger';
import { legacyIssueAuthorityRetired } from '../../controller/legacy-issue-cutover';
import { reconcileReadinessProjectionSource } from '../readiness-projection';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  repositoryIdentity,
} from '../../controller/runtime-config';
import { McpSessionRegistry, type McpSessionRoute } from './session-registry';

export interface McpHttpOptions extends McpServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  auth?: string;
}

function localControllerDiagnosticMatchesRuntime(
  payload: Record<string, unknown> | null,
  generation?: string,
): boolean {
  return payload?.status === 'ok'
    && payload.toolSurface === FORGE_TOOL_SURFACE
    && payload.schemaVersion === FORGE_MCP_SCHEMA_VERSION
    && payload.version === FORGE_VERSION
    && (generation === undefined || payload.generation === generation);
}

function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function principalFromRequest(req: Request): string {
  const auth = (req as unknown as { auth?: { clientId?: string } }).auth;
  if (auth?.clientId?.trim()) return `oauth-client:${auth.clientId.trim()}`;
  return bearerFromRequest(req) ? 'mcp-bearer-client' : 'controller-http-client';
}

export function isAuthorizedMcpHttpRequest(req: Request, expectedToken: string | null): boolean {
  if (!expectedToken) return false;
  return bearerFromRequest(req) === expectedToken;
}

function rawBodyToJson(body: Buffer): unknown | undefined {
  if (body.length === 0) return undefined;
  return JSON.parse(body.toString('utf-8'));
}

function isInitializeRequest(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).method === 'initialize';
}

function isServerDiscoverRequest(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).method === 'server/discover';
}

function sendLegacyServerDiscoverUnsupported(res: Response, body: unknown): void {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const id = typeof record.id === 'string' || typeof record.id === 'number' || record.id === null ? record.id : null;
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: 'Method not found',
    },
  });
}

function initializeClientIdentity(req: Request, body: unknown, route: McpSessionRoute, principalId: string): string {
  const params = typeof body === 'object' && body !== null
    ? (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } }).params
    : undefined;
  const clientInfo = params?.clientInfo;
  const clientName = typeof clientInfo?.name === 'string' && clientInfo.name.trim() ? clientInfo.name.trim() : 'unknown-client';
  const clientVersion = typeof clientInfo?.version === 'string' && clientInfo.version.trim() ? clientInfo.version.trim() : 'unknown-version';
  const userAgent = typeof req.headers['user-agent'] === 'string' && req.headers['user-agent'].trim()
    ? req.headers['user-agent'].trim().slice(0, 160)
    : 'unknown-agent';
  return `${principalId}|${route}|${clientName}/${clientVersion}|${userAgent}`;
}

export interface McpSessionLookupErrorResponse {
  status: 400 | 404;
  body: {
    error: 'missing_session' | 'session_not_found';
    code: 'MCP_SESSION_REQUIRED' | 'MCP_SESSION_EXPIRED';
    message: string;
    recoverable: true;
    action: 'reinitialize';
  };
}

export function mcpSessionLookupError(sessionId: string | undefined): McpSessionLookupErrorResponse {
  if (!sessionId?.trim()) {
    return {
      status: 400,
      body: {
        error: 'missing_session',
        code: 'MCP_SESSION_REQUIRED',
        message: 'Mcp-Session-Id header is required for this request.',
        recoverable: true,
        action: 'reinitialize',
      },
    };
  }
  return {
    status: 404,
    body: {
      error: 'session_not_found',
      code: 'MCP_SESSION_EXPIRED',
      message: 'MCP session not found or expired; initialize a new session.',
      recoverable: true,
      action: 'reinitialize',
    },
  };
}

export function sendMcpSessionLookupError(res: Response, sessionId: string | undefined): void {
  const response = mcpSessionLookupError(sessionId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Mcp-Session-Reset', 'reinitialize');
  res.setHeader('x-forge-session-reset', 'reinitialize');
  res.status(response.status).json(response.body);
}

export function mcpSessionToolSurfaceFingerprintIsCurrent(
  sessionFingerprint: string | undefined,
  currentFingerprint: string | undefined,
): boolean {
  // Missing metadata is tolerated for compatibility and transient
  // controller-home read failures. Once both sides are known, equality is the
  // schema fence. Runtime generation remains diagnostic-only.
  return !sessionFingerprint || !currentFingerprint || sessionFingerprint === currentFingerprint;
}

export async function resolveMcpSessionCurrentFingerprint(
  publishedFingerprint: string | undefined,
  loadRuntimeFingerprint?: () => Promise<string | undefined>,
): Promise<string | undefined> {
  // Runtime status publishes the exact schema fingerprint observed at session
  // initialization/cutover. Prefer that O(1) fence on the hot path. If the
  // publication is temporarily unavailable, retain the previous fail-safe
  // behavior by asking the Canonical Runtime directly.
  if (publishedFingerprint) return publishedFingerprint;
  return await loadRuntimeFingerprint?.();
}

function toolCallOutsideSessionSchema(body: unknown, toolNames: readonly string[] | undefined): boolean {
  if (!toolNames) return false;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const rpc = message as { method?: unknown; params?: { name?: unknown } };
    return rpc.method === 'tools/call'
      && typeof rpc.params?.name === 'string'
      && !toolNames.includes(rpc.params.name);
  });
}

function sendMcpToolSurfaceReset(
  res: Response,
  sessionFingerprint: string | undefined,
  currentFingerprint: string | undefined,
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Mcp-Session-Reset', 'reinitialize');
  res.setHeader('x-forge-session-reset', 'reinitialize');
  res.setHeader('x-forge-session-reset-reason', 'tool_surface_changed');
  res.status(404).json({
    error: 'session_not_found',
    code: 'MCP_TOOL_SURFACE_CHANGED',
    message: 'MCP Runtime tool surface changed; initialize a new session so tools/list is refreshed.',
    recoverable: true,
    action: 'reinitialize',
    previousFingerprint: sessionFingerprint,
    currentFingerprint,
  });
}

export function mcpRequestError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const retryable = /(?:\b502\b|\b503\b|\b429\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|CANONICAL_RUNTIME_TIMEOUT|server_busy|session_capacity|gateway)/i.test(rawMessage);
  return {
    status: (retryable ? 503 : 500) as 500 | 503,
    body: {
      error: 'request_failed' as const,
      code: (retryable ? 'MCP_TRANSIENT_FAILURE' : 'MCP_REQUEST_FAILED') as 'MCP_TRANSIENT_FAILURE' | 'MCP_REQUEST_FAILED',
      message: retryable
        ? 'The MCP Runtime is temporarily unavailable; retry shortly.'
        : 'The MCP request could not be completed.',
      recoverable: true as const,
      retryable,
      sessionPreserved: true as const,
      action: 'retry' as const,
    },
  };
}

export function sendMcpRequestError(res: Response, error: unknown): void {
  const response = mcpRequestError(error);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-forge-session-preserved', 'true');
  res.status(response.status).json(response.body);
}

function getConfiguredPublicOrigin(config: McpLocalConfig | null): string | undefined {
  const configured = process.env.FORGE_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch (_error) {
      // Fall through to service or legacy config.
    }
  }
  const endpoint = config?.chatgpt?.endpoint?.trim();
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).origin;
  } catch (_error) {
    return undefined;
  }
}

function getPublicOrigin(req: Request, configuredOrigin: string | undefined): string {
  if (configuredOrigin) return configuredOrigin;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '127.0.0.1:8765';
  return `${proto}://${host}`;
}

function localControllerHealthUrl(host: string, port: number): string {
  return `http://${host === '::1' ? '[::1]' : host}:${port}/health`;
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function isAllowedMcpOAuthRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return true;
    }
    if (
      url.protocol === 'https:' &&
      (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') &&
      url.pathname.startsWith('/connector/oauth/')
    ) {
      return true;
    }
    return false;
  } catch (_error) {
    return false;
  }
}

function isRegisteredRedirectUri(redirectUri: string, client: { redirect_uris?: string[] }): boolean {
  return (client.redirect_uris ?? []).some((registered) => redirectUriMatches(redirectUri, registered));
}

function isRegisteredExternalHttpsRedirectUri(redirectUri: string, client: { redirect_uris?: string[] }): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'https:' && !url.username && !url.password && isRegisteredRedirectUri(redirectUri, client);
  } catch (_error) {
    return false;
  }
}

function isSafeOAuthFallbackRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password) return false;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

async function getOrRegisterPublicOAuthClient(
  provider: ReturnType<typeof createMcpOAuthProvider>,
  clientId: string,
  redirectUri: string | undefined,
  req: Request,
): Promise<OAuthClientInformationFull | undefined> {
  const existing = await provider.clientsStore.getClient(clientId);
  if (existing) return existing as OAuthClientInformationFull;
  if (!redirectUri || !isSafeOAuthFallbackRedirectUri(redirectUri) || !provider.clientsStore.registerClient) return undefined;
  oauthTrace(req, 'authorize:auto_register_public_client', {
    redirectScheme: new URL(redirectUri).protocol,
    redirectHost: new URL(redirectUri).hostname,
  });
  return provider.clientsStore.registerClient({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: 'forge OAuth fallback client',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  } as unknown as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) as OAuthClientInformationFull;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderPassphrasePage(params: URLSearchParams): string {
  const hiddenFields = Array.from(params.entries())
    .filter(([key]) => key !== 'passphrase')
    .map(([key, value]) => `<input type="hidden" name="${escapeHtmlAttribute(key)}" value="${escapeHtmlAttribute(value)}">`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize forge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f6f3;color:#1f2328}
.card{width:min(420px,92vw);background:#fff;border:1px solid #d8d8d0;border-radius:12px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#60666d;line-height:1.45}
input{width:100%;box-sizing:border-box;border:1px solid #bfc4c9;border-radius:8px;padding:12px;font-size:16px}
button{width:100%;margin-top:14px;border:0;border-radius:8px;padding:12px;background:#1f2328;color:#fff;font-size:16px;font-weight:600}
</style></head>
<body><main class="card">
<h1>Authorize forge</h1>
<p>Enter the local MCP passphrase to let this MCP client use this workflow-scoped connector.</p>
<form method="POST" action="/authorize">
${hiddenFields}
<input type="password" name="passphrase" placeholder="Passphrase" autofocus>
<button type="submit">Authorize</button>
</form>
</main></body></html>`;
}

/** Collect OAuth authorize params from query (GET) or body (POST form). */
function oauthAuthorizeParamSource(req: Request): Record<string, unknown> {
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return req.query as Record<string, unknown>;
}

function readOAuthAuthorizeString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when the request lacks the OAuth parameters needed for a real authorization.
 * Incomplete requests must not render the passphrase form (incompatible clients loop there).
 */
export function isIncompleteOAuthAuthorizeRequest(source: Record<string, unknown>): boolean {
  const clientId = readOAuthAuthorizeString(source, 'client_id');
  const responseType = readOAuthAuthorizeString(source, 'response_type');
  const codeChallenge = readOAuthAuthorizeString(source, 'code_challenge');
  const redirectUri = readOAuthAuthorizeString(source, 'redirect_uri');
  // redirect_uri may be omitted when the client has a single registered URI; client_id is the usable redirect context.
  const hasRedirectContext = Boolean(redirectUri) || Boolean(clientId);
  return !clientId || !responseType || !codeChallenge || !hasRedirectContext;
}

function incompleteOAuthAuthorizeResponseBody(): {
  error: 'invalid_request';
  error_description: string;
  message: string;
  hint: string;
} {
  return {
    error: 'invalid_request',
    error_description:
      'OAuth authorization request is incomplete. Required: client_id, response_type, code_challenge, and a usable redirect context (redirect_uri or a registered client).',
    message:
      'This endpoint expects a complete OAuth authorization request (PKCE). Non-OAuth MCP clients should use /mcp-bearer with Authorization: Bearer <token> instead of /authorize.',
    hint: 'Use POST/GET /mcp-bearer with a forge bearer token for clients that cannot complete OAuth dynamic registration and PKCE.',
  };
}

function isOAuthDebugTraceEnabled(): boolean {
  return process.env.FORGE_MCP_OAUTH_TRACE === '1' || process.env.FORGE_MCP_OAUTH_TRACE === 'true';
}

const SENSITIVE_OAUTH_FIELDS = new Set([
  'passphrase',
  'code',
  'code_verifier',
  'client_secret',
  'access_token',
  'refresh_token',
  'token',
  'authorization',
]);

function safeOAuthFieldNames(source: Record<string, unknown>): string[] {
  return Object.keys(source)
    .filter((key) => !SENSITIVE_OAUTH_FIELDS.has(key.toLowerCase()))
    .sort();
}

function oauthTrace(req: Request, event: string, extra: Record<string, unknown> = {}): void {
  if (!isOAuthDebugTraceEnabled()) return;
  const source = oauthAuthorizeParamSource(req);
  const userAgent = typeof req.headers['user-agent'] === 'string'
    ? req.headers['user-agent'].split(/[\s/]/)[0]
    : undefined;
  const safe = {
    event,
    method: req.method,
    path: req.path,
    fieldNames: safeOAuthFieldNames(source),
    hasClientId: Boolean(readOAuthAuthorizeString(source, 'client_id')),
    hasRedirectUri: Boolean(readOAuthAuthorizeString(source, 'redirect_uri')),
    hasCodeChallenge: Boolean(readOAuthAuthorizeString(source, 'code_challenge')),
    responseType: readOAuthAuthorizeString(source, 'response_type') || undefined,
    codeChallengeMethod: readOAuthAuthorizeString(source, 'code_challenge_method') || undefined,
    grantType: readOAuthAuthorizeString(source, 'grant_type') || undefined,
    hasResource: Boolean(readOAuthAuthorizeString(source, 'resource')),
    userAgent,
    ...extra,
  };
  console.error(`[forge:mcp-oauth] ${JSON.stringify(safe)}`);
}

function oauthTraceMiddleware(event: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    oauthTrace(req, `${event}:request`);
    res.once('finish', () => oauthTrace(req, `${event}:response`, { statusCode: res.statusCode }));
    next();
  };
}

function rejectIncompleteOAuthAuthorize(req: Request, res: Response, next: NextFunction): void {
  const source = oauthAuthorizeParamSource(req);
  if (isIncompleteOAuthAuthorizeRequest(source)) {
    oauthTrace(req, 'authorize:incomplete');
    res.status(400).json(incompleteOAuthAuthorizeResponseBody());
    return;
  }
  oauthTrace(req, 'authorize:complete');
  next();
}

function requirePassphrase(passphrase: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const provided = typeof req.body?.passphrase === 'string' ? req.body.passphrase : undefined;
    if (provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(passphrase);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        next();
        return;
      }
    }
    // Prefer body hidden fields on POST (failed passphrase re-render), else query string on GET.
    const source = oauthAuthorizeParamSource(req);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(source)) {
      if (key === 'passphrase') continue;
      if (typeof value === 'string') params.set(key, value);
    }
    if ([...params.keys()].length === 0 && req.url.includes('?')) {
      const fromUrl = new URLSearchParams(req.url.slice(req.url.indexOf('?')));
      for (const [key, value] of fromUrl.entries()) {
        if (key !== 'passphrase') params.set(key, value);
      }
    }
    res.type('html').send(renderPassphrasePage(params));
  };
}

function oauthAuthorizationHandler(provider: ReturnType<typeof createMcpOAuthProvider>) {
  return async (req: Request, res: Response) => {
    const query = req.method === 'POST' ? req.body : req.query;
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    const responseType = typeof query.response_type === 'string' ? query.response_type : '';
    const codeChallenge = typeof query.code_challenge === 'string' ? query.code_challenge : '';
    const codeChallengeMethod = typeof query.code_challenge_method === 'string' ? query.code_challenge_method : '';
    const state = typeof query.state === 'string' ? query.state : undefined;
    const scope = typeof query.scope === 'string' ? query.scope : undefined;
    let redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : undefined;

    if (responseType !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only code response type is supported' });
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 is required' });
      return;
    }

    const client = await getOrRegisterPublicOAuthClient(provider, clientId, redirectUri, req);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (!redirectUri && client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    }
    if (!redirectUri || (!isAllowedMcpOAuthRedirectUri(redirectUri) && !isRegisteredExternalHttpsRedirectUri(redirectUri, client))) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must be localhost, a ChatGPT connector callback URL, or a registered HTTPS client redirect_uri',
      });
      return;
    }
    if (!isRegisteredRedirectUri(redirectUri, client)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must match a registered client redirect_uri',
      });
      return;
    }

    await provider.authorize(client as OAuthClientInformationFull, {
      state,
      scopes: scope ? scope.split(' ') : [],
      redirectUri,
      codeChallenge,
    }, res);
  };
}

function sendBearerUnauthorized(res: Response, description: string, hasConfiguredToken: boolean): void {
  res.setHeader('www-authenticate', 'Bearer realm="forge-mcp"');
  res.status(hasConfiguredToken ? 401 : 503).json({
    error: hasConfiguredToken ? 'unauthorized' : 'auth_not_configured',
    message: description,
  });
}

function sendOAuthUnauthorized(
  req: Request,
  res: Response,
  description: string,
  configuredOrigin: string | undefined,
  resourcePath = '/mcp',
): void {
  const resourceMetadataUrl = `${getPublicOrigin(req, configuredOrigin)}/.well-known/oauth-protected-resource${resourcePath}`;
  res.setHeader(
    'www-authenticate',
    `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl}"`,
  );
  res.status(401).json({ error: 'invalid_token', message: description });
}

function requireMcpHttpAuth(
  mode: McpHttpAuthMode,
  bearerToken: string | null,
  provider: ReturnType<typeof createMcpOAuthProvider> | null,
  configuredOrigin: string | undefined,
  resourcePath = '/mcp',
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (mode === 'bearer') {
      if (!isAuthorizedMcpHttpRequest(req, bearerToken)) {
        sendBearerUnauthorized(res, bearerToken ? 'Missing or invalid Authorization header' : 'Bearer token is not configured', Boolean(bearerToken));
        return;
      }
      next();
      return;
    }

    if (isAuthorizedMcpHttpRequest(req, bearerToken)) {
      next();
      return;
    }

    const token = bearerFromRequest(req);
    if (!token || !provider) {
      sendOAuthUnauthorized(req, res, token ? 'OAuth is not configured' : 'Missing Authorization header', configuredOrigin, resourcePath);
      return;
    }
    provider.verifyAccessToken(token)
      .then((authInfo) => {
        (req as unknown as Record<string, unknown>).auth = authInfo;
        next();
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidTokenError) {
          sendOAuthUnauthorized(req, res, error.message, configuredOrigin, resourcePath);
        } else {
          res.status(500).json({ error: 'server_error', message: 'Internal Server Error' });
        }
      });
  };
}

interface McpRuntimeStats {
  initializing: number;
  activePosts: number;
  rejectedOverload: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_MCP_SESSIONS = positiveIntegerEnv('FORGE_MCP_MAX_SESSIONS', 64);
const MAX_MCP_SESSIONS_PER_PRINCIPAL = positiveIntegerEnv('FORGE_MCP_MAX_SESSIONS_PER_PRINCIPAL', 8);
const MAX_INITIALIZING_SESSIONS = positiveIntegerEnv('FORGE_MCP_MAX_INITIALIZING_SESSIONS', 8);
const MAX_POSTS_PER_SESSION = positiveIntegerEnv('FORGE_MCP_MAX_POSTS_PER_SESSION', 4);
const MAX_ACTIVE_POSTS = positiveIntegerEnv('FORGE_MCP_MAX_ACTIVE_POSTS', 32);
const MCP_SESSION_IDLE_TTL_MS = positiveIntegerEnv('FORGE_MCP_SESSION_IDLE_TTL_MS', 15 * 60_000);
const MCP_STREAM_LEASE_MS = positiveIntegerEnv('FORGE_MCP_STREAM_LEASE_MS', 30 * 60_000);
const MCP_SESSION_ABSOLUTE_LIFETIME_MS = positiveIntegerEnv('FORGE_MCP_SESSION_ABSOLUTE_LIFETIME_MS', 2 * 60 * 60_000);
const MCP_ACTIVE_POST_STALL_MS = positiveIntegerEnv('FORGE_MCP_ACTIVE_POST_STALL_MS', 10 * 60_000);

type McpToolContext = ReturnType<typeof createMcpToolContext>;
type HttpSessionRegistry = McpSessionRegistry<StreamableHTTPServerTransport, McpToolContext>;

async function handleMcpPost(
  req: Request,
  res: Response,
  baseOptions: McpServerOptions,
  registry: HttpSessionRegistry,
  stats: McpRuntimeStats,
  route: McpSessionRoute,
  currentToolSurfaceFingerprint: () => string | undefined,
  resolveRuntimeSchema?: (context: McpToolContext) => Promise<CanonicalRuntimeToolSchema | undefined>,
): Promise<void> {
  let body: unknown;
  try {
    body = rawBodyToJson(req.body as Buffer);
  } catch (_error) {
    res.status(400).json({ error: 'invalid JSON request body' });
    return;
  }
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  // MCP 2026-07-28 clients probe legacy servers with server/discover before
  // falling back to the initialize-era protocol. Forge still serves the
  // legacy stateful transport, so reject the unsupported modern RPC with the
  // protocol-prescribed Method not found / HTTP 404 response instead of
  // misclassifying it as a missing-session HTTP 400.
  if (isServerDiscoverRequest(body)) {
    sendLegacyServerDiscoverUnsupported(res, body);
    return;
  }
  if (isInitializeRequest(body)) {
    if (sessionId) {
      res.setHeader('Mcp-Session-Reset', 'reinitialized');
      res.setHeader('x-forge-session-reset', 'reinitialized');
    }
    if (stats.initializing >= MAX_INITIALIZING_SESSIONS || stats.activePosts >= MAX_ACTIVE_POSTS) {
      stats.rejectedOverload += 1;
      res.setHeader('retry-after', '1');
      res.status(503).json({ error: 'server_busy', message: 'Too many MCP sessions are initializing; retry shortly' });
      return;
    }
    stats.initializing += 1;
    stats.activePosts += 1;
    let transport: StreamableHTTPServerTransport | undefined;
    let reservationId: string | undefined;
    let initializedSessionId: string | undefined;
    try {
      const principalId = principalFromRequest(req);
      const clientIdentity = initializeClientIdentity(req, body, route, principalId);
      reservationId = await registry.reserveForInitialize({
        principalId,
        route,
        ...(principalId === 'mcp-bearer-client' ? { enforcePrincipalCapacity: false } : {}),
        ...(sessionId ? { supersedeSessionId: sessionId } : {}),
      });
      if (!reservationId) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(503).json({ error: 'session_capacity', message: 'All MCP sessions are executing active work; retry shortly' });
        return;
      }
      const sessionContext = createMcpToolContext({
        ...baseOptions,
        sessionId: `mcp_${randomUUID().replace(/-/g, '')}`,
        principalId,
      });
      const runtimeSchema = await resolveRuntimeSchema?.(sessionContext);
      let server: ReturnType<typeof createForgeMcpServerFromContext> | undefined;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string): void => {
          registry.commitInitialize(reservationId!, {
            sessionId: newSessionId,
            transport: transport!,
            toolContext: sessionContext,
            route,
            principalId,
            clientIdentity,
            toolSurfaceFingerprint: runtimeSchema?.fingerprint ?? currentToolSurfaceFingerprint(),
            toolNames: runtimeSchema?.toolNames,
            notifyToolListChanged: async () => { await server?.sendToolListChanged(); },
          });
          initializedSessionId = newSessionId;
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) registry.detach(transport.sessionId);
      };
      server = createForgeMcpServerFromContext(sessionContext, runtimeSchema);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      if (initializedSessionId) registry.endPost(initializedSessionId);
      if (reservationId) registry.releaseInitialize(reservationId);
      stats.initializing -= 1;
      stats.activePosts -= 1;
      if (!transport?.sessionId) await transport?.close().catch(() => undefined);
    }
    return;
  }
  if (sessionId) {
    const managed = registry.get(sessionId);
    if (managed && managed.route === route && managed.principalId === principalFromRequest(req)) {
      if (managed.inFlightPosts >= MAX_POSTS_PER_SESSION || stats.activePosts >= MAX_ACTIVE_POSTS) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(429).json({ error: 'session_busy', message: 'Too many MCP requests are active; retry shortly' });
        return;
      }
      registry.beginPost(sessionId);
      stats.activePosts += 1;
      try {
        const currentFingerprint = await resolveMcpSessionCurrentFingerprint(
          currentToolSurfaceFingerprint(),
          resolveRuntimeSchema
            ? async () => (await resolveRuntimeSchema(managed.toolContext))?.fingerprint
            : undefined,
        );
        if (!mcpSessionToolSurfaceFingerprintIsCurrent(managed.toolSurfaceFingerprint, currentFingerprint)) {
          // Keep the transport/session alive long enough for the host to observe
          // the recoverable reset and issue a replacement initialize request.
          // The initialize path explicitly supersedes this session afterward.
          sendMcpToolSurfaceReset(res, managed.toolSurfaceFingerprint, currentFingerprint);
          return;
        }
        if (toolCallOutsideSessionSchema(body, managed.toolNames)) {
          // A call against a newer discovery surface is the same recoverable
          // schema-fence condition. Closing here can make hosts unregister the
          // entire MCP namespace before they can reinitialize it.
          sendMcpToolSurfaceReset(res, managed.toolSurfaceFingerprint, currentFingerprint);
          return;
        }
        await managed.transport.handleRequest(req, res, body);
      } finally {
        registry.endPost(sessionId);
        stats.activePosts -= 1;
      }
      return;
    }
  }
  sendMcpSessionLookupError(res, sessionId);
}

async function handleMcpGet(
  req: Request,
  res: Response,
  registry: HttpSessionRegistry,
  route: McpSessionRoute,
  currentToolSurfaceFingerprint: () => string | undefined,
  resolveRuntimeSchema?: (context: McpToolContext) => Promise<CanonicalRuntimeToolSchema | undefined>,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const managed = sessionId ? registry.get(sessionId) : undefined;
  if (!managed || managed.route !== route || managed.principalId !== principalFromRequest(req)) {
    sendMcpSessionLookupError(res, sessionId);
    return;
  }
  registry.beginStream(sessionId!);
  let released = false;
  const releaseStream = (): void => {
    if (released) return;
    released = true;
    registry.endStream(sessionId!);
  };
  req.once('aborted', releaseStream);
  res.once('close', releaseStream);
  try {
    const currentFingerprint = await resolveMcpSessionCurrentFingerprint(
      currentToolSurfaceFingerprint(),
      resolveRuntimeSchema
        ? async () => (await resolveRuntimeSchema(managed.toolContext))?.fingerprint
        : undefined,
    );
    if (!mcpSessionToolSurfaceFingerprintIsCurrent(managed.toolSurfaceFingerprint, currentFingerprint)) {
      // Preserve the existing SSE transport while asking the host to
      // reinitialize. The replacement initialize owns supersession/cleanup.
      sendMcpToolSurfaceReset(res, managed.toolSurfaceFingerprint, currentFingerprint);
      return;
    }
    await managed.transport.handleRequest(req, res);
  } finally {
    req.off('aborted', releaseStream);
    res.off('close', releaseStream);
    releaseStream();
  }
}

async function handleMcpDelete(req: Request, res: Response, registry: HttpSessionRegistry, route: McpSessionRoute): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const managed = sessionId ? registry.get(sessionId) : undefined;
  if (!managed || managed.route !== route || managed.principalId !== principalFromRequest(req)) {
    sendMcpSessionLookupError(res, sessionId);
    return;
  }
  registry.setPendingCloseReason(sessionId!, 'client_delete');
  await managed.transport.handleRequest(req, res);
  if (registry.get(sessionId!)) await registry.close(sessionId!, 'client_delete');
}

export async function startMcpHttp(opts: McpHttpOptions): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8765;
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const controllerHome = resolveControllerHome(opts.controllerHome);
  const serviceConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const profile = opts.profile ?? serviceConfig?.profile ?? 'controller';
  const authMode = parseMcpHttpAuthMode(opts.auth ?? serviceConfig?.auth?.mode);
  const authToken = opts.authToken ?? readMcpServiceBearerToken(controllerHome, repoRoot);
  const oauthPassphrase = authMode === 'oauth'
    ? readMcpServiceOAuthPassphrase(controllerHome, repoRoot)
    : null;
  const tokenStore = authMode === 'oauth'
    ? new McpOAuthTokenStore(
      mcpServiceOAuthTokenStorePath(controllerHome),
      mcpServiceOAuthTokenStoreFallbackPaths(controllerHome, repoRoot),
    )
    : null;
  tokenStore?.load();
  const oauthProvider = tokenStore ? createMcpOAuthProvider(tokenStore) : null;
  const configuredPublicOrigin = getConfiguredPublicOrigin(serviceConfig);
  const sessionRegistry = new McpSessionRegistry<StreamableHTTPServerTransport, McpToolContext>({
    maximumSessions: MAX_MCP_SESSIONS,
    maximumSessionsPerPrincipal: MAX_MCP_SESSIONS_PER_PRINCIPAL,
    idleTtlMs: MCP_SESSION_IDLE_TTL_MS,
    streamLeaseMs: MCP_STREAM_LEASE_MS,
    absoluteLifetimeMs: MCP_SESSION_ABSOLUTE_LIFETIME_MS,
    activePostStallMs: MCP_ACTIVE_POST_STALL_MS,
  });
  const runtimeStats: McpRuntimeStats = { initializing: 0, activePosts: 0, rejectedOverload: 0 };
  const toolContext = createMcpToolContext({ ...opts, repo: repoRoot, controllerHome, profile });
  const baseOptions: McpServerOptions = {
    repo: repoRoot,
    controllerHome,
    profile,
    toolset: opts.toolset,
    enableChatgptBrowser: opts.enableChatgptBrowser,
    enableDevRunner: opts.enableDevRunner,
    devRunnerAgents: opts.devRunnerAgents,
    devRunnerTimeoutMs: opts.devRunnerTimeoutMs,
    devRunnerMaxTimeoutMs: opts.devRunnerMaxTimeoutMs,
  };
  const runtimeControllerHome = 'controllerHome' in toolContext ? toolContext.controllerHome : undefined;
  const currentRuntimeGeneration = () => runtimeControllerHome ? readRuntimeGeneration(runtimeControllerHome) : undefined;
  const currentRuntimeToolSurfaceFingerprint = () => runtimeControllerHome
    ? readRuntimeStatusSnapshot(runtimeControllerHome)?.toolSurfaceFingerprint
    : undefined;
  let observedRuntimeToolSurfaceFingerprint = currentRuntimeToolSurfaceFingerprint();
  let toolSurfaceNotificationTimer: ReturnType<typeof setTimeout> | undefined;
  const runtimeStatusDirectory = runtimeControllerHome ? dirname(runtimeStatusPath(runtimeControllerHome)) : undefined;
  const runtimeStatusWatcher = runtimeStatusDirectory && existsSync(runtimeStatusDirectory)
    ? watch(runtimeStatusDirectory, { persistent: false }, (_event, filename) => {
      if (String(filename ?? '') !== 'status.json') return;
      if (toolSurfaceNotificationTimer) clearTimeout(toolSurfaceNotificationTimer);
      toolSurfaceNotificationTimer = setTimeout(() => {
        const currentFingerprint = currentRuntimeToolSurfaceFingerprint();
        if (!currentFingerprint || currentFingerprint === observedRuntimeToolSurfaceFingerprint) return;
        observedRuntimeToolSurfaceFingerprint = currentFingerprint;
        void sessionRegistry.notifyToolListChanged(currentFingerprint);
      }, 25);
      toolSurfaceNotificationTimer.unref();
    })
    : undefined;
  runtimeStatusWatcher?.on('error', () => undefined);
  const resolveRuntimeSchema = runtimeControllerHome
    ? async (context: McpToolContext): Promise<CanonicalRuntimeToolSchema | undefined> => {
      if (!('controllerHome' in context)) return undefined;
      return await readCanonicalRuntimeToolSchema(context);
    }
    : undefined;
  const localControllerConfig = {
    enabled: serviceConfig?.localController?.enabled ?? profile === 'controller',
    host: serviceConfig?.localController?.host ?? '127.0.0.1',
    port: serviceConfig?.localController?.port ?? 8766,
  };
  const compatibilityToolDefinitions = buildMcpToolDefinitions(toolContext.policy, { enableChatgptBrowser: opts.enableChatgptBrowser === true });
  const toolSurface = toolContext.policy.profile === 'controller' ? FORGE_TOOL_SURFACE : `${toolContext.policy.profile}-legacy-v1`;
  const toolSurfaceSchemaVersion = toolContext.policy.profile === 'controller' ? FORGE_MCP_SCHEMA_VERSION : 1;
  const forgeVersion = FORGE_VERSION;
  const repoId = toolContext.policy.profile === 'controller' ? undefined : repositoryIdentity(repoRoot);
  const startedAt = new Date().toISOString();
  const localOrigin = `http://${host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const advertisedOrigin = configuredPublicOrigin ?? localOrigin;
  const app = express();
  app.set('trust proxy', 1);

  const controllerHealth = () => {
    if (!('controllerHome' in toolContext)) return null;
    const runtimeGeneration = currentRuntimeGeneration();
    const exposure = controllerExposureSnapshot(toolContext);
    // Health is a bounded diagnostic endpoint, not an MCP discovery authority.
    // Session initialization and invocation obtain a live Runtime tools/list;
    // health only reports the Runtime's published identity.
    const runtimeFingerprint = currentRuntimeToolSurfaceFingerprint();
    return {
      configuredAccessMode: exposure.access.configuredAccessMode,
      effectiveAccessMode: exposure.access.effectiveAccessMode,
      effectiveToolset: exposure.access.effectiveToolset,
      exposureRevision: exposure.access.exposureRevision,
      accessModeSource: exposure.access.source,
      accessModeLastAppliedAt: exposure.access.lastAppliedAt,
      toolset: exposure.access.effectiveToolset,
      toolSurfaceFingerprint: runtimeFingerprint,
      runtimeToolSurfaceFingerprint: runtimeFingerprint,
      toolCount: undefined,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
      runtimeIdentity: runtimeIdentitySnapshot(toolContext),
    };
  };

  app.get('/health', (_req, res) => {
    const health = controllerHealth();
    res.setHeader('x-forge-tool-surface', toolSurface);
    res.setHeader('x-forge-version', String(forgeVersion));
    res.setHeader('x-forge-schema-version', String(toolSurfaceSchemaVersion));
    if (health?.toolset) res.setHeader('x-forge-toolset', health.toolset);
    if (health?.runtimeToolSurfaceFingerprint) res.setHeader('x-forge-runtime-tool-surface-fingerprint', health.runtimeToolSurfaceFingerprint);
    if (health?.toolSurfaceFingerprint) res.setHeader('x-forge-tool-surface-fingerprint', health.toolSurfaceFingerprint);
    const sessionSnapshot = sessionRegistry.snapshot();
    res.json({
      status: 'ok',
      server: 'forge-mcp',
      ...(process.env.FORGE_MCP_INSTANCE_ID
        ? { instanceId: process.env.FORGE_MCP_INSTANCE_ID }
        : {}),
      version: forgeVersion,
      profile: toolContext.policy.profile,
      toolSurface,
      schemaVersion: toolSurfaceSchemaVersion,
      toolSurfaceFingerprint: health?.toolSurfaceFingerprint,
      runtimeToolSurfaceFingerprint: health?.runtimeToolSurfaceFingerprint,
      generation: health?.generation,
      source: health?.source,
      // Deprecated diagnostic alias; not a Runtime schema claim.
      toolset: health?.toolset ?? 'full',
      gatewayToolset: health?.toolset ?? 'full',
      toolCount: health?.toolCount,
      compatibilityToolCount: compatibilityToolDefinitions.length,
      runtimeIdentity: health?.runtimeIdentity,
      configuredAccessMode: health?.configuredAccessMode,
      effectiveAccessMode: health?.effectiveAccessMode,
      effectiveToolset: health?.effectiveToolset,
      accessModeSource: health?.accessModeSource,
      accessModeLastAppliedAt: health?.accessModeLastAppliedAt,
      exposureRevision: health?.exposureRevision,
      ...(repoId ? { repoId } : {}),
      startedAt,
      runner: {
        enabled: toolContext.policy.execution.agentRunner,
        defaultTimeoutMs: toolContext.policy.execution.runnerTimeoutMs,
        maxTimeoutMs: toolContext.policy.execution.runnerMaxTimeoutMs,
      },
      auth: authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'missing') : (authToken ? 'required' : 'missing'),
      mcpEndpoint: `${advertisedOrigin}/mcp`,
      // Grok now completes standard OAuth dynamic registration + PKCE on the
      // canonical MCP resource. Keep /mcp-grok below only as a legacy alias.
      grokEndpoint: `${advertisedOrigin}/mcp`,
      bearerEndpoint: `${advertisedOrigin}/mcp-bearer`,
      sessions: {
        ...sessionSnapshot,
        initializing: runtimeStats.initializing,
        activePosts: runtimeStats.activePosts,
        maximumActivePosts: MAX_ACTIVE_POSTS,
        rejectedOverload: runtimeStats.rejectedOverload,
      },
    });
  });

  app.get('/ready', async (_req, res) => {
    const runtimeGeneration = currentRuntimeGeneration();
    const sessionSnapshot = sessionRegistry.snapshot();
    const sessionCapacityReady = sessionSnapshot.acceptingNewSessions
      && runtimeStats.initializing < MAX_INITIALIZING_SESSIONS
      && runtimeStats.activePosts < MAX_ACTIVE_POSTS;
    if (!runtimeControllerHome) {
      res.status(sessionCapacityReady ? 200 : 503).json({
        ready: sessionCapacityReady,
        profile: toolContext.policy.profile,
        gateway: sessionCapacityReady ? 'ready' : 'saturated',
        controllerDaemon: 'not-required',
        sessionCapacity: sessionSnapshot,
      });
      return;
    }
    const daemon = readForgeRuntimeStatus(runtimeControllerHome);
    const runtimeState = loadMcpServiceRuntimeState(runtimeControllerHome, repoRoot);
    const repositories = listRepositories(runtimeControllerHome).filter((repository) => repository.enabled && !repository.removedAt);
    const projectionSnapshots = repositories.map((repository) => {
      const snapshot = readRepositoryProjectionSnapshot(runtimeControllerHome, repository.repoId);
      const reconciliation = reconcileReadinessProjectionSource(
        snapshot,
        legacyIssueAuthorityRetired(repository.canonicalRoot)
          ? undefined
          : buildControllerTaskLedgerProjection(repository.canonicalRoot),
      );
      return { repoId: repository.repoId, snapshot, reconciliation };
    });
    const staleRepositories = projectionSnapshots
      .filter(({ snapshot }) => snapshot.stale)
      .map(({ repoId }) => repoId);
    const blockingStaleRepositories = projectionSnapshots
      .filter(({ snapshot }) => projectionBlocksReadiness(snapshot))
      .map(({ repoId }) => repoId);
    const sourceMismatches = projectionSnapshots
      .filter(({ reconciliation }) => reconciliation.status === 'mismatch')
      .map(({ repoId, reconciliation }) => ({ repoId, ...reconciliation }));
    const localBridgeHealth = localControllerConfig.enabled
      ? await jsonHealth(localControllerHealthUrl(localControllerConfig.host, localControllerConfig.port))
      : null;
    const localBridgeReady = !localControllerConfig.enabled
      || localControllerDiagnosticMatchesRuntime(localBridgeHealth, runtimeGeneration?.generation);
    const daemonReady = daemon.status === 'ready' && daemon.degraded !== true;
    const projectionReady = blockingStaleRepositories.length === 0;
    const publicConfigured = Boolean(runtimeState?.tunnel?.publicEndpoint);
    const publicReady = !publicConfigured || runtimeState?.tunnel?.healthy === true;
    const connectorReady = !publicConfigured || (
      publicReady
      && runtimeState?.tunnel?.connectorNeedsReconnect !== true
    );
    const ready = daemonReady && projectionReady && localBridgeReady && sessionCapacityReady;
    res.status(ready ? 200 : 503).json({
      ready,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
      gateway: { status: ready ? 'ready' : 'degraded', thin: true, eventLoopIsolatedFromWorkers: true },
      controllerDaemon: daemon,
      localBridge: {
        enabled: localControllerConfig.enabled,
        ready: localBridgeReady,
        endpoint: `http://${localControllerConfig.host === '::1' ? '[::1]' : localControllerConfig.host}:${localControllerConfig.port}/`,
      },
      projections: {
        ready: projectionReady,
        repositoryCount: repositories.length,
        staleRepositories,
        blockingStaleRepositories,
        sourceMismatches,
      },
      publicReadiness: {
        configured: publicConfigured,
        ready: publicReady,
        endpoint: runtimeState?.tunnel?.publicEndpoint,
      },
      connectorReadiness: {
        configured: publicConfigured,
        ready: connectorReady,
        connectorNeedsReconnect: runtimeState?.tunnel?.connectorNeedsReconnect === true,
      },
      sessionCapacity: sessionSnapshot,
    });
  });

  app.get('/repos/:repoId/health', (req, res) => {
    if (!runtimeControllerHome) {
      res.status(404).json({ error: 'controller profile required' });
      return;
    }
    try {
      const repository = getRepository(req.params.repoId, runtimeControllerHome, { includeRemoved: true });
      const projection = readRepositoryProjectionSnapshot(runtimeControllerHome, repository.repoId);
      res.json({
        status: repository.enabled && !repository.removedAt ? 'ok' : 'disabled',
        repository: {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          enabled: repository.enabled,
          removedAt: repository.removedAt,
        },
        projection,
      });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  if (authMode === 'oauth' && oauthProvider) {
    app.use('/authorize', express.urlencoded({ extended: false, limit: '10kb' }));
    app.use('/authorize', oauthTraceMiddleware('authorize'));
    // Reject incomplete OAuth requests before rendering the passphrase form.
    app.use('/authorize', rejectIncompleteOAuthAuthorize);
    app.use('/authorize', requirePassphrase(oauthPassphrase ?? ''));
    app.use('/authorize', oauthAuthorizationHandler(oauthProvider));
    app.use('/token', oauthTraceMiddleware('token'));
    app.use('/token', tokenHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/revoke', oauthTraceMiddleware('revoke'));
    app.use('/revoke', revocationHandler({ provider: oauthProvider, rateLimit: false }));
    app.use('/register', oauthTraceMiddleware('register'));
    app.use('/register', clientRegistrationHandler({ clientsStore: oauthProvider.clientsStore, rateLimit: false }));
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['forge'],
      });
    });
    app.get('/.well-known/openid-configuration', (req, res) => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['forge'],
      });
    });
    const protectedResourceMetadata = (resourcePath: '/mcp' | '/mcp-grok' | '/mcp-bearer') => (req: Request, res: Response): void => {
      const origin = getPublicOrigin(req, configuredPublicOrigin);
      res.json({
        resource: `${origin}${resourcePath}`,
        authorization_servers: [origin],
        scopes_supported: ['forge'],
        bearer_methods_supported: ['header'],
      });
    };
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata('/mcp'));
    app.get('/.well-known/oauth-protected-resource/mcp-grok', protectedResourceMetadata('/mcp-grok'));
    app.get('/.well-known/oauth-protected-resource/mcp-bearer', protectedResourceMetadata('/mcp-bearer'));
  }

  const setMcpResponseHeaders = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('x-forge-tool-surface', toolSurface);
    res.setHeader('x-forge-version', String(forgeVersion));
    res.setHeader('x-forge-schema-version', String(toolSurfaceSchemaVersion));
    next();
  };

  // Primary MCP path: OAuth (or bearer when --auth bearer). Unchanged for ChatGPT.
  app.use('/mcp', setMcpResponseHeaders);
  app.post('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  // Legacy Grok OAuth resource. New Grok connectors should use canonical /mcp.
  app.use('/mcp-grok', setMcpResponseHeaders);
  app.post('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-grok', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp-grok', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp-grok', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin, '/mcp-grok'), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp-grok').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  // Bearer-only MCP path for clients that can send Authorization headers. Never advertises OAuth resource_metadata.
  app.use('/mcp-bearer', setMcpResponseHeaders);
  app.post('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-bearer', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.get('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), (req, res) => {
    handleMcpGet(req, res, sessionRegistry, '/mcp-bearer', currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema).catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });
  app.delete('/mcp-bearer', requireMcpHttpAuth('bearer', authToken, null, configuredPublicOrigin), (req, res) => {
    handleMcpDelete(req, res, sessionRegistry, '/mcp-bearer').catch((error: unknown) => {
      if (!res.headersSent) sendMcpRequestError(res, error);
    });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  const cleanupTimer = setInterval(() => {
    void sessionRegistry.prune();
  }, 60_000);
  cleanupTimer.unref();

  const httpServer = app.listen(port, host);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 120_000;

  httpServer.on('close', () => {
    clearInterval(cleanupTimer);
    if (toolSurfaceNotificationTimer) clearTimeout(toolSurfaceNotificationTimer);
    runtimeStatusWatcher?.close();
    void sessionRegistry.closeAll('shutdown');
  });

  await new Promise<void>((resolve) => {
    httpServer.once('listening', resolve);
  });
  const authLabel = authMode === 'oauth' ? (oauthPassphrase ? 'oauth' : 'oauth-missing') : (authToken ? 'bearer' : 'missing');
  console.error(
    `forge mcp http listening on http://${host}:${port}/mcp (auth: ${authLabel}), http://${host}:${port}/mcp-grok (auth: ${authLabel}), and http://${host}:${port}/mcp-bearer (auth: bearer)`,
  );

  const shutdown = () => {
    void sessionRegistry.closeAll('shutdown');
    tokenStore?.flush();
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
