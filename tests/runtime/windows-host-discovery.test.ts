import { describe, expect, test } from 'bun:test';
import {
  discoverWslWindowsDriveMounts,
  discoverWslWindowsHostEnvironment,
  windowsPathToHostPath,
} from '../../src/runtime/platform/windows-host-discovery';
import { resolveWindowsRecoveryDeployment } from '../../src/runtime/platform/windows-recovery-deployment';

describe('Windows host discovery portability', () => {
  test('discovers drive mounts without assuming /mnt/c', () => {
    const mounts = discoverWslWindowsDriveMounts([
      'D:\\ /windows/d 9p rw,relatime,aname=drvfs;path=D:\\ 0 0',
      'C:\\ /host/c drvfs rw,relatime 0 0',
    ].join('\n'));
    expect(mounts).toEqual({ d: '/windows/d', c: '/host/c' });
    expect(windowsPathToHostPath('D:\\Users\\Alice\\AppData\\Local', mounts)).toBe('/windows/d/Users/Alice/AppData/Local');
    expect(windowsPathToHostPath('C:\\Program Files\\Browser\\browser.exe', mounts)).toBe('/host/c/Program Files/Browser/browser.exe');
  });

  test('uses Windows host environment instead of assuming the WSL username matches', () => {
    const mountTable = 'D:\\ /windows/d drvfs rw,relatime 0 0';
    const commandExecutable = '/windows/d/Windows/System32/cmd.exe';
    const environment = discoverWslWindowsHostEnvironment({
      mountTable,
      fileExists: (path) => path === commandExecutable,
      runCommand: (executable, args) => {
        expect(executable).toBe(commandExecutable);
        expect(args).toContain('/c');
        return {
          status: 0,
          stdout: [
            'FORGE_USERPROFILE=D:\\Users\\WindowsOwner',
            'FORGE_LOCALAPPDATA=D:\\Users\\WindowsOwner\\AppData\\Local',
            'FORGE_PROGRAMFILES=D:\\Apps',
            'FORGE_PROGRAMFILES_X86=D:\\Apps32',
          ].join('\r\n'),
        };
      },
    });
    expect(environment).toMatchObject({
      commandExecutable,
      userProfileWindows: 'D:\\Users\\WindowsOwner',
      userProfile: '/windows/d/Users/WindowsOwner',
      localAppData: '/windows/d/Users/WindowsOwner/AppData/Local',
      programFiles: ['/windows/d/Apps', '/windows/d/Apps32'],
      driveMounts: { d: '/windows/d' },
    });
  });

  test('binds Recovery deployment to discovered Windows locations without C-drive or canonical rescue-root assumptions', () => {
    const host = discoverWslWindowsHostEnvironment({
      mountTable: 'D:\\ /windows/d drvfs rw,relatime 0 0',
      fileExists: (path) => path === '/windows/d/Windows/System32/cmd.exe',
      runCommand: () => ({
        status: 0,
        stdout: [
          'FORGE_USERPROFILE=D:\\Users\\DifferentWindowsUser',
          'FORGE_LOCALAPPDATA=D:\\Users\\DifferentWindowsUser\\AppData\\Local',
          'FORGE_PROGRAMFILES=D:\\Apps',
          'FORGE_PROGRAMDATA=D:\\ProgramData',
          'FORGE_SYSTEMROOT=D:\\Windows',
        ].join('\r\n'),
      }),
    });
    expect(host).toBeDefined();
    const binding = resolveWindowsRecoveryDeployment({ rescueRoot: '/var/lib/forge-recovery-test', host });
    expect(binding).toEqual({
      schemaVersion: 1,
      rescueRoot: '/var/lib/forge-recovery-test',
      recoveryScriptHostPath: '/windows/d/ProgramData/ForgeRecovery/ForgeRecovery.ps1',
      recoveryScriptWindowsPath: 'D:\\ProgramData\\ForgeRecovery\\ForgeRecovery.ps1',
      powershellHostPath: '/windows/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      powershellWindowsPath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      source: 'discovered',
    });
  });

});
