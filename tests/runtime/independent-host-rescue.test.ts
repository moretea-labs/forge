import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  controllerServiceUnit,
  createIndependentHostRescueConfig,
  renderIndependentHostRescueEnv,
  renderIndependentHostRescueSystemdUnit,
  renderWindowsHostRescueConfig,
} from '../../src/runtime/standalone-recovery/independent-host-rescue';

function config() {
  return createIndependentHostRescueConfig({
    wslDistro: 'UbuntuDev',
    controllerHome: '/home/greyson/.forge/controller',
    sourceRoot: '/home/greyson/src/forge',
    rescueRoot: '/home/greyson/.forge-recovery',
    tunnelClient: '/home/greyson/.local/bin/tunnel-client',
    tunnelAlias: 'forge',
    tunnelId: 'tunnel_6a8a862b52188191b859cf61e7cdb9a3',
    tunnelRuntimeApiKeyRef: 'file:/home/greyson/.forge-recovery/secrets/openai-tunnel-runtime-api-key',
    tunnelProfileDir: '/home/greyson/.config/tunnel-client',
  });
}

describe('independent Windows/WSL host rescue', () => {
  test('binds exactly the canonical controller-home unit identities', () => {
    const value = config();
    expect(value.runtimeUnit).toBe('com.moretea.forge.runtime.f24d2fcb7df7.service');
    expect(value.connectorUnit).toBe('com.moretea.forge.mcp-gateway.f24d2fcb7df7.service');
    expect(controllerServiceUnit('runtime', value.controllerHome)).toBe(value.runtimeUnit);
    expect(controllerServiceUnit('connector', value.controllerHome)).toBe(value.connectorUnit);
  });

  test('emits root-owned, fixed-unit configuration with no credential field', () => {
    const value = config();
    const env = renderIndependentHostRescueEnv(value);
    const unit = renderIndependentHostRescueSystemdUnit(value);
    const windows = renderWindowsHostRescueConfig(value);
    expect(env).toContain("CONTROLLER_HOME='/home/greyson/.forge/controller'");
    expect(env).toContain("TUNNEL_ID='tunnel_6a8a862b52188191b859cf61e7cdb9a3'");
    expect(env).toContain("TUNNEL_RUNTIME_API_KEY_REF='file:/home/greyson/.forge-recovery/secrets/openai-tunnel-runtime-api-key'");
    expect(env).not.toContain('sk-');
    expect(unit).toContain('ExecStart=/home/greyson/.forge-recovery/bin/forge-wsl-rescue watch');
    expect(unit).toContain('Restart=always');
    expect(windows).toContain('"wslRescuePath": "/home/greyson/.forge-recovery/bin/forge-wsl-rescue"');
    expect(windows).not.toContain('sk-');
  });

  test('rejects noncanonical paths and command-injection characters', () => {
    expect(() => createIndependentHostRescueConfig({
      wslDistro: 'UbuntuDev;whoami',
      controllerHome: '/home/greyson/.forge/controller',
      sourceRoot: '/home/greyson/src/forge',
      rescueRoot: '/home/greyson/.forge-recovery',
      tunnelClient: '/home/greyson/.local/bin/tunnel-client',
      tunnelAlias: 'forge',
      tunnelId: 'tunnel_6a8a862b52188191b859cf61e7cdb9a3',
      tunnelRuntimeApiKeyRef: 'file:/home/greyson/.forge-recovery/secrets/openai-tunnel-runtime-api-key',
      tunnelProfileDir: '/home/greyson/.config/tunnel-client',
    })).toThrow('HOST_RESCUE_WSL_DISTRO_INVALID');
    expect(() => createIndependentHostRescueConfig({
      wslDistro: 'UbuntuDev',
      controllerHome: '/home/greyson/src/forge/_ops/controller-home',
      sourceRoot: '/home/greyson/src/forge',
      rescueRoot: '/home/greyson/.forge-recovery',
      tunnelClient: '/home/greyson/.local/bin/tunnel-client',
      tunnelAlias: 'forge',
      tunnelId: 'tunnel_6a8a862b52188191b859cf61e7cdb9a3',
      tunnelRuntimeApiKeyRef: 'file:/home/greyson/.forge-recovery/secrets/openai-tunnel-runtime-api-key',
      tunnelProfileDir: '/home/greyson/.config/tunnel-client',
    })).toThrow('HOST_RESCUE_CONTROLLER_HOME_CANONICAL_REQUIRED');
  });

  test('binds the loopback Connector to Secure Tunnel authorization', () => {
    const migration = readFileSync(resolve(import.meta.dir, '../../scripts/migrate-windows-wsl-controller-home.ts'), 'utf8');
    const rescue = readFileSync(resolve(import.meta.dir, '../../assets/recovery/forge-wsl-rescue'), 'utf8');
    expect(migration).toContain("'--auth', 'none'");
    expect(migration).toContain("externalAuthorization: 'openai-secure-tunnel'");
    expect(migration).toContain('Description=Forge ChatGPT Secure Tunnel Gateway');
    expect(rescue).toContain('"method":"initialize"');
  });
});
