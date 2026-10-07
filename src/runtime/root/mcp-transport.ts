import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { Server as NodeHttpServer } from 'http';
import type { AddressInfo } from 'net';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { RuntimeReadiness } from './types';

interface ManagedSession {
  transport: NodeStreamableHTTPServerTransport;
  lastActivityAt: number;
  activePosts: number;
  activeStreams: number;
}

type RuntimeMcpRequestId = string | number;
interface ActiveRuntimeMcpPost {
  response: Response;
  requestIds: RuntimeMcpRequestId[];
  transport?: NodeStreamableHTTPServerTransport;
}

export interface RuntimeMcpSessionSnapshot {
  active: number;
  maximum: number;
  initializing: number;
  protected: number;
  activeRequests: number;
  capacityAvailable: number;
  capacityEvictions: number;
}

export interface RuntimeMcpTransportHandle {
  endpoint: string;
  host: string;
  port: number;
  sessionSnapshot?(): RuntimeMcpSessionSnapshot;
  close(): Promise<void>;
}

export type ForwardedControllerType = 'chatgpt' | 'codex' | 'claude' | 'grok';

export interface StartRuntimeMcpTransportOptions {
  host: string;
  port: number;
  authToken: string;
  readiness: () => RuntimeReadiness;
  createServer: (principalId: string, sessionId?: string, controllerType?: ForwardedControllerType) => Server;
  /**
   * Called immediately before Runtime schema-observing requests are served.
   * The Canonical Runtime uses this to keep its published status projection in
   * sync with the live tool surface without making status.json an authority.
   */
  onToolSurfaceObservation?: () => void;
  onFatal?: (error: Error) => void;
  /** Internal Runtime sessions are bounded even if a Gateway dies without DELETE. */
  maximumSessions?: number;
  /** Test/embedded override; production defaults to the bounded cutover grace. */
  requestDrainTimeoutMs?: number;
}

function authorized(request: Request, configuredToken: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function principalId(token: string): string {
  return `bearer-${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

function isInitialize(body: unknown): boolean {
  const values = Array.isArray(body) ? body : [body];
  return values.some((value) => value && typeof value === 'object'
    && (value as Record<string, unknown>).method === 'initialize');
}

function observesToolSurface(body: unknown): boolean {
  const values = Array.isArray(body) ? body : [body];
  return values.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const method = (value as Record<string, unknown>).method;
    return method === 'initialize' || method === 'tools/list';
  });
}

function runtimeMcpRequestIds(body: unknown): RuntimeMcpRequestId[] {
  const values = Array.isArray(body) ? body : [body];
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' || typeof id === 'number' ? [id] : [];
  });
}

function parseBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try { return JSON.parse(body.toString('utf8')); } catch {
    throw new Error('MCP_REQUEST_JSON_INVALID');
  }
}

function authMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!authorized(req, token)) {
      res.setHeader('www-authenticate', 'Bearer realm="forge-runtime"');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

const SESSION_CLOSE_TIMEOUT_MS = 1_000;
/**
 * Cutover first withdraws admission, then gives already-admitted requests a
 * bounded grace period that still fits inside the primary service stop budget.
 * Requests that outlive it are explicitly settled as outcome-unknown before
 * session/socket teardown, so an outer controller turn is never left waiting on
 * a connection the Runtime is intentionally destroying.
 */
export const RUNTIME_MCP_REQUEST_DRAIN_TIMEOUT_MS = 5_000;
const CUTOVER_SETTLEMENT_DRAIN_TIMEOUT_MS = 250;
export const RUNTIME_MCP_CUTOVER_OUTCOME_UNKNOWN = 'MCP_RUNTIME_CUTOVER_OUTCOME_UNKNOWN';
export const DEFAULT_RUNTIME_MCP_MAX_SESSIONS = 64;

function boundedRuntimeMcpMaximumSessions(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return DEFAULT_RUNTIME_MCP_MAX_SESSIONS;
  return Math.min(value!, DEFAULT_RUNTIME_MCP_MAX_SESSIONS);
}

function closeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    // Stop keep-alive sockets that have no request in flight. Active requests
    // receive a bounded graceful drain before the shutdown path forces them.
    server.closeIdleConnections?.();
  });
}

async function boundedDrain(wait: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let drained = false;
  await Promise.race([
    wait.then(() => { drained = true; }).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return drained;
}

export async function closeRuntimeMcpTransportResources(input: {
  closeListener: () => Promise<void>;
  closeSessions: Array<() => Promise<void>>;
  waitForRequestDrain?: () => Promise<void>;
  settleActiveRequests?: () => void | Promise<void>;
  forceCloseConnections?: () => void;
  requestDrainTimeoutMs?: number;
  sessionCloseTimeoutMs?: number;
}): Promise<void> {
  // Withdraw the listener first so no new request can enter. Existing calls get
  // one bounded grace window. If that expires, settle still-open POST responses
  // as explicit cutover/outcome-unknown before closing session transports. This
  // preserves the no-blind-replay contract while preventing a controller turn
  // from being stranded on a socket the Runtime is about to destroy.
  const listenerClose = input.closeListener();
  void listenerClose.catch(() => undefined);
  const requestDrain = input.waitForRequestDrain?.() ?? Promise.resolve();
  const drained = await boundedDrain(
    requestDrain,
    Math.max(0, input.requestDrainTimeoutMs ?? RUNTIME_MCP_REQUEST_DRAIN_TIMEOUT_MS),
  );
  if (!drained) {
    await input.settleActiveRequests?.();
    await boundedDrain(requestDrain, CUTOVER_SETTLEMENT_DRAIN_TIMEOUT_MS);
  }
  const sessionDrain = Promise.allSettled(input.closeSessions.map(async (close) => await close()));
  await boundedDrain(sessionDrain.then(() => undefined), Math.max(0, input.sessionCloseTimeoutMs ?? SESSION_CLOSE_TIMEOUT_MS));
  input.forceCloseConnections?.();
  await listenerClose;
}

export async function startRuntimeMcpTransport(
  options: StartRuntimeMcpTransportOptions,
): Promise<RuntimeMcpTransportHandle> {
  if (!options.authToken.trim()) throw new Error('MCP_AUTH_TOKEN_REQUIRED');
  const sessions = new Map<string, ManagedSession>();
  const maximumSessions = boundedRuntimeMcpMaximumSessions(options.maximumSessions);
  let initializingSessions = 0;
  let capacityEvictions = 0;
  let activeRequests = 0;
  const activePosts = new Map<Response, ActiveRuntimeMcpPost>();

  const sessionSnapshot = (): RuntimeMcpSessionSnapshot => ({
    active: sessions.size,
    maximum: maximumSessions,
    initializing: initializingSessions,
    protected: [...sessions.values()].filter((session) => session.activePosts > 0).length,
    activeRequests,
    capacityAvailable: Math.max(0, maximumSessions - sessions.size - initializingSessions),
    capacityEvictions,
  });

  const reserveInitialize = async (): Promise<boolean> => {
    while (sessions.size + initializingSessions >= maximumSessions) {
      const victim = [...sessions.entries()]
        .filter(([, session]) => session.activePosts === 0)
        .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt)[0];
      if (!victim) return false;
      sessions.delete(victim[0]);
      capacityEvictions += 1;
      await victim[1].transport.close().catch(() => undefined);
    }
    initializingSessions += 1;
    return true;
  };

  const withManagedSessionRequest = async <T>(
    managed: ManagedSession,
    kind: 'post' | 'stream',
    action: () => Promise<T>,
  ): Promise<T> => {
    if (kind === 'post') managed.activePosts += 1;
    else managed.activeStreams += 1;
    managed.lastActivityAt = Date.now();
    try {
      return await action();
    } finally {
      if (kind === 'post') managed.activePosts = Math.max(0, managed.activePosts - 1);
      else managed.activeStreams = Math.max(0, managed.activeStreams - 1);
      managed.lastActivityAt = Date.now();
    }
  };
  const postDrainWaiters = new Set<() => void>();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    activeRequests += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    res.once('finish', settle);
    res.once('close', settle);
    next();
  });
  // Only POST requests can represent an in-flight tool mutation/read result that
  // must settle before cutover. Long-lived GET/SSE streams are transport-only and
  // must not consume the cutover grace window.
  const waitForRequestDrain = (): Promise<void> => activePosts.size === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => postDrainWaiters.add(resolve));
  app.get('/ready', (_req, res) => {
    const readiness = options.readiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  const requireAuth = authMiddleware(options.authToken);
  app.post('/mcp', requireAuth, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const activePost: ActiveRuntimeMcpPost = { response: res, requestIds: [] };
    activePosts.set(res, activePost);
    const releasePostResponse = (): void => {
      activePosts.delete(res);
      if (activePosts.size === 0) {
        for (const resolve of postDrainWaiters) resolve();
        postDrainWaiters.clear();
      }
    };
    res.once('finish', releasePostResponse);
    res.once('close', releasePostResponse);
    void (async () => {
      let body: unknown;
      try { body = parseBody(req.body); } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      activePost.requestIds = runtimeMcpRequestIds(body);
      if (observesToolSurface(body)) options.onToolSurfaceObservation?.();
      const requestedSessionId = req.headers['mcp-session-id'];
      const sessionId = typeof requestedSessionId === 'string' ? requestedSessionId : undefined;
      if (isInitialize(body)) {
        if (!await reserveInitialize()) {
          res.status(503).json({ error: 'mcp_session_capacity_exhausted' });
          return;
        }
        let transport: NodeStreamableHTTPServerTransport;
        let committedSessionId: string | undefined;
        const forwardedPrincipalId = typeof req.headers['x-forge-forwarded-principal-id'] === 'string'
          ? req.headers['x-forge-forwarded-principal-id'].trim().slice(0, 512)
          : '';
        const forwardedSessionId = typeof req.headers['x-forge-forwarded-session-id'] === 'string'
          ? req.headers['x-forge-forwarded-session-id'].trim().slice(0, 512)
          : '';
        const forwardedControllerTypeRaw = typeof req.headers['x-forge-forwarded-controller-type'] === 'string'
          ? req.headers['x-forge-forwarded-controller-type'].trim().toLowerCase()
          : '';
        const forwardedControllerType = ['chatgpt', 'codex', 'claude', 'grok'].includes(forwardedControllerTypeRaw)
          ? forwardedControllerTypeRaw as ForwardedControllerType
          : undefined;
        const principal = forwardedPrincipalId || principalId(options.authToken);
        const server = options.createServer(principal, forwardedSessionId || undefined, forwardedControllerType);
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            committedSessionId = createdSessionId;
            initializingSessions = Math.max(0, initializingSessions - 1);
            sessions.set(createdSessionId, {
              transport,
              lastActivityAt: Date.now(),
              // Initialize is a POST and must not be reclaimed before it settles.
              activePosts: 1,
              activeStreams: 0,
            });
          },
        });
        activePost.transport = transport;
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (error) {
          await transport.close().catch(() => undefined);
          if (!res.headersSent) res.status(500).json({ error: 'mcp_initialize_failed' });
          throw error;
        } finally {
          if (committedSessionId) {
            const committed = sessions.get(committedSessionId);
            if (committed) {
              committed.activePosts = Math.max(0, committed.activePosts - 1);
              committed.lastActivityAt = Date.now();
            }
          } else {
            initializingSessions = Math.max(0, initializingSessions - 1);
          }
        }
        return;
      }
      const managed = sessionId ? sessions.get(sessionId) : undefined;
      if (!managed) {
        res.status(404).json({ error: 'mcp_session_not_found' });
        return;
      }
      activePost.transport = managed.transport;
      await withManagedSessionRequest(managed, 'post', async () => await managed.transport.handleRequest(req, res, body));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
      console.error('[forge-runtime mcp] request failed:', error);
    }).finally(() => {
      releasePostResponse();
      res.off('finish', releasePostResponse);
      res.off('close', releasePostResponse);
    });
  });
  app.get('/mcp', requireAuth, (req, res) => {
    void (async () => {
      const raw = req.headers['mcp-session-id'];
      const sessionId = typeof raw === 'string' ? raw : undefined;
      const managed = sessionId ? sessions.get(sessionId) : undefined;
      if (!managed) {
        res.status(404).json({ error: 'mcp_session_not_found' });
        return;
      }
      await withManagedSessionRequest(managed, 'stream', async () => await managed.transport.handleRequest(req, res));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
      console.error('[forge-runtime mcp] stream request failed:', error);
    });
  });
  app.delete('/mcp', requireAuth, (req, res) => {
    void (async () => {
      const raw = req.headers['mcp-session-id'];
      const sessionId = typeof raw === 'string' ? raw : undefined;
      const managed = sessionId ? sessions.get(sessionId) : undefined;
      if (!managed) {
        res.status(404).json({ error: 'mcp_session_not_found' });
        return;
      }
      await withManagedSessionRequest(managed, 'post', async () => {
        await managed.transport.handleRequest(req, res);
        await managed.transport.close();
      });
      sessions.delete(sessionId!);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
      console.error('[forge-runtime mcp] delete request failed:', error);
    });
  });

  const httpServer = app.listen(options.port, options.host);
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    httpServer.once('listening', onListening);
    httpServer.once('error', onError);
  });
  httpServer.on('error', (error) => options.onFatal?.(error));
  const address = httpServer.address() as AddressInfo | null;
  if (!address) throw new Error('MCP_LISTENER_ADDRESS_UNAVAILABLE');
  const endpointHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const endpoint = `http://${endpointHost.includes(':') ? `[${endpointHost}]` : endpointHost}:${address.port}/mcp`;

  return {
    endpoint,
    host: options.host,
    port: address.port,
    sessionSnapshot,
    close: async () => {
      await closeRuntimeMcpTransportResources({
        closeListener: async () => await closeServer(httpServer),
        waitForRequestDrain,
        requestDrainTimeoutMs: options.requestDrainTimeoutMs,
        // Snapshot sessions only after the request drain: an initialize request
        // already in flight may register its session while shutdown is starting.
        closeSessions: [async () => {
          const activeSessions = [...sessions.values()];
          await Promise.allSettled(activeSessions.map(async ({ transport }) => await transport.close().catch(() => undefined)));
          sessions.clear();
        }],
        settleActiveRequests: async () => {
          for (const active of activePosts.values()) {
            let protocolSettled = false;
            if (active.transport && active.requestIds.length > 0) {
              const outcomes = await Promise.allSettled(active.requestIds.map(async (id) => {
                await active.transport!.send({
                  jsonrpc: '2.0',
                  id,
                  error: {
                    code: -32000,
                    message: RUNTIME_MCP_CUTOVER_OUTCOME_UNKNOWN,
                    data: {
                      outcome: 'unknown',
                      recoverable: true,
                      retryable: false,
                      action: 'reconcile',
                    },
                  },
                });
              }));
              protocolSettled = outcomes.some((outcome) => outcome.status === 'fulfilled');
            }
            if (protocolSettled) continue;
            const response = active.response;
            if (response.destroyed || response.writableEnded || response.headersSent) continue;
            response.status(409).json({
              error: 'runtime_cutover_outcome_unknown',
              code: RUNTIME_MCP_CUTOVER_OUTCOME_UNKNOWN,
              message: 'Canonical Runtime entered cutover after this request was admitted. The request outcome is unknown; reconcile by request/effect identity before any retry.',
              recoverable: true,
              retryable: false,
              action: 'reconcile',
            });
          }
        },
        forceCloseConnections: () => httpServer.closeAllConnections?.(),
      });
    },
  };
}
