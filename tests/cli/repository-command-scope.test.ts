import { describe, expect, test } from 'bun:test';
import {
  assertRepositoryCommandInputAllowed,
  assertRepositoryCommandNoPluginExecutionBypass,
  assertRepositoryCommandStableHostIdentity,
} from '../../src/cli/repositories/command-scope';

describe('repository command stable macOS host identity', () => {
  test('rejects direct and shell-wrapped TCC-sensitive tools', () => {
    const denied: Array<string | string[]> = [
      ['/usr/bin/osascript', '-e', 'tell application "Google Chrome" to get URL of active tab of front window'],
      ['/usr/sbin/screencapture', '-x', 'capture.png'],
      `osascript <<'APPLESCRIPT'\ntell application "Google Chrome" to get URL of active tab of front window\nAPPLESCRIPT`,
      ['bash', '-lc', `osascript <<'APPLESCRIPT'\ntell application "Google Chrome" to get URL of active tab of front window\nAPPLESCRIPT`],
      ['zsh', '-c', '/usr/sbin/screencapture -x capture.png'],
    ];

    for (const command of denied) {
      expect(() => assertRepositoryCommandStableHostIdentity(command)).toThrow(/COMMAND_POLICY_DENIED: .*macOS TCC-sensitive.*stable Forge Desktop Operator\/browser capability/);
    }
  });

  test('rejects inline eval that bypasses typed Forge plugin execution while preserving ordinary eval', () => {
    const browserSource = `import { executeBrowserPluginAction } from './src/runtime/plugins/browser-adapter'; await executeBrowserPluginAction({});`;
    const storeSource = `import { submitAssistantPluginAction } from './src/runtime/plugins/store'; await submitAssistantPluginAction({});`;
    const genericSource = `import { executeAssistantPluginAction } from './src/runtime/plugins/first-party-registry'; await executeAssistantPluginAction({});`;
    const denied: Array<string | string[]> = [
      ['bun', '-e', browserSource],
      ['node', '--eval', storeSource],
      ['zsh', '-c', `bun -e ${JSON.stringify(genericSource)}`],
      `node --eval ${JSON.stringify(browserSource)}`,
    ];
    for (const command of denied) {
      expect(() => assertRepositoryCommandNoPluginExecutionBypass(command)).toThrow('PLUGIN_ACTION_EXECUTION_REQUIRES_TYPED_PLUGIN_TOOL');
    }

    expect(() => assertRepositoryCommandNoPluginExecutionBypass(['node', '-e', 'process.stdout.write("ok")'])).not.toThrow();
    expect(() => assertRepositoryCommandNoPluginExecutionBypass(['bun', '-e', `import './src/runtime/plugins/browser-adapter'; console.log('manifest only')`])).not.toThrow();
    expect(() => assertRepositoryCommandNoPluginExecutionBypass(['bun', '-e', `const executeBrowserPluginAction = 'documentation string'; console.log(executeBrowserPluginAction)`])).not.toThrow();
  });

  test('does not reject ordinary repository text searches that mention TCC tools', () => {
    expect(assertRepositoryCommandStableHostIdentity(['rg', '-n', 'osascript|screencapture', 'src']).kind).toBe('argv');
    expect(assertRepositoryCommandStableHostIdentity('rg -n "osascript|screencapture" src').kind).toBe('shell');
  });

  test('keeps opaque scripts denied by default and opens only the bounded internal lane explicitly', () => {
    const shell = ['bash', '-lc', 'printf local > marker.txt']; const inline = ['bun', '-e', 'console.log("ok")'];
    expect(() => assertRepositoryCommandInputAllowed(shell)).toThrow('nested shell execution is not allowed'); expect(() => assertRepositoryCommandInputAllowed(inline)).toThrow('inline interpreter execution is not allowed');
    expect(assertRepositoryCommandInputAllowed(shell, { allowOpaqueLocalScript: true }).kind).toBe('argv'); expect(assertRepositoryCommandInputAllowed(inline, { allowOpaqueLocalScript: true }).kind).toBe('argv');
    expect(assertRepositoryCommandStableHostIdentity(inline).kind).toBe('argv');
  });
});
