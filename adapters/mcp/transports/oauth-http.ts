import { timingSafeEqual } from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { clientRegistrationHandler, redirectUriMatches, revocationHandler, tokenHandler } from '@modelcontextprotocol/server-legacy/auth';
import type { McpLocalConfig } from '../auth';
import { createMcpOAuthProvider } from '../oauth';

export function getConfiguredPublicOrigin(config: McpLocalConfig | null): string | undefined {
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

export function getPublicOrigin(req: Request, configuredOrigin: string | undefined): string {
  if (configuredOrigin) return configuredOrigin;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '127.0.0.1:8765';
  return `${proto}://${host}`;
}

export function isAllowedMcpOAuthRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return url.protocol === 'https:'
      && (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com')
      && url.pathname.startsWith('/connector/oauth/');
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

export function isIncompleteOAuthAuthorizeRequest(source: Record<string, unknown>): boolean {
  const clientId = readOAuthAuthorizeString(source, 'client_id');
  const responseType = readOAuthAuthorizeString(source, 'response_type');
  const codeChallenge = readOAuthAuthorizeString(source, 'code_challenge');
  const redirectUri = readOAuthAuthorizeString(source, 'redirect_uri');
  const hasRedirectContext = Boolean(redirectUri) || Boolean(clientId);
  return !clientId || !responseType || !codeChallenge || !hasRedirectContext;
}

function incompleteOAuthAuthorizeResponseBody() {
  return {
    error: 'invalid_request' as const,
    error_description: 'OAuth authorization request is incomplete. Required: client_id, response_type, code_challenge, and a usable redirect context (redirect_uri or a registered client).',
    message: 'This endpoint expects a complete OAuth authorization request (PKCE). Non-OAuth MCP clients should use /mcp-bearer with Authorization: Bearer <token> instead of /authorize.',
    hint: 'Use POST/GET /mcp-bearer with a forge bearer token for clients that cannot complete OAuth dynamic registration and PKCE.',
  };
}

function isOAuthDebugTraceEnabled(): boolean {
  return process.env.FORGE_MCP_OAUTH_TRACE === '1' || process.env.FORGE_MCP_OAUTH_TRACE === 'true';
}

const SENSITIVE_OAUTH_FIELDS = new Set(['passphrase', 'code', 'code_verifier', 'client_secret', 'access_token', 'refresh_token', 'token', 'authorization']);

function safeOAuthFieldNames(source: Record<string, unknown>): string[] {
  return Object.keys(source).filter((key) => !SENSITIVE_OAUTH_FIELDS.has(key.toLowerCase())).sort();
}

function oauthTrace(req: Request, event: string, extra: Record<string, unknown> = {}): void {
  if (!isOAuthDebugTraceEnabled()) return;
  const source = oauthAuthorizeParamSource(req);
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].split(/[\s/]/)[0] : undefined;
  console.error(`[forge:mcp-oauth] ${JSON.stringify({
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
  })}`);
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

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    const source = oauthAuthorizeParamSource(req);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(source)) {
      if (key !== 'passphrase' && typeof value === 'string') params.set(key, value);
    }
    if ([...params.keys()].length === 0 && req.url.includes('?')) {
      const fromUrl = new URLSearchParams(req.url.slice(req.url.indexOf('?')));
      for (const [key, value] of fromUrl.entries()) if (key !== 'passphrase') params.set(key, value);
    }
    res.type('html').send(renderPassphrasePage(params));
  };
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
    if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
    if (!redirectUri || (!isAllowedMcpOAuthRedirectUri(redirectUri) && !isRegisteredExternalHttpsRedirectUri(redirectUri, client))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri must be localhost, a ChatGPT connector callback URL, or a registered HTTPS client redirect_uri' });
      return;
    }
    if (!isRegisteredRedirectUri(redirectUri, client)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri must match a registered client redirect_uri' });
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

export function registerMcpOAuthHttpRoutes(
  app: Express,
  provider: ReturnType<typeof createMcpOAuthProvider>,
  passphrase: string,
  configuredOrigin: string | undefined,
): void {
  app.use('/authorize', express.urlencoded({ extended: false, limit: '10kb' }));
  app.use('/authorize', oauthTraceMiddleware('authorize'));
  app.use('/authorize', rejectIncompleteOAuthAuthorize);
  app.use('/authorize', requirePassphrase(passphrase));
  app.use('/authorize', oauthAuthorizationHandler(provider));
  app.use('/token', oauthTraceMiddleware('token'));
  app.use('/token', tokenHandler({ provider, rateLimit: false }));
  app.use('/revoke', oauthTraceMiddleware('revoke'));
  app.use('/revoke', revocationHandler({ provider, rateLimit: false }));
  app.use('/register', oauthTraceMiddleware('register'));
  app.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit: false }));
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const origin = getPublicOrigin(req, configuredOrigin);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      revocation_endpoint: `${origin}/revoke`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes_supported: ['forge'],
    });
  });
  app.get('/.well-known/openid-configuration', (req, res) => {
    const origin = getPublicOrigin(req, configuredOrigin);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes_supported: ['forge'],
    });
  });
  const protectedResourceMetadata = (resourcePath: '/mcp' | '/mcp-grok' | '/mcp-bearer') => (req: Request, res: Response): void => {
    const origin = getPublicOrigin(req, configuredOrigin);
    res.json({ resource: `${origin}${resourcePath}`, authorization_servers: [origin], scopes_supported: ['forge'], bearer_methods_supported: ['header'] });
  };
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata('/mcp'));
  app.get('/.well-known/oauth-protected-resource/mcp-grok', protectedResourceMetadata('/mcp-grok'));
  app.get('/.well-known/oauth-protected-resource/mcp-bearer', protectedResourceMetadata('/mcp-bearer'));
}
