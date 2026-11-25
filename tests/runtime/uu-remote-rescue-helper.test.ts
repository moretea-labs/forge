import { describe, expect, test } from 'bun:test';
import {
  buildWslStatusCommand,
  executeAction,
  serviceUnits,
  validateConfig,
  withJsonOutput,
} from '../../scripts/forge-uu-remote-rescue-helper.mjs';

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

function fixture(
  options: {
    mismatch?: boolean;
    offline?: boolean;
    actionExit?: number;
    terminalInitiallyFocused?: boolean;
    terminalFocusNeverSucceeds?: boolean;
    terminalWindowFocusAction?: boolean;
    terminalWindowClickAction?: boolean;
    accessibilityDeviceName?: string;
    openButtonCount?: number;
  } = {},
) {
  const cliCalls: string[][] = [];
  const desktopCalls: Array<{ action: string; args: Record<string, unknown> }> = [];
  let clipboard = 'private-existing-clipboard';
  let command = '';
  let keySent = false;
  let terminalFocused = options.terminalInitiallyFocused ?? true;
  const runCli = async (_config: unknown, args: string[]) => {
    cliCalls.push(args);
    if (args[0] === 'device')
      return {
        success: true,
        data: {
          deviceId: options.mismatch ? 'other' : config.device.id,
          deviceName: config.device.name,
          platform: 'windows',
          isOnline: !options.offline,
        },
      };
    return { success: true, data: { success: true } };
  };
  const elementObservation = () => ({
    root: {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWindow',
          identifier: 'TerminalListWindow',
          name: '终端远控',
          state: { focused: true },
          children: [
            { role: 'AXStaticText', value: options.accessibilityDeviceName ?? config.device.name },
            {
              role: 'AXTable',
              children: Array.from({ length: options.openButtonCount ?? 1 }, (_, index) => ({
                role: 'AXRow',
                children: [
                  {
                    role: 'AXCell',
                    children: [
                      { role: 'AXStaticText', value: 'session' + (index + 1) },
                      {
                        role: 'AXButton',
                        name: '打开终端',
                        ref: 'open-terminal-' + (index + 1),
                        target: {
                          interactionId: 'ix-1',
                          pid: 90766,
                          bundleIdentifier: config.uuBundleId,
                          appName: 'UU远程',
                          windowRef: 'list-window',
                          snapshotRevision: 1,
                        },
                        actions: ['focus', 'invoke'],
                        state: { enabled: true },
                      },
                    ],
                  },
                ],
              })),
            },
          ],
        },
        {
          role: 'AXWindow',
          identifier: 'TerminalWindow',
          name: 'session1',
          state: { focused: terminalFocused },
          ...(options.terminalWindowFocusAction || options.terminalWindowClickAction
            ? {
                ref: 'terminal-window-1',
                target: {
                  interactionId: 'ix-1',
                  pid: 90766,
                  bundleIdentifier: config.uuBundleId,
                  appName: 'UU远程',
                  windowRef: 'terminal-window',
                  snapshotRevision: 1,
                },
                actions: options.terminalWindowFocusAction ? ['focus'] : ['click'],
              }
            : {}),
          children: [{ role: 'AXStaticText', value: config.device.name }],
        },
      ],
    },
  });
  const runCliText = async (_config: unknown, args: string[]) => {
    cliCalls.push(args);
    return { success: true, text: '' };
  };
  const desktopCall = async (_config: unknown, _requestId: string, action: string, args: Record<string, unknown>) => {
    desktopCalls.push({ action, args });
    if (action === 'desktop_session_open') return { interaction_id: 'ix-1' };
    if (action === 'computer_element_observe') {
      if (keySent) {
        const decoded = decodeRemoteScript(command);
        const begin = decoded.match(/__FORGE_UU_RESCUE_BEGIN_[a-f0-9]+__/)?.[0] ?? '';
        const end = decoded.match(/__FORGE_UU_RESCUE_END_[a-f0-9]+__/)?.[0] ?? '';
        const records = [
          'distro_b64|' + Buffer.from('Ubuntu-24.04').toString('base64'),
          'controller_home_present|1',
          'control_plane_present|1',
          'runtime_owner_present|1',
          'runtime_status_present|1',
          'connector_authority_present|1',
          'recovery_config_present|1',
          'migration_json_b64|' +
            Buffer.from(
              JSON.stringify([
                { status: 'applied', sourceHome: '/old', destinationHome: TEST_LINUX_HOME + '/.forge/controller' },
              ]),
            ).toString('base64'),
          'action_exit|' + (options.actionExit ?? 0),
          'service|runtime|loaded|active|running|101',
          'service|connector|loaded|active|running|102',
          'service|recoveryGateway|loaded|active|running|103',
          'service|recoveryWatchdog|loaded|active|running|104',
          'service|independentRecovery|loaded|active|running|105',
        ].join('\n');
        return { tree: command + '\n' + begin + '\n' + records + '\n' + end };
      }
      return elementObservation();
    }
    if (action === 'computer_element_action') {
      if (
        ['focus', 'click'].includes(String(args.action)) &&
        args.ref === 'terminal-window-1' &&
        !options.terminalFocusNeverSucceeds
      )
        terminalFocused = true;
      if (
        args.action === 'invoke' &&
        String(args.ref).startsWith('open-terminal-') &&
        !options.terminalFocusNeverSucceeds
      )
        terminalFocused = true;
      return { method: 'AXPress_background', ref: args.ref, semantic_action: args.action };
    }
    if (action === 'desktop_clipboard_read') return { text: clipboard };
    if (action === 'desktop_clipboard_write') {
      clipboard = String(args.text ?? '');
      if (clipboard !== 'private-existing-clipboard') command = clipboard;
      return { ok: true };
    }
    if (action === 'desktop_key') {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
      if (keys.some((key) => key.toUpperCase() === 'RETURN')) keySent = true;
      return { ok: true };
    }
    if (action === 'desktop_observe' && keySent) {
      const decoded = decodeRemoteScript(command);
      const begin = decoded.match(/__FORGE_UU_RESCUE_BEGIN_[a-f0-9]+__/)?.[0] ?? '';
      const end = decoded.match(/__FORGE_UU_RESCUE_END_[a-f0-9]+__/)?.[0] ?? '';
      const records = [
        'distro_b64|' + Buffer.from('Ubuntu-24.04').toString('base64'),
        'controller_home_present|1',
        'control_plane_present|1',
        'runtime_owner_present|1',
        'runtime_status_present|1',
        'connector_authority_present|1',
        'recovery_config_present|1',
        'migration_json_b64|' +
          Buffer.from(
            JSON.stringify([
              { status: 'applied', sourceHome: '/old', destinationHome: TEST_LINUX_HOME + '/.forge/controller' },
            ]),
          ).toString('base64'),
        'action_exit|' + (options.actionExit ?? 0),
        'service|runtime|loaded|active|running|101',
        'service|connector|loaded|active|running|102',
        'service|recoveryGateway|loaded|active|running|103',
        'service|recoveryWatchdog|loaded|active|running|104',
        'service|independentRecovery|loaded|active|running|105',
      ].join('\n');
      return { tree: command + '\n' + begin + '\n' + records + '\n' + end };
    }
    return { ok: true };
  };
  return {
    cliCalls,
    desktopCalls,
    runCli,
    runCliText,
    desktopCall,
    sleep: async () => undefined,
    getClipboard: () => clipboard,
    getCommand: () => command,
  };
}

describe('UU Remote rescue helper', () => {
  test('reads WSL state and Windows logon Recovery task without dispatching a restart', () => {
    const command = buildWslStatusCommand({ begin: 'BEGIN', end: 'END' });
    expect(command).toContain('wsl.exe --list --verbose');
    expect(command).toContain("Get-ScheduledTask -TaskName 'Forge Independent Recovery WSL'");
    expect(command).toContain("Get-ScheduledTaskInfo -TaskName 'Forge Independent Recovery WSL'");
    expect(command).toContain('host_logon_fallback');
    expect(command).toContain('host_logon_fallback_literal');
    expect(command).toContain('host_windows_identity');
    expect(command).toContain('host_run_key_exists');
    expect(command).not.toContain('Start-ScheduledTask');
  });

  test('requests stable JSON from every uuyc-cli invocation', () => {
    expect(withJsonOutput(['device', 'info', 'device-1'])).toEqual(['device', 'info', 'device-1', '--json']);
    expect(withJsonOutput(['device', 'info', 'device-1', '--json'])).toEqual(['device', 'info', 'device-1', '--json']);
  });

  test('accepts the current device info payload without a legacy matchedItem wrapper', async () => {
    const fx = fixture();
    await expect(
      executeAction('device_status', {}, config, { ...fx, requestId: 'device-status-1' }),
    ).resolves.toMatchObject({
      device: { deviceId: config.device.id, deviceName: config.device.name, platform: 'windows', isOnline: true },
    });
  });

  test('derives canonical service identities from the configured Controller Home', () => {
    expect(serviceUnits(`${TEST_LINUX_HOME}/.forge/controller`)).toMatchObject({
      runtime: expect.stringMatching(/^com\.moretea\.forge\.runtime\.[a-f0-9]{12}\.service$/),
      connector: expect.stringMatching(/^com\.moretea\.forge\.mcp-gateway\.[a-f0-9]{12}\.service$/),
      recoveryGateway: 'com.moretea.forge-recovery-gateway.service',
      recoveryWatchdog: 'com.moretea.forge-recovery-watchdog.service',
      independentRecovery: 'com.moretea.forge.independent-recovery.service',
    });
  });

  test('reads result markers from the same bound accessibility observer used for focus proof', async () => {
    const fx = fixture({ terminalInitiallyFocused: true });
    await executeAction('forge_health', {}, config, { ...fx, requestId: 'bound-observe-1' });
    const resultObserves = fx.desktopCalls.filter((call) => call.action === 'computer_element_observe');
    expect(resultObserves.length).toBeGreaterThanOrEqual(2);
    expect(fx.desktopCalls.some((call) => call.action === 'desktop_observe')).toBe(false);
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
    expect(fx.cliCalls.some((args) => args[0] === 'term' && args[1] === 'new' && args.includes(config.device.id))).toBe(
      true,
    );
    expect(
      fx.cliCalls.some((args) => args[0] === 'term' && args[1] === 'kill' && args.includes(config.device.id)),
    ).toBe(true);
    expect(fx.cliCalls.some((args) => ['open', 'exit'].includes(args[1]))).toBe(false);
  });

  test('focuses an existing exact terminal window directly before requiring the session list button', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, terminalWindowFocusAction: true, openButtonCount: 0 });
    await executeAction('forge_health', {}, config, { ...fx, requestId: 'focus-existing-window-1' });
    const focusIndex = fx.desktopCalls.findIndex(
      (call) =>
        call.action === 'computer_element_action' &&
        call.args.action === 'focus' &&
        call.args.ref === 'terminal-window-1',
    );
    const commandWriteIndex = fx.desktopCalls.findIndex(
      (call) => call.action === 'desktop_clipboard_write' && call.args.text !== 'private-existing-clipboard',
    );
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(commandWriteIndex).toBeGreaterThan(focusIndex);
    expect(
      fx.desktopCalls.some(
        (call) =>
          call.action === 'computer_element_action' &&
          call.args.action === 'invoke' &&
          String(call.args.ref).startsWith('open-terminal-'),
      ),
    ).toBe(false);
  });

  test('click-focuses an existing exact terminal window when AX exposes click but not focus', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, terminalWindowClickAction: true, openButtonCount: 0 });
    await executeAction('host_full_recover_dispatch', {}, config, {
      ...fx,
      requestId: 'click-focus-existing-window-1',
    });
    const clickIndex = fx.desktopCalls.findIndex(
      (call) =>
        call.action === 'computer_element_action' &&
        call.args.action === 'click' &&
        call.args.ref === 'terminal-window-1',
    );
    const commandWriteIndex = fx.desktopCalls.findIndex(
      (call) => call.action === 'desktop_clipboard_write' && call.args.text !== 'private-existing-clipboard',
    );
    expect(clickIndex).toBeGreaterThanOrEqual(0);
    expect(commandWriteIndex).toBeGreaterThan(clickIndex);
  });

  test('focuses the exact configured device session through its Open Terminal control before pasting', async () => {
    const fx = fixture({ terminalInitiallyFocused: false });
    await executeAction('forge_health', {}, config, { ...fx, requestId: 'focus-1' });
    const focusIndex = fx.desktopCalls.findIndex(
      (call) =>
        call.action === 'computer_element_action' &&
        call.args.action === 'invoke' &&
        call.args.ref === 'open-terminal-1' &&
        (call.args.target as Record<string, unknown>).windowRef === 'list-window',
    );
    const commandWriteIndex = fx.desktopCalls.findIndex(
      (call) => call.action === 'desktop_clipboard_write' && call.args.text !== 'private-existing-clipboard',
    );
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(commandWriteIndex).toBeGreaterThan(focusIndex);
  });

  test('fails closed before clipboard mutation when the exact terminal cannot be focused', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, terminalFocusNeverSucceeds: true });
    await expect(executeAction('forge_health', {}, config, { ...fx, requestId: 'focus-fail-1' })).rejects.toThrow(
      'proven focused',
    );
    expect(fx.desktopCalls.some((call) => call.action === 'desktop_clipboard_write')).toBe(false);
  });

  test('fails closed when the terminal list does not prove the configured device', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, accessibilityDeviceName: 'OTHER-DEVICE' });
    await expect(
      executeAction('forge_health', {}, config, { ...fx, requestId: 'device-list-mismatch-1' }),
    ).rejects.toThrow('could not be bound');
    expect(fx.desktopCalls.some((call) => call.action === 'computer_element_action')).toBe(false);
    expect(fx.desktopCalls.some((call) => call.action === 'desktop_clipboard_write')).toBe(false);
  });

  test('fails closed when multiple terminal sessions could match the configured device', async () => {
    const fx = fixture({ terminalInitiallyFocused: false, openButtonCount: 2 });
    await expect(
      executeAction('forge_health', {}, config, { ...fx, requestId: 'session-ambiguous-1' }),
    ).rejects.toThrow('More than one exact configured-device UU terminal session');
    expect(fx.desktopCalls.some((call) => call.action === 'desktop_clipboard_write')).toBe(false);
  });
  test('fails closed on exact-device mismatch before opening the remote terminal', async () => {
    const fx = fixture({ mismatch: true });
    await expect(executeAction('runtime_restart', {}, config, { ...fx, requestId: 'mismatch-1' })).rejects.toThrow(
      'device identity',
    );
    expect(fx.cliCalls.some((args) => args[0] === 'term')).toBe(false);
    expect(fx.desktopCalls).toHaveLength(0);
  });

  test('fails closed on an offline target before mutation', async () => {
    const fx = fixture({ offline: true });
    await expect(executeAction('connector_restart', {}, config, { ...fx, requestId: 'offline-1' })).rejects.toThrow(
      'offline',
    );
    expect(fx.cliCalls.some((args) => args[0] === 'term')).toBe(false);
  });

  test('rejects arbitrary caller command or service arguments', async () => {
    const fx = fixture();
    await expect(
      executeAction('forge_health', { command: 'whoami' }, config, { ...fx, requestId: 'arbitrary-1' }),
    ).rejects.toThrow('do not accept caller-provided');
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

  test('host recovery task installation uses the fixed Windows script with no caller arguments', async () => {
    const fx = fixture();
    const result = await executeAction('host_task_install_dispatch', {}, config, {
      ...fx,
      requestId: 'host-install-1',
    });
    expect(fx.getCommand()).toContain('ForgeRecovery.ps1');
    expect(fx.getCommand()).toContain("'task_install'");
    expect(fx.getCommand()).toContain('FORGE_RECOVERY_TASK_INSTALL_EXIT');
    expect(fx.getCommand()).toContain('FORGE_RECOVERY_PARENT_SID');
    expect(fx.getCommand()).toContain('FORGE_RECOVERY_PARENT_RUN');
    const clear = fx.desktopCalls.findIndex(
      (call) => call.action === 'desktop_key' && Array.isArray(call.args.keys) && call.args.keys.includes('escape'),
    );
    const write = fx.desktopCalls.findIndex(
      (call) => call.action === 'desktop_clipboard_write' && call.args.text !== 'private-existing-clipboard',
    );
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(clear);
    expect(fx.getCommand()).not.toContain('Start-Process -WindowStyle Hidden');
    expect(fx.getCommand()).not.toContain("'full_recover'");
    expect(result).toMatchObject({
      dispatch: { accepted: true, action: 'task_install', recoveryStatus: 'unverified' },
    });
    await expect(
      executeAction('host_task_install_dispatch', { taskName: 'other' }, config, {
        ...fixture(),
        requestId: 'host-install-invalid',
      }),
    ).rejects.toThrow('do not accept caller-provided');
  });

  test('host tunnel recovery dispatch is fixed and remains explicitly unverified', async () => {
    const fx = fixture();
    const result = await executeAction('host_tunnel_restart_dispatch', {}, config, {
      ...fx,
      requestId: 'host-tunnel-1',
    });
    expect(fx.getCommand()).toContain(String.raw`C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1`);
    expect(fx.getCommand()).toContain('tunnel_restart');
    expect(fx.getCommand()).not.toContain('full_recover');
    expect(fx.getCommand()).toContain('-ArgumentList $arguments');
    expect(fx.getCommand()).not.toContain('-ArgumentList @(');
    expect(result).toMatchObject({
      dispatch: {
        accepted: true,
        action: 'tunnel_restart',
        recoveryStatus: 'unverified',
        verificationRequired: 'Forge Cloud connectivity',
      },
    });
    expect(fx.getClipboard()).toBe('private-existing-clipboard');
  });

  test('host full recovery dispatch cannot be parameterized and does not claim recovery success', async () => {
    const fx = fixture();
    const result = await executeAction('host_full_recover_dispatch', {}, config, { ...fx, requestId: 'host-full-1' });
    expect(fx.getCommand()).toContain(String.raw`C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1`);
    expect(fx.getCommand()).toContain('full_recover');
    expect(fx.getCommand()).toContain('-ArgumentList $arguments');
    expect(fx.getCommand()).not.toContain('-ArgumentList @(');
    expect(result).toMatchObject({
      dispatch: {
        accepted: true,
        action: 'full_recover',
        recoveryStatus: 'unverified',
        verificationRequired: 'Forge Cloud connectivity',
      },
    });
    await expect(
      executeAction('host_full_recover_dispatch', { command: 'whoami' }, config, {
        ...fixture(),
        requestId: 'host-full-arbitrary',
      }),
    ).rejects.toThrow('do not accept caller-provided');
  });
});
