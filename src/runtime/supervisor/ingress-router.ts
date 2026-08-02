import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import {
  StableIngressSessionStore,
  type StableIngressSessionRoute,
  type StableIngressSessionUpstream,
} from './ingress-session-store';

export interface StableIngressUpstream {
  host: string;
  port: number;
  /** Stable identity for blue/green affinity. Defaults to host:port. */
  key?: string;
}

export interface StableIngressAuthorityObservation {
  term?: string;
  revision?: string;
}

export interface StableIngressRouterOptions {
  host: string;
  port: number;
  rescueHost: string;
  rescuePort: number;
  upstream(): StableIngressUpstream | null;
  authorityObservation?: () => StableIngressAuthorityObservation | undefined;
  sessionStorePath?: string;
  sessionTtlMs?: number;
  maxMcpBodyBytes?: number;
}

export interface StableIngressRouterHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface BufferedResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_MAX_MCP_BODY_BYTES = 1024 * 1024;
const INTERNAL_REQUEST_TIMEOUT_MS = 15_000;

function unavailable(response: ServerResponse): void {
  response.statusCode = 503;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ error: { code: 'RUNTIME_GATEWAY_UNAVAILABLE', message: 'The main Gateway is unavailable; the recovery MCP remains available at /rescue/mcp.' } }));
}

function migrationUnavailable(response: ServerResponse): void {
  response.statusCode = 503;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('retry-after', '1');
  response.end(JSON.stringify({
    error: {
      code: 'MCP_SESSION_MIGRATION_PENDING',
      message: 'The MCP session is moving to the active runtime; retry the same request shortly without reinitializing.',
    },
  }));
}

function targetIdentity(target: StableIngressUpstream): StableIngressSessionUpstream {
  return {
    host: target.host,
    port: target.port,
    key: target.key?.trim() || `${target.host}:${target.port}`,
  };
}

function mcpPath(url: string): boolean {
  const path = url.split('?', 1)[0];
  return path === '/mcp' || path === '/mcp-bearer' || path === '/mcp-grok';
}

function sessionHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers['mcp-session-id'];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isInitializeBody(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { method?: unknown };
    return parsed?.method === 'initialize';
  } catch {
    return false;
  }
}

function forwardedHeaders(
  source: IncomingHttpHeaders,
  target: StableIngressUpstream,
  overrides: Record<string, string | number | undefined> = {},
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    ...source,
    host: `${target.host}:${target.port}`,
    'x-forwarded-host': source['x-forwarded-host'] ?? source.host,
    'x-forwarded-proto': source['x-forwarded-proto'] ?? 'https',
  };
  for (const hopByHop of ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    delete headers[hopByHop];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name.toLowerCase()];
    else headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  target: StableIngressUpstream,
  path: string,
  options: {
    body?: Buffer;
    backendSessionId?: string;
    externalSessionId?: string;
    onResponse?: (statusCode: number, headers: IncomingHttpHeaders) => void;
  } = {},
): void {
  const headers = forwardedHeaders(request.headers, target, {
    ...(options.body ? { 'content-length': options.body.length } : {}),
    ...(options.backendSessionId ? { 'mcp-session-id': options.backendSessionId } : {}),
  });
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: request.method,
    path,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    if (options.externalSessionId) responseHeaders['mcp-session-id'] = options.externalSessionId;
    options.onResponse?.(upstreamResponse.statusCode ?? 502, responseHeaders);
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(0);
  request.once('aborted', () => upstream.destroy());
  response.once('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.once('error', () => {
    if (response.headersSent) response.destroy();
    else unavailable(response);
  });
  if (options.body) upstream.end(options.body);
  else request.pipe(upstream);
}

async function readRequestBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        settled = true;
        request.resume();
        rejectBody(new Error('MCP_REQUEST_BODY_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => {
      if (!settled) resolveBody(Buffer.concat(chunks));
    });
    request.once('error', (error) => {
      if (!settled) rejectBody(error);
    });
  });
}

async function bufferedRequest(input: {
  target: StableIngressUpstream;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
  backendSessionId?: string;
}): Promise<BufferedResponse> {
  return await new Promise<BufferedResponse>((resolveResponse, rejectResponse) => {
    const headers = forwardedHeaders(input.headers, input.target, {
      'content-length': input.body?.length,
      'content-type': input.body ? String(input.headers['content-type'] ?? 'application/json') : undefined,
      'mcp-session-id': input.backendSessionId,
    });
    const upstream = httpRequest({
      host: input.target.host,
      port: input.target.port,
      method: input.method,
      path: input.path,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= DEFAULT_MAX_MCP_BODY_BYTES) chunks.push(buffer);
      });
      response.once('end', () => {
        if (size > DEFAULT_MAX_MCP_BODY_BYTES) {
          rejectResponse(new Error('MCP_INTERNAL_RESPONSE_TOO_LARGE'));
          return;
        }
        resolveResponse({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    upstream.setTimeout(INTERNAL_REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error('MCP_INTERNAL_REQUEST_TIMEOUT')));
    upstream.once('error', rejectResponse);
    upstream.end(input.body);
  });
}

function successful(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

export async function createStableIngressRouter(options: StableIngressRouterOptions): Promise<StableIngressRouterHandle> {
  const store = options.sessionStorePath
    ? new StableIngressSessionStore(options.sessionStorePath, options.sessionTtlMs)
    : undefined;
  const migrationLocks = new Map<string, Promise<StableIngressSessionRoute>>();
  const maxMcpBodyBytes = options.maxMcpBodyBytes ?? DEFAULT_MAX_MCP_BODY_BYTES;

  const migrateSession = async (
    route: StableIngressSessionRoute,
    target: StableIngressUpstream,
    requestHeaders: IncomingHttpHeaders,
    force = false,
  ): Promise<StableIngressSessionRoute> => {
    const targetRecord = targetIdentity(target);
    const latest = store?.get(route.externalSessionId) ?? route;
    if (!force && latest.upstream.key === targetRecord.key) return latest;
    const existing = migrationLocks.get(route.externalSessionId);
    if (existing) return await existing;
    const migration = (async () => {
      const current = store?.get(route.externalSessionId) ?? route;
      if (!force && current.upstream.key === targetRecord.key) return current;
      const initializeBody = Buffer.from(current.initializeBody, 'utf8');
      const initialize = await bufferedRequest({
        target,
        method: 'POST',
        path: current.route,
        headers: {
          ...requestHeaders,
          accept: requestHeaders.accept ?? 'application/json, text/event-stream',
          'content-type': current.contentType,
        },
        body: initializeBody,
      });
      const backendSessionId = sessionHeader(initialize.headers);
      if (!successful(initialize.statusCode) || !backendSessionId) {
        throw new Error(`MCP_SESSION_MIGRATION_INITIALIZE_FAILED status=${initialize.statusCode}`);
      }
      const initializedBody = Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }), 'utf8');
      const initialized = await bufferedRequest({
        target,
        method: 'POST',
        path: current.route,
        headers: {
          ...requestHeaders,
          accept: requestHeaders.accept ?? 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: initializedBody,
        backendSessionId,
      });
      if (!successful(initialized.statusCode)) {
        throw new Error(`MCP_SESSION_MIGRATION_INITIALIZED_FAILED status=${initialized.statusCode}`);
      }
      if (!store) return { ...current, backendSessionId, upstream: targetRecord, updatedAt: new Date().toISOString() };
      return store.put({
        externalSessionId: current.externalSessionId,
        backendSessionId,
        route: current.route,
        initializeBody: current.initializeBody,
        contentType: current.contentType,
        upstream: targetRecord,
        createdAt: current.createdAt,
        expiresAt: current.expiresAt,
      });
    })();
    migrationLocks.set(route.externalSessionId, migration);
    try {
      return await migration;
    } finally {
      if (migrationLocks.get(route.externalSessionId) === migration) migrationLocks.delete(route.externalSessionId);
    }
  };

  const proxyMappedSession = async (input: {
    request: IncomingMessage;
    response: ServerResponse;
    target: StableIngressUpstream;
    url: string;
    body?: Buffer;
    route: StableIngressSessionRoute;
  }): Promise<void> => {
    const attempt = async (route: StableIngressSessionRoute, allowRecovery: boolean): Promise<void> => {
      await new Promise<void>((resolveAttempt) => {
        const headers = forwardedHeaders(input.request.headers, input.target, {
          ...(input.body ? { 'content-length': input.body.length } : {}),
          'mcp-session-id': route.backendSessionId,
        });
        const upstream = httpRequest({
          host: input.target.host,
          port: input.target.port,
          method: input.request.method,
          path: input.url,
          headers,
        }, (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          if (statusCode !== 404 || !allowRecovery) {
            const responseHeaders = { ...upstreamResponse.headers, 'mcp-session-id': route.externalSessionId };
            input.response.writeHead(statusCode, responseHeaders);
            if (input.request.method === 'DELETE' && successful(statusCode)) store?.delete(route.externalSessionId);
            upstreamResponse.pipe(input.response);
            upstreamResponse.once('end', resolveAttempt);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          upstreamResponse.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size <= maxMcpBodyBytes) chunks.push(buffer);
          });
          upstreamResponse.once('end', () => {
            const expiredBody = Buffer.concat(chunks);
            const expired = size <= maxMcpBodyBytes
              && expiredBody.toString('utf8').includes('MCP_SESSION_EXPIRED');
            if (!expired) {
              const responseHeaders = { ...upstreamResponse.headers, 'mcp-session-id': route.externalSessionId };
              input.response.writeHead(statusCode, responseHeaders);
              input.response.end(expiredBody);
              resolveAttempt();
              return;
            }
            void migrateSession(route, input.target, input.request.headers, true)
              .then((refreshed) => attempt(refreshed, false))
              .catch(() => migrationUnavailable(input.response))
              .finally(resolveAttempt);
          });
        });
        upstream.setTimeout(0);
        input.request.once('aborted', () => upstream.destroy());
        input.response.once('close', () => {
          if (!input.response.writableEnded) upstream.destroy();
        });
        upstream.once('error', () => {
          if (input.response.headersSent) input.response.destroy();
          else migrationUnavailable(input.response);
          resolveAttempt();
        });

        upstream.end(input.body);
      });
    };
    await attempt(input.route, true);
  };
  const applyAuthorityObservation = (response: ServerResponse): void => {
    const observation = options.authorityObservation?.();
    if (observation?.term) response.setHeader('x-runtime-authority-term', observation.term);
    if (observation?.revision) response.setHeader('x-runtime-authority-revision', observation.revision);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyAuthorityObservation(response);
    const url = request.url ?? '/';
    if (request.method === 'GET' && url === '/.well-known/oauth-protected-resource/rescue/mcp') {
      const proto = String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
      const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim();
      if (!host) {
        unavailable(response);
        return;
      }
      const origin = `${proto}://${host}`;
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      response.end(JSON.stringify({ resource: `${origin}/rescue/mcp`, authorization_servers: [origin], scopes_supported: ['repo-harness'] }));
      return;
    }
    if (url === '/rescue/health') {
      proxy(request, response, { host: options.rescueHost, port: options.rescuePort }, '/health');
      return;
    }
    if (url === '/rescue/mcp' || url.startsWith('/rescue/mcp?')) {
      proxy(request, response, { host: options.rescueHost, port: options.rescuePort }, url);
      return;
    }
    const target = options.upstream();
    if (!target) {
      unavailable(response);
      return;
    }
    if (!mcpPath(url)) {
      proxy(request, response, target, url);
      return;
    }

    let body: Buffer | undefined;
    if (request.method === 'POST') {
      try {
        body = await readRequestBody(request, maxMcpBodyBytes);
      } catch (error) {
        response.statusCode = error instanceof Error && error.message === 'MCP_REQUEST_BODY_TOO_LARGE' ? 413 : 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { code: 'MCP_REQUEST_BODY_INVALID', message: 'The MCP request body could not be forwarded.' } }));
        return;
      }
    }

    const externalSessionId = sessionHeader(request.headers);
    if (request.method === 'POST' && body && isInitializeBody(body)) {
      proxy(request, response, target, url, {
        body,
        onResponse: (statusCode, headers) => {
          const backendSessionId = sessionHeader(headers);
          if (!store || !successful(statusCode) || !backendSessionId || body!.length > maxMcpBodyBytes) return;
          store.put({
            externalSessionId: backendSessionId,
            backendSessionId,
            route: url,
            initializeBody: body!.toString('utf8'),
            contentType: String(request.headers['content-type'] ?? 'application/json'),
            upstream: targetIdentity(target),
          });
        },
      });
      return;
    }

    let route = externalSessionId ? store?.get(externalSessionId) : undefined;
    if (route) {
      try {
        route = await migrateSession(route, target, request.headers);
      } catch {
        migrationUnavailable(response);
        return;
      }
    }
    if (route) {
      await proxyMappedSession({ request, response, target, url, body, route });
      return;
    }
    proxy(request, response, target, url, {
      body,
      backendSessionId: externalSessionId,
    });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else unavailable(response);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    host: options.host,
    port,
    close: async () => await new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
