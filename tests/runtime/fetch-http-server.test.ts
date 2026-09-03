import { describe, expect, test } from 'bun:test';
import { serveFetchHttp } from '../../src/runtime/platform/fetch-http-server';

describe('Node fetch-style local HTTP server', () => {
  test('serves Web Request/Response handlers without Bun runtime APIs', async () => {
    const server = await serveFetchHttp({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        return Response.json({ method: request.method, body: await request.text(), auth: request.headers.get('x-test') });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/echo`, { method: 'POST', headers: { 'x-test': 'ok' }, body: 'payload' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: 'POST', body: 'payload', auth: 'ok' });
    } finally { server.stop(true); }
  });

  test('bounds request bodies before invoking the handler', async () => {
    let called = false;
    const server = await serveFetchHttp({ hostname: '127.0.0.1', port: 0, maxRequestBytes: 1024, fetch() { called = true; return new Response('ok'); } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/large`, { method: 'POST', body: 'x'.repeat(2048) });
      expect(response.status).toBe(413);
      expect(called).toBe(false);
    } finally { server.stop(true); }
  });
});
