import { createServer, type IncomingMessage, type ServerResponse } from 'http';

export interface FetchHttpServer {
  readonly port: number;
  stop(force?: boolean): void;
}

export interface FetchHttpServerOptions {
  hostname?: string;
  port?: number;
  maxRequestBytes?: number;
  fetch(request: Request): Response | Promise<Response>;
}

async function requestBody(request: IncomingMessage, maxRequestBytes: number): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) throw new Error('FETCH_HTTP_REQUEST_TOO_LARGE');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxRequestBytes) throw new Error('FETCH_HTTP_REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  const combined = Buffer.concat(chunks);
  const copy = new Uint8Array(combined.byteLength);
  copy.set(combined);
  return copy.buffer;
}

async function toFetchRequest(request: IncomingMessage, hostname: string, maxRequestBytes: number): Promise<Request> {
  const authority = request.headers.host?.trim() || hostname;
  const url = new URL(request.url || '/', `http://${authority}`);
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) for (const value of raw) headers.append(name, value);
    else headers.set(name, raw);
  }
  const requestBodyBuffer = await requestBody(request, maxRequestBytes);
  return new Request(url, {
    method: request.method || 'GET',
    headers,
    ...(requestBodyBuffer ? { body: requestBodyBuffer } : {}),
  });
}

async function writeFetchResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  if (!response.body) { target.end(); return; }
  const body = Buffer.from(await response.arrayBuffer());
  target.end(body);
}

export async function serveFetchHttp(input: FetchHttpServerOptions): Promise<FetchHttpServer> {
  const hostname = input.hostname ?? '127.0.0.1';
  const maxRequestBytes = Math.max(1_024, Math.min(input.maxRequestBytes ?? 1_048_576, 16_777_216));
  const server = createServer(async (nodeRequest, nodeResponse) => {
    try {
      const request = await toFetchRequest(nodeRequest, hostname, maxRequestBytes);
      await writeFetchResponse(await input.fetch(request), nodeResponse);
    } catch (error) {
      if (nodeResponse.headersSent) { nodeResponse.destroy(); return; }
      const tooLarge = error instanceof Error && error.message === 'FETCH_HTTP_REQUEST_TOO_LARGE';
      nodeResponse.statusCode = tooLarge ? 413 : 500;
      nodeResponse.setHeader('content-type', 'application/json; charset=utf-8');
      nodeResponse.end(JSON.stringify({ error: { code: tooLarge ? 'REQUEST_TOO_LARGE' : 'LOCAL_HTTP_HANDLER_FAILED' } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(input.port ?? 0, hostname);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('FETCH_HTTP_LISTENER_ADDRESS_UNAVAILABLE'); }
  return {
    port: address.port,
    stop(force = false): void {
      if (force && typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    },
  };
}
