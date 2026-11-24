import { describe, expect, test } from 'bun:test';
import { probeWindowsComputerObservation } from '../../src/runtime/platform/windows-computer-observation';

const mountTable = 'C:\\\\ /mnt/c 9p rw,aname=drvfs;path=C:\\\\,uid=1001 0 0\n';
const exe = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

describe('Windows Computer UIAutomation discovery', () => {
  test('reports an observation-only host provider without exposing targets or changing browser ownership', async () => {
    let invoked = false;
    const observation = await probeWindowsComputerObservation({
      platform: 'linux', mountTable, fileExists: (path) => path === exe,
      run: async (executable, args) => {
        invoked = true;
        expect(executable).toBe(exe);
        expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
        expect(script).toContain('AutomationElement');
        expect(script).not.toContain('InvokePattern');
        expect(script).not.toContain('SendKeys');
        return '{"uiaReady":true,"topLevelWindowCount":12,"browserWindowCount":1}';
      },
    });
    expect(invoked).toBe(true);
    expect(observation).toEqual({
      provider: 'windows-uia', capability: 'window_inventory',
      state: 'observation_only', topLevelWindowCount: 12, browserWindowCount: 1,
    });
  });

  test('missing interop fails closed without launching a process', async () => {
    const result = await probeWindowsComputerObservation({
      platform: 'linux', mountTable: '', run: async () => { throw new Error('should not execute'); },
    });
    expect(result).toMatchObject({ state: 'unavailable', reasonCode: 'windows_host_missing' });
  });

  test('rejects malformed or contradictory UIA observation without leaking output', async () => {
    const result = await probeWindowsComputerObservation({
      platform: 'linux', mountTable, fileExists: () => true,
      run: async () => '{"uiaReady":true,"topLevelWindowCount":1,"browserWindowCount":500}',
    });
    expect(result).toEqual({
      provider: 'windows-uia', capability: 'window_inventory',
      state: 'unavailable', reasonCode: 'uia_probe_failed',
    });
  });

  test('non-WSL Computer never probes Windows', async () => {
    expect(await probeWindowsComputerObservation({
      platform: 'darwin', run: async () => { throw new Error('must not call'); },
    })).toMatchObject({ state: 'unsupported' });
  });
});
