import { describe, expect, test } from 'bun:test';
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
    expect(env).not.toMatch(/api.?key|secret|token/i);
    expect(unit).toContain('ExecStart=/home/greyson/.forge-recovery/bin/forge-wsl-rescue watch');
    expect(unit).toContain('Restart=always');
    expect(windows).toContain('"wslRescuePath": "/home/greyson/.forge-recovery/bin/forge-wsl-rescue"');
    expect(windows).not.toMatch(/api.?key|secret|token/i);
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
      tunnelProfileDir: '/home/greyson/.config/tunnel-client',
    })).toThrow('HOST_RESCUE_CONTROLLER_HOME_CANONICAL_REQUIRED');
  });
});
