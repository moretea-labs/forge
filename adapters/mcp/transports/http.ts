import { randomUUID } from 'crypto';
import { existsSync, watch } from 'fs';
import { dirname } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest, type McpRequestContext } from "@modelcontextprotocol/server";
import { InvalidTokenError } from "@modelcontextprotocol/server-legacy/auth";
import {
  buildMultiRepositoryToolDefinitions,
  createCanonicalRuntimeProxy,
  createMcpToolContext,
  createForgeMcpServerFromContext,
  readCanonicalRuntimeToolSchema,
  type CanonicalRuntimeProxy,
  type CanonicalRuntimeToolSchema,
  type McpServerOptions,
} from '../server';
import {
  loadMcpServiceLocalConfig,
  mcpServiceOAuthTokenStoreFallbackPaths,
  mcpServiceOAuthTokenStorePath,
  parseMcpHttpAuthMode,
  readMcpServiceBearerToken,
  readMcpServiceOAuthPassphrase,
  type McpHttpAuthMode,
} from '../auth';
import { createMcpOAuthProvider, McpOAuthTokenStore } from '../oauth';
import { resolveMcpRepoRoot } from '../repo';
import { resolveControllerHome } from '../../../src/cli/repositories/controller-home';
import { invalidateExecutionSession } from '../../../src/runtime/control-plane/execution/session-store';
import { readRuntimeGeneration } from '../../../src/runtime/control-plane/runtime-generation';
import { readRuntimeStatusSnapshot, runtimeStatusPath } from '../../../src/runtime/root/status';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
} from '../../../src/cli/controller/runtime-config';
import { McpSessionRegistry, type McpSessionRoute } from './session-registry';
import { getConfiguredPublicOrigin, getPublicOrigin, registerMcpOAuthHttpRoutes } from './oauth-http';
import { registerMcpHttpObservationRoutes } from './http-observation';
export { isAllowedMcpOAuthRedirectUri, isIncompleteOAuthAuthorizeRequest } from './oauth-http';
import {
  connectionIdentity,
  ensureForgeInstanceIdentity,
  principal,
  type ForgeInstanceIdentity,
  type Principal,
} from '../../../packages/kernel/identity/api/index';

export interface McpHttpOptions extends McpServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  auth?: string;
}

function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function principalIdentityFromRequest(req: Request): Principal {
  const auth = (req as unknown as { auth?: { clientId?: string } }).auth;
  if (auth?.clientId?.trim()) return principal(`oauth-client:${auth.clientId.trim()}`, 'oauth_client', 'mcp-oauth');
  return bearerFromRequest(req)
    ? principal('mcp-bearer-client', 'bearer_client', 'mcp-bearer')
    : principal('controller-http-client', 'controller', 'mcp-http');
}

function principalFromRequest(req: Request): string {
  return principalIdentityFromRequest(req).principalId;
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

export function isMcpToolsListRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length > 0 && messages.every((message) => {
    if (!message || typeof message !== 'object') return false;
    return (message as { method?: unknown }).method === 'tools/list';
  });
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
    if (mode === 'none') {
      next();
      return;
    }

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
const MAX_MCP_SESSIONS_PER_PRINCIPAL = positiveIntegerEnv('FORGE_MCP_MAX_SESSIONS_PER_PRINCIPAL', MAX_MCP_SESSIONS);
const MAX_INITIALIZING_SESSIONS = positiveIntegerEnv('FORGE_MCP_MAX_INITIALIZING_SESSIONS', 8);
const MAX_POSTS_PER_SESSION = positiveIntegerEnv('FORGE_MCP_MAX_POSTS_PER_SESSION', 4);
const MAX_ACTIVE_POSTS = positiveIntegerEnv('FORGE_MCP_MAX_ACTIVE_POSTS', 32);
const MCP_SESSION_IDLE_TTL_MS = positiveIntegerEnv('FORGE_MCP_SESSION_IDLE_TTL_MS', 15 * 60_000);
const MCP_STREAM_LEASE_MS = positiveIntegerEnv('FORGE_MCP_STREAM_LEASE_MS', 30 * 60_000);
const MCP_SESSION_ABSOLUTE_LIFETIME_MS = positiveIntegerEnv('FORGE_MCP_SESSION_ABSOLUTE_LIFETIME_MS', 2 * 60 * 60_000);
const MCP_ACTIVE_POST_STALL_MS = positiveIntegerEnv('FORGE_MCP_ACTIVE_POST_STALL_MS', 10 * 60_000);

type McpToolContext = ReturnType<typeof createMcpToolContext>;
type HttpSessionRegistry = McpSessionRegistry<NodeStreamableHTTPServerTransport, McpToolContext>;

function principalIdFromModernRequestContext(context: McpRequestContext): string {
  const clientId = context.authInfo?.clientId?.trim();
  if (clientId) return `oauth-client:${clientId}`;
  const authorization = context.requestInfo?.headers.get('authorization')?.trim() ?? '';
  return /^Bearer\s+/i.test(authorization) ? 'mcp-bearer-client' : 'controller-http-client';
}

function createModernMcpHttpHandler(
  baseOptions: McpServerOptions,
  resolveRuntimeSchema?: (context: McpToolContext) => Promise<CanonicalRuntimeToolSchema | undefined>,
  sharedRuntimeProxy?: CanonicalRuntimeProxy,
): { handler: ReturnType<typeof createMcpHandler>; nodeHandler: NodeMcpRequestHandler } {
  const handler = createMcpHandler(async (requestContext) => {
    const toolContext = createMcpToolContext({
      ...baseOptions,
      principalId: principalIdFromModernRequestContext(requestContext),
    });
    const runtimeSchema = await resolveRuntimeSchema?.(toolContext);
    return createForgeMcpServerFromContext(toolContext, runtimeSchema, sharedRuntimeProxy);
  }, {
    legacy: 'reject',
    responseMode: 'auto',
  });
  return { handler, nodeHandler: toNodeHandler(handler) };
}

async function handleMcpPost(
  req: Request,
  res: Response,
  baseOptions: McpServerOptions,
  registry: HttpSessionRegistry,
  stats: McpRuntimeStats,
  route: McpSessionRoute,
  forgeInstance: ForgeInstanceIdentity,
  currentToolSurfaceFingerprint: () => string | undefined,
  resolveRuntimeSchema?: (context: McpToolContext) => Promise<CanonicalRuntimeToolSchema | undefined>,
  sharedRuntimeProxy?: CanonicalRuntimeProxy,
  modernHandler?: NodeMcpRequestHandler,
): Promise<void> {
  let body: unknown;
  try {
    body = rawBodyToJson(req.body as Buffer);
  } catch (_error) {
    res.status(400).json({ error: 'invalid JSON request body' });
    return;
  }
  if (modernHandler) {
    const webRequest = await toWebRequest(req, body);
    if (!(await isLegacyRequest(webRequest, body))) {
      await modernHandler(req, res, body);
      return;
    }
  }
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (isInitializeRequest(body)) {
    if (sessionId) {
      res.setHeader('Mcp-Session-Reset', 'reinitialized');
      res.setHeader('x-forge-session-reset', 'reinitialized');
    }
    if (stats.initializing >= MAX_INITIALIZING_SESSIONS || stats.activePosts >= MAX_ACTIVE_POSTS) {
      stats.rejectedOverload += 1;
      res.setHeader('retry-after', '1');
      res.status(503).json({
        error: 'server_busy',
        code: 'MCP_SERVER_BUSY',
        message: 'Too many MCP sessions are initializing; retry shortly',
        recoverable: true,
        retryable: true,
        sessionPreserved: true,
        action: 'retry',
      });
      return;
    }
    stats.initializing += 1;
    stats.activePosts += 1;
    let transport: NodeStreamableHTTPServerTransport | undefined;
    let reservationId: string | undefined;
    let initializedSessionId: string | undefined;
    try {
      const principalIdentity = principalIdentityFromRequest(req);
      const principalId = principalIdentity.principalId;
      const connection = connectionIdentity({
        instance: forgeInstance,
        adapterId: 'mcp-http',
        principal: principalIdentity,
      });
      const clientIdentity = initializeClientIdentity(req, body, route, principalId);
      reservationId = await registry.reserveForInitialize({
        principalId,
        connectionId: connection.connectionId,
        route,
        ...(principalId === 'mcp-bearer-client' ? { enforcePrincipalCapacity: false } : {}),
        ...(sessionId ? { supersedeSessionId: sessionId } : {}),
      });
      if (!reservationId) {
        stats.rejectedOverload += 1;
        res.setHeader('retry-after', '1');
        res.status(503).json({
          error: 'session_capacity',
          code: 'MCP_SESSION_CAPACITY',
          message: 'All MCP sessions are executing active requests; retry shortly',
          recoverable: true,
          retryable: true,
          sessionPreserved: true,
          action: 'retry',
        });
        return;
      }
      const sessionContext = createMcpToolContext({
        ...baseOptions,
        sessionId: `mcp_${randomUUID().replace(/-/g, '')}`,
        principalId,
      });
      let runtimeSchema = await resolveRuntimeSchema?.(sessionContext);
      let server: ReturnType<typeof createForgeMcpServerFromContext> | undefined;
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string): void => {
          registry.commitInitialize(reservationId!, {
            sessionId: newSessionId,
            transport: transport!,
            toolContext: sessionContext,
            route,
            principalId,
            connectionId: connection.connectionId,
            clientIdentity,
            toolSurfaceFingerprint: runtimeSchema?.fingerprint ?? currentToolSurfaceFingerprint(),
            toolNames: runtimeSchema?.toolNames,
            notifyToolListChanged: async () => { await server?.sendToolListChanged(); },
            ...(runtimeSchema && resolveRuntimeSchema
              ? {
                  refreshToolSurface: async () => {
                    const refreshed = await resolveRuntimeSchema(sessionContext);
                    if (!refreshed || !runtimeSchema) return undefined;
                    runtimeSchema.definitions = refreshed.definitions;
                    runtimeSchema.toolNames = refreshed.toolNames;
                    runtimeSchema.fingerprint = refreshed.fingerprint;
                    return {
                      toolSurfaceFingerprint: refreshed.fingerprint,
                      toolNames: refreshed.toolNames,
                    };
                  },
                }
              : {}),
          });
          initializedSessionId = newSessionId;
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) registry.detach(transport.sessionId);
      };
      server = createForgeMcpServerFromContext(sessionContext, runtimeSchema, sharedRuntimeProxy);
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
          // Standard MCP hot refresh: allow an explicitly requested tools/list
          // to replace the live session's mutable Runtime schema snapshot. Hosts
          // that ignore list_changed and call directly still hit the reset fence.
          if (isMcpToolsListRequest(body)) {
            const refreshed = await registry.refreshToolSurface(sessionId);
            if (refreshed
              && (!currentFingerprint || refreshed.toolSurfaceFingerprint === currentFingerprint)) {
              await managed.transport.handleRequest(req, res, body);
              return;
            }
          }
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
  const controllerHome = resolveControllerHome(opts.controllerHome);
  const forgeInstance = ensureForgeInstanceIdentity({
    controllerHome,
    preferredInstanceId: process.env.FORGE_INSTANCE_ID?.trim(),
  });
  const serviceConfig = loadMcpServiceLocalConfig(controllerHome);
  const configuredForgeInstanceId = serviceConfig?.identity?.forgeInstanceId?.trim();
  if (configuredForgeInstanceId && configuredForgeInstanceId !== forgeInstance.instanceId) {
    throw new Error(`MCP_FORGE_INSTANCE_ID_MISMATCH: config=${configuredForgeInstanceId} kernel=${forgeInstance.instanceId}`);
  }
  const profile = opts.profile ?? serviceConfig?.profile ?? 'controller';
  // A controller Gateway can serve registered repositories without selecting
  // one at startup. Do not turn its launchd working directory into an
  // implicit repository, especially for package Runtime snapshots.
  const repoRoot = profile === 'controller' && !opts.repo?.trim()
    ? undefined
    : resolveMcpRepoRoot(opts.repo ?? '.');
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
  const sessionRegistry = new McpSessionRegistry<NodeStreamableHTTPServerTransport, McpToolContext>({
    maximumSessions: MAX_MCP_SESSIONS,
    maximumSessionsPerPrincipal: MAX_MCP_SESSIONS_PER_PRINCIPAL,
    idleTtlMs: MCP_SESSION_IDLE_TTL_MS,
    streamLeaseMs: MCP_STREAM_LEASE_MS,
    absoluteLifetimeMs: MCP_SESSION_ABSOLUTE_LIFETIME_MS,
    activePostStallMs: MCP_ACTIVE_POST_STALL_MS,
    onSessionClosed: (session, reason) => {
      const context = session.toolContext;
      if (!('controllerHome' in context) || typeof context.controllerHome !== 'string') return;
      const executionSessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
      if (!executionSessionId) return;
      invalidateExecutionSession(
        context.controllerHome,
        executionSessionId,
        `mcp_transport_${reason}`,
      );
    },
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
  const sharedRuntimeProxy = runtimeControllerHome && 'controllerHome' in toolContext && !toolContext.runtimeSourceRoot
    ? createCanonicalRuntimeProxy(toolContext)
    : undefined;
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
      return await readCanonicalRuntimeToolSchema(context, sharedRuntimeProxy);
    }
    : undefined;
  const toolSurface = toolContext.policy.profile === 'controller' ? FORGE_TOOL_SURFACE : `${toolContext.policy.profile}-legacy-v1`;
  const toolSurfaceSchemaVersion = toolContext.policy.profile === 'controller' ? FORGE_MCP_SCHEMA_VERSION : 1;
  const forgeVersion = FORGE_VERSION;
  const app = express();
  app.set('trust proxy', 1);

  registerMcpHttpObservationRoutes({
    app,
    toolContext,
    sessionRegistry,
    runtimeStats,
    runtimeControllerHome,
    repoRoot,
    forgeInstanceId: forgeInstance.instanceId,
    currentRuntimeToolSurfaceFingerprint,
    toolSurface,
    toolSurfaceSchemaVersion,
    forgeVersion,
    authMode,
    authTokenConfigured: Boolean(authToken),
    oauthPassphraseConfigured: Boolean(oauthPassphrase),
    oauthAuthorizationCodeDiagnostics: oauthProvider ? () => oauthProvider.authorizationCodeDiagnostics() : undefined,
    configuredPublicOrigin,
    host,
    port,
    enableChatgptBrowser: opts.enableChatgptBrowser === true,
    localController: {
      enabled: serviceConfig?.localController?.enabled ?? profile === 'controller',
      host: serviceConfig?.localController?.host ?? '127.0.0.1',
      port: serviceConfig?.localController?.port ?? 8766,
    },
    maxInitializingSessions: MAX_INITIALIZING_SESSIONS,
    maxActivePosts: MAX_ACTIVE_POSTS,
  });

  if (authMode === 'oauth' && oauthProvider) {
    registerMcpOAuthHttpRoutes(app, oauthProvider, oauthPassphrase ?? '', configuredPublicOrigin);
  }

  const setMcpResponseHeaders = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('x-forge-tool-surface', toolSurface);
    res.setHeader('x-forge-version', String(forgeVersion));
    res.setHeader('x-forge-schema-version', String(toolSurfaceSchemaVersion));
    next();
  };

  // Modern MCP 2026-07-28 is the canonical public serving boundary. The SDK
  // owns protocol-era classification and serves modern requests without
  // Mcp-Session-Id. Existing 2025-era traffic is routed explicitly to the
  // bounded stateful compatibility path below.
  const modernMcp = createModernMcpHttpHandler(baseOptions, resolveRuntimeSchema, sharedRuntimeProxy);

  // Primary MCP path: OAuth (or bearer when --auth bearer).
  app.use('/mcp', setMcpResponseHeaders);
  app.post('/mcp', requireMcpHttpAuth(authMode, authToken, oauthProvider, configuredPublicOrigin), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp', forgeInstance, currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema, sharedRuntimeProxy, modernMcp.nodeHandler).catch((error: unknown) => {
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
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-grok', forgeInstance, currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema, sharedRuntimeProxy, modernMcp.nodeHandler).catch((error: unknown) => {
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
    handleMcpPost(req, res, baseOptions, sessionRegistry, runtimeStats, '/mcp-bearer', forgeInstance, currentRuntimeToolSurfaceFingerprint, resolveRuntimeSchema, sharedRuntimeProxy, modernMcp.nodeHandler).catch((error: unknown) => {
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
    void modernMcp.handler.close();
    void sharedRuntimeProxy?.close();
  });

  await new Promise<void>((resolve) => {
    httpServer.once('listening', resolve);
  });
  const authLabel = authMode === 'oauth'
    ? (oauthPassphrase ? 'oauth' : 'oauth-missing')
    : authMode === 'bearer'
      ? (authToken ? 'bearer' : 'missing')
      : 'none';
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
