import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import {
  codexMcpConfigArgs,
  FORGE_RUNTIME_MCP_TOKEN_ENV,
  resolveProviderMcpBootstrap,
} from '../../src/runtime/control-plane/launcher/provider-mcp-bootstrap';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('provider MCP bootstrap', () => {
  test('injects canonical Runtime MCP into Codex without putting the bearer token in argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-provider-mcp-bootstrap-'));
    roots.push(root);
    const controllerHome = join(root, 'controller-home');
    const repositoryRoot = join(root, 'repo');
    mkdirSync(repositoryRoot, { recursive: true });
    const service = forgeRuntimeServicePaths(controllerHome);
    mkdirSync(service.serviceRoot, { recursive: true });
    const tokenPath = join(controllerHome, 'mcp', 'runtime-token');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(tokenPath, 'test-runtime-secret-token\n', { mode: 0o600 });
    writeFileSync(service.configPath, JSON.stringify({
      schemaVersion: 1,
      controllerHome,
      repositoryRoot,
      host: '127.0.0.1',
      port: 9876,
      authTokenFile: tokenPath,
    }));
    const ownership = acquireRuntimeOwnership(controllerHome, 'runtime-provider-bootstrap-test');
    const now = new Date().toISOString();
    writeRuntimeStatusSnapshot(controllerHome, {
      schemaVersion: 1,
      runtimeInstanceId: ownership.record.runtimeInstanceId,
      pid: ownership.record.pid,
      releaseId: 'release-test',
      artifactIdentity: 'artifact-test',
      endpoint: 'http://127.0.0.1:9876/mcp',
      readiness: {
        ready: true,
        reasonCodes: [],
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
        observedAt: now,
      },
      startedAt: now,
      updatedAt: now,
    });
    try {
      const bootstrap = resolveProviderMcpBootstrap(controllerHome, 'codex', 'reservation:abc');
      expect(bootstrap.url).toBe('http://127.0.0.1:9876/mcp');
      expect(bootstrap.bearerTokenEnvVar).toBe(FORGE_RUNTIME_MCP_TOKEN_ENV);
      expect(bootstrap.principalId).toBe('external:codex:reservation:abc');
      expect(bootstrap.sessionId).toBe('external-session:codex:reservation:abc');
      expect(bootstrap.env[FORGE_RUNTIME_MCP_TOKEN_ENV]).toBe('test-runtime-secret-token');
      const args = codexMcpConfigArgs(bootstrap);
      const rendered = args.join(' ');
      expect(rendered).toContain('mcp_servers.forge.url=');
      expect(rendered).toContain('bearer_token_env_var');
      expect(rendered).toContain('X-Forge-Forwarded-Principal-Id');
      expect(rendered).toContain('external:codex:reservation:abc');
      expect(rendered).not.toContain('test-runtime-secret-token');
    } finally {
      ownership.release();
    }
  });
});
