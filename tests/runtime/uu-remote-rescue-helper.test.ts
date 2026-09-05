import { describe, expect, test } from 'bun:test';
import { executeAction, serviceUnits, validateConfig } from '../../scripts/forge-uu-remote-rescue-helper.mjs';

const TEST_LINUX_HOME = '/home' + '/forge-test';

const config = validateConfig({
  schemaVersion: 1,
  device: { id: 'device1234', name: 'GREYSON-DESKTOP', platform: 'windows' },
  wsl: { distro: 'Ubuntu-24.04', controllerHome: `${TEST_LINUX_HOME}/.forge/controller` },
  uuycCliPath: '/usr/local/bin/uuyc-cli',
  desktopOperatorSocketPath: '/tmp/desktop-operator.sock',
  uuBundleId: 'com.netease.uuremote',
});

function decodeRemoteScript(command: string): string {
  const payload = command.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| bash/)?.[1];
  return payload ? Buffer.from(payload, 'base64').toString('utf8') : '';
}

function fixture(options: { mismatch?: boolean; offline?: boolean; actionExit?: number; terminalInitiallyFocused?: boolean; terminalFocusNeverSucceeds?: boolean } = {}) {
  const cliCalls: string[][] = [];
  const desktopCalls: Array<{ action: string; args: Record<string, unknown> }> = [];
  let clipboard = 'private-existing-clipboard';
  let command = '';
  let keySent = false;
  let terminalFocused = options.terminalInitiallyFocused ?? true;
  const runCli = async (_config: unknown, args: string[]) => {
    cliCalls.push(args);
    if (args[0] === 'device') return { success: true, data: { isUniqueMatch: true, matchedItem: { deviceId: options.mismatch ? 'other' : config.device.id, deviceName: config.device.name, platform: 'windows', isOnline: !options.offline } } };
    return { success: true, data: { success: true } };
  };
  const desktopCall = async (_config: unknown, _requestId: string, action: string, args: Record<string, unknown>) => {
    desktopCalls.push({ action, args });
    if (action === 'desktop_session_open') return { interaction_id: 'ix-1' };
    if (action === 'desktop_observe' && !keySent) return {
      root: {
        role: 'AXApplication',
        children: [
          { role: 'AXWindow', title: 'UU远程', focused: !terminalFocused },
          { role: 'AXWindow', identifier: 'TerminalWindow', title: '终端 - GREYSON-DESKTOP', focused: terminalFocused },
        ],
      },
      windows: [{ title: '终端 - GREYSON-DESKTOP' }],
    };
    if (action === 'desktop_clipboard_read') return { text: clipboard };
    if (action === 'desktop_clipboard_write') { clipboard = String(args.text ?? ''); if (clipboard !== 'private-existing-clipboard') command = clipboard; return { ok: true }; }
    if (action === 'desktop_key') {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
      if (keys.includes('COMMAND')) {
        if (!options.terminalFocusNeverSucceeds) terminalFocused = true;
        return { ok: true };
      }
      if (keys.some((key) => key.toUpperCase() === 'RETURN')) keySent = true;
      return { ok: true };
    }
    if (action === 'desktop_observe' && keySent) {
      const decoded = decodeRemoteScript(command);
      const begin = decoded.match(/__FORGE_UU_RESCUE_BEGIN_[a-f0-9]+__/)?.[0] ?? '';
      const end = decoded.match(/__FORGE_UU_RESCUE_END_[a-f0-9]+__/)?.[0] ?? '';
      const records = [
        'distro_b64|' + Buffer.from('Ubuntu-24.04').toString('base64'),
        'controller_home_present|1', 'control_plane_present|1', 'runtime_owner_present|1', 'runtime_status_present|1', 'connector_authority_present|1', 'recovery_config_present|1',
        'migration_json_b64|' + Buffer.from(JSON.stringify([{ status: 'applied', sourceHome: '/old', destinationHome: `${TEST_LINUX_HOME}/.forge/controller` }])).toString('base64'),
        `action_exit|${options.actionExit ?? 0}`,
        'service|runtime|loaded|active|running|101', 'service|connector|loaded|active|running|102', 'service|recoveryGateway|loaded|active|running|103', 'service|recoveryWatchdog|loaded|active|running|104',
      ].join('\n');
      return { tree: `${command}\n${begin}\n${records}\n${end}` };
    }
    return { ok: true };
  };
  return { cliCalls, desktopCalls, runCli, desktopCall, sleep: async () => undefined, getClipboard: () => clipboard, getCommand: () => command };
}

describe('UU Remote rescue helper', () => {
  test('derives canonical service identities from the configured Controller Home', () => {
    expect(serviceUnits(`${TEST_LINUX_HOME}/.forge/controller`)).toMatchObject({
      runtime: expect.stringMatching(/^com\.moretea\.forge\.runtime\.[a-f0-9]{12}\.service$/),
      connector: expect.stringMatching(/^com\.moretea\.forge\.mcp-gateway\.[a-f0-9]{12}\.service$/),
      recoveryGateway: 'com.moretea.forge-recovery-gateway.service',
      recoveryWatchdog: 'com.moretea.forge-recovery-watchdog.service',
    });
  });

  test('returns structured Forge health and never returns the prior clipboard', async () => {
    const fx = fixture();
    const result = await executeAction('forge_health', {}, config, { ...fx, requestId: 'health-1' });
    expect(result).toMatchObject({
      controller_home_present: true,
      control_plane_present: true,
      migration: [{ status: 'applied' }],
      services: { runtime: { activeState: 'active', mainPid: 101 }, connector: { activeState: 'active' } },
    });
    expect(JSON.stringify(result)).not.toContain('private-existing-clipboard');
    expect(fx.getClipboard()).toBe('private-existing-clipboard');
    expect(fx.cliCalls.some((args) => args[0] === 'term' && args[1] === 'open' && args[2] === config.device.id)).toBe(true);
    expect(fx.cliCalls.some((args) => args[0] === 'term' && args[1] === 'exit' && args.includes('--clear'))).toBe(true);
  });

  test('proves the exact remote terminal focused before pasting the command', async () => {
    const fx = fixture({ terminalInitiallyFocused: false });
    await executeAction('forge_health', {}, config, { ...fx, requestId: 'focus-1' });
    const focusIndex = fx.desktopCalls.findIndex((call) => call.action === 'desktop_key' && Array.isArray(call.args.keys) && call.args.keys.includes('COMMAND'));
    const commandWriteIndex = fx.desktopCalls.findIndex((call) => call.action === 'desktop_clipboard_write' && call.args.text !== 'private-existing-clipboard');
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(commandWriteIndex).toBeGreaterThan(focusIndex);
  });

  test('fails closed before clipboard mutation when exact terminal focus cannot be proven', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, terminalFocusNeverSucceeds: true });
    await expect(executeAction('forge_health', {}, config, { ...fx, requestId: 'focus-fail-1' })).rejects.toThrow('proven focused');
    expect(fx.desktopCalls.some((call) => call.action === 'desktop_clipboard_write')).toBe(false);
  });

  test('fails closed on exact-device mismatch before opening the remote terminal', async () => {
    const fx = fixture({ mismatch: true });
    await expect(executeAction('runtime_restart', {}, config, { ...fx, requestId: 'mismatch-1' })).rejects.toThrow('device identity');
    expect(fx.cliCalls.some((args) => args[0] === 'term')).toBe(false);
    expect(fx.desktopCalls).toHaveLength(0);
  });

  test('fails closed on an offline target before mutation', async () => {
    const fx = fixture({ offline: true });
    await expect(executeAction('connector_restart', {}, config, { ...fx, requestId: 'offline-1' })).rejects.toThrow('offline');
    expect(fx.cliCalls.some((args) => args[0] === 'term')).toBe(false);
  });

  test('rejects arbitrary caller command or service arguments', async () => {
    const fx = fixture();
    await expect(executeAction('forge_health', { command: 'whoami' }, config, { ...fx, requestId: 'arbitrary-1' })).rejects.toThrow('do not accept caller-provided');
    expect(fx.cliCalls).toHaveLength(0);
    expect(fx.desktopCalls).toHaveLength(0);
  });

  test('runtime recovery is the fixed canonical Recovery transaction only', async () => {
    const fx = fixture();
    await executeAction('runtime_recover', {}, config, { ...fx, requestId: 'recover-1' });
    const decoded = decodeRemoteScript(fx.getCommand());
    expect(decoded).toContain('forge recovery recover --controller-home');
    expect(decoded).not.toContain('whoami');
  });

  test('host tunnel recovery dispatch is fixed and remains explicitly unverified', async () => {
    const fx = fixture();
    const result = await executeAction('host_tunnel_restart_dispatch', {}, config, { ...fx, requestId: 'host-tunnel-1' });
    expect(fx.getCommand()).toContain(String.raw`C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1`);
    expect(fx.getCommand()).toContain("'tunnel_restart'");
    expect(fx.getCommand()).not.toContain("'full_recover'");
    expect(result).toMatchObject({
      dispatch: { accepted: true, action: 'tunnel_restart', recoveryStatus: 'unverified', verificationRequired: 'Forge Cloud connectivity' },
    });
    expect(fx.getClipboard()).toBe('private-existing-clipboard');
  });

  test('host full recovery dispatch cannot be parameterized and does not claim recovery success', async () => {
    const fx = fixture();
    const result = await executeAction('host_full_recover_dispatch', {}, config, { ...fx, requestId: 'host-full-1' });
    expect(fx.getCommand()).toContain(String.raw`C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1`);
    expect(fx.getCommand()).toContain("'full_recover'");
    expect(result).toMatchObject({
      dispatch: { accepted: true, action: 'full_recover', recoveryStatus: 'unverified', verificationRequired: 'Forge Cloud connectivity' },
    });
    await expect(executeAction('host_full_recover_dispatch', { command: 'whoami' }, config, { ...fixture(), requestId: 'host-full-arbitrary' })).rejects.toThrow('do not accept caller-provided');
  });
});
