import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  forgeRuntimeServicePaths,
  renderForgeRuntimeLaunchAgent,
  validateForgeRuntimeServiceConfig,
} from '../../src/runtime/root/service';

const roots: string[] = [];
function fixture(): { root: string; home: string; repo: string; token: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-service-'));
  roots.push(root);
  const home = join(root, 'controller-home');
  const repo = join(root, 'repo');
  const token = join(root, 'auth-token.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(token, '{}\n');
  return { root, home, repo, token };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Forge Runtime service', () => {
  test('derives one stable launchd service identity from Controller Home', () => {
    const fx = fixture();
    const first = forgeRuntimeServicePaths(fx.home);
    const second = forgeRuntimeServicePaths(fx.home);
    expect(first.label).toBe(second.label);
    expect(first.label.startsWith('com.moretea.forge.runtime.')).toBe(true);
    expect(first.configPath).toBe(join(fx.home, 'runtime', 'service', 'config.json'));
  });

  test('renders launchd auto-start and abnormal-exit restart contract', () => {
    const fx = fixture();
    const paths = forgeRuntimeServicePaths(fx.home);
    const plist = renderForgeRuntimeLaunchAgent({
      paths,
      nodeExecutable: '/usr/local/bin/node',
      runnerPath: '/package/bin/forge-runtime-service.mjs',
    });
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('--controller-home');
    expect(plist).toContain('--config');
    expect(plist).toContain('forge-runtime-service.mjs');
  });

  test('validates the service config before installation', () => {
    const fx = fixture();
    const config = validateForgeRuntimeServiceConfig({
      schemaVersion: 1,
      controllerHome: fx.home,
      repositoryRoot: fx.repo,
      host: '127.0.0.1',
      port: 8765,
      authTokenFile: fx.token,
      exclusiveWorkId: 'work-test',
    });
    expect(config.controllerHome).toBe(fx.home);
    expect(config.repositoryRoot).toBe(fx.repo);
    expect(config.authTokenFile).toBe(fx.token);
    expect(config.exclusiveWorkId).toBe('work-test');
  });
});
