import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { Server as NodeHttpServer } from 'http';
import type { AddressInfo } from 'net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RuntimeReadiness } from './types';

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
}

export interface RuntimeMcpTransportHandle {
  endpoint: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export type ForwardedControllerType = 'chatgpt' | 'codex' | 'claude' | 'grok';

export interface StartRuntimeMcpTransportOptions {
  host: string;
  port: number;
  authToken: string;
  readiness: () => RuntimeReadiness;
  createServer: (principalId: string, sessionId?: string, controllerType?: ForwardedControllerType) => Server;
  onFatal?: (error: Error) => void;
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
const REQUEST_DRAIN_TIMEOUT_MS = 250;

function closeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    // Stop keep-alive sockets that have no request in flight. Active requests
    // receive a bounded graceful drain before the shutdown path forces them.
    server.closeIdleConnections?.();
  });
}

function boundedDrain(wait: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return Promise.race([
    wait.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function closeRuntimeMcpTransportResources(input: {
  closeListener: () => Promise<void>;
  closeSessions: Array<() => Promise<void>>;
  waitForRequestDrain?: () => Promise<void>;
  forceCloseConnections?: () => void;
  requestDrainTimeoutMs?: number;
  sessionCloseTimeoutMs?: number;
}): Promise<void> {
  // Withdraw the TCP listener first so no new request can enter. Allow ordinary
  // short MCP calls to finish before closing their session transport; long SSE
  // streams remain bounded and are force-closed after the drain window.
  const listenerClose = input.closeListener();
  void listenerClose.catch(() => undefined);
  await boundedDrain(
    input.waitForRequestDrain?.() ?? Promise.resolve(),
    Math.max(0, input.requestDrainTimeoutMs ?? REQUEST_DRAIN_TIMEOUT_MS),
  );
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
  let activeRequests = 0;
  const requestDrainWaiters = new Set<() => void>();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    activeRequests += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests === 0) {
        for (const resolve of requestDrainWaiters) resolve();
        requestDrainWaiters.clear();
      }
    };
    res.once('finish', settle);
    res.once('close', settle);
    next();
  });
  const waitForRequestDrain = (): Promise<void> => activeRequests === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => requestDrainWaiters.add(resolve));
  app.get('/ready', (_req, res) => {
    const readiness = options.readiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  const requireAuth = authMiddleware(options.authToken);
  app.post('/mcp', requireAuth, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    void (async () => {
      let body: unknown;
      try { body = parseBody(req.body); } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const requestedSessionId = req.headers['mcp-session-id'];
      const sessionId = typeof requestedSessionId === 'string' ? requestedSessionId : undefined;
      if (isInitialize(body)) {
        let transport: StreamableHTTPServerTransport;
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
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            sessions.set(createdSessionId, { transport });
          },
        });
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
        }
        return;
      }
      const managed = sessionId ? sessions.get(sessionId) : undefined;
      if (!managed) {
        res.status(404).json({ error: 'mcp_session_not_found' });
        return;
      }
      await managed.transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
      console.error('[forge-runtime mcp] request failed:', error);
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
      await managed.transport.handleRequest(req, res);
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
      await managed.transport.handleRequest(req, res);
      await managed.transport.close();
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
    close: async () => {
      await closeRuntimeMcpTransportResources({
        closeListener: async () => await closeServer(httpServer),
        waitForRequestDrain,
        // Snapshot sessions only after the request drain: an initialize request
        // already in flight may register its session while shutdown is starting.
        closeSessions: [async () => {
          const activeSessions = [...sessions.values()];
          await Promise.allSettled(activeSessions.map(async ({ transport }) => await transport.close().catch(() => undefined)));
          sessions.clear();
        }],
        forceCloseConnections: () => httpServer.closeAllConnections?.(),
      });
    },
  };
}
