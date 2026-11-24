import { expect, test } from 'bun:test';
import { COMPUTER_OBSERVE_CAPABILITY, COMPUTER_INPUT_CAPABILITY } from '../../packages/protocols/computer/index';
import {
  createWindowsComputerProvider,
  createWindowsDesktopSessionProvider,
} from '../../src/runtime/platform/windows-computer-target';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

const mountTable = 'C:\\\\ /mnt/c 9p rw,aname=drvfs;path=C:\\\\,uid=1001 0 0\n';
const observed = {
  pid: 123,
  started: '638000000000000000',
  handle: '4138',
  session: 1,
  appName: 'chrome',
  tree: { role: 'ControlType.Window', enabled: true, children: [] },
};
function fixture() {
  let current = { ...observed };
  let calls = 0;
  const deps = {
    platform: 'linux',
    mountTable,
    fileExists: () => true,
    run: async (_: string, args: readonly string[]) => {
      calls++;
      const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
      expect(script).toContain('Get-Process -Id 123');
      expect(script).not.toContain('SendKeys');
      return JSON.stringify(current);
    },
  };
  return {
    deps,
    calls: () => calls,
    change: (patch: Partial<typeof observed>) => {
      current = { ...current, ...patch };
    },
  };
}
function input(actionId: string, args: Record<string, unknown>): AssistantPluginActionExecutionInput {
  return {
    controllerHome: '/tmp/fixture',
    repoId: 'test',
    repoRoot: '/tmp/fixture',
    pluginId: 'computer',
    actionId,
    requestId: 'fixture',
    args,
    origin: { surface: 'system', actor: 'test' },
  } as AssistantPluginActionExecutionInput;
}
test('Windows exact session supports observation in another provider instance and does not terminate the process', async () => {
  const f = fixture();
  const sessions = createWindowsDesktopSessionProvider(f.deps);
  const opened = await sessions.executeAction(
    input('desktop_session_open', { app_name: 'chrome', process_id: 123, launch: false }),
  );
  expect(opened).toMatchObject({
    pid: 123,
    appName: 'chrome',
    exactProcessId: 123,
    applicationOwnership: 'preexisting',
  });
  const id = opened.interactionId as string;
  const provider = createWindowsComputerProvider(f.deps);
  expect(
    await provider.execute({ capability: COMPUTER_OBSERVE_CAPABILITY, action: 'observe', interactionId: id }, 10000),
  ).toMatchObject({ observed: true, observationOnly: true, pid: 123, appName: 'chrome', tree: observed.tree });
  expect(await sessions.executeAction(input('desktop_session_close', { interaction_id: id }))).toMatchObject({
    closed: true,
    termination_outcome: 'not_requested',
  });
  expect(f.calls()).toBe(2);
});
test('reused PID, changed window and unsupported actions fail closed', async () => {
  const f = fixture();
  const sessions = createWindowsDesktopSessionProvider(f.deps);
  const id = (await sessions.executeAction(input('desktop_session_open', { app_name: 'chrome', process_id: 123 })))
    .interactionId as string;
  const provider = createWindowsComputerProvider(f.deps);
  for (const patch of [{ started: '638000000000000001' }, { started: observed.started, handle: '4140' }]) {
    f.change(patch);
    await expect(
      provider.execute({ capability: COMPUTER_OBSERVE_CAPABILITY, action: 'observe', interactionId: id }, 10000),
    ).rejects.toThrow('WINDOWS_UIA_BINDING_STALE');
  }
  await expect(
    provider.execute(
      { capability: COMPUTER_INPUT_CAPABILITY, action: 'key', interactionId: id, keys: ['Return'] },
      10000,
    ),
  ).rejects.toThrow('WINDOWS_UIA_ACTION_UNSUPPORTED');
  await expect(
    sessions.executeAction(input('desktop_session_open', { app_name: 'chrome', process_id: 123, activate: true })),
  ).rejects.toThrow('WINDOWS_UIA_EXACT_TARGET_REQUIRED');
  await expect(
    sessions.executeAction(input('desktop_session_close', { interaction_id: id, terminate_owned_pid: 123 })),
  ).rejects.toThrow('WINDOWS_UIA_TERMINATION_UNSUPPORTED');
});
test('unverified process name cannot create a Windows session', async () => {
  const f = fixture();
  await expect(
    createWindowsDesktopSessionProvider(f.deps).executeAction(
      input('desktop_session_open', { app_name: 'other', process_id: 123 }),
    ),
  ).rejects.toThrow('WINDOWS_UIA_TARGET_IDENTITY_MISMATCH');
});
