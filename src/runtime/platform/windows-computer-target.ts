import { ComputerProviderError, type ComputerProvider } from '../../../packages/plugin-runtime/computer/index';
import { COMPUTER_OBSERVE_CAPABILITY, type ComputerObserveRequest } from '../../../packages/protocols/computer/index';
import { AssistantPluginError } from '../plugins/errors';
import type { AssistantPluginActionExecutionInput, AssistantPluginAdapter } from '../plugins/types';
import { executeWindowsComputerProbe, type WindowsComputerProbeDependencies } from './windows-computer-observation';

export const WINDOWS_COMPUTER_PROVIDER_ID = 'windows-uia';
type Binding = { pid: number; started: string; handle: string; session: number };
type NativeNode = { role: string; enabled: boolean; children: NativeNode[] };
type Observation = Binding & { appName: string; tree: NativeNode };

function failure(code: string, message: string): ComputerProviderError {
  return new ComputerProviderError(code, message, { retryable: false });
}
function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function validDigits(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}
function validSession(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function interactionId(b: Binding): string {
  return `windows-uia:v1:${b.pid}:${b.started}:${b.handle}:${b.session}`;
}
function parseBinding(id: unknown): Binding {
  const match =
    typeof id === 'string'
      ? /^windows-uia:v1:([1-9][0-9]{0,9}):([1-9][0-9]{0,19}):([1-9][0-9]{0,19}):([1-9][0-9]{0,9})$/.exec(id)
      : null;
  if (!match || !validPid(Number(match[1])) || !validSession(Number(match[4]))) {
    throw failure('WINDOWS_UIA_BINDING_INVALID', 'Use an exact Windows Computer target binding.');
  }
  return { pid: Number(match[1]), started: match[2]!, handle: match[3]!, session: Number(match[4]) };
}
function bound(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
function decodeTree(value: unknown, depth: number, budget: { left: number }): NativeNode {
  if (!value || typeof value !== 'object' || depth < 0 || --budget.left < 0) throw new Error('tree bounds');
  const node = value as Record<string, unknown>;
  if (
    typeof node.role !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(node.role) ||
    typeof node.enabled !== 'boolean' ||
    !Array.isArray(node.children)
  )
    throw new Error('tree shape');
  return {
    role: node.role,
    enabled: node.enabled,
    children: node.children.map((child) => decodeTree(child, depth - 1, budget)),
  };
}

async function observeExact(
  pid: number,
  expected: Binding | undefined,
  depth: number,
  nodes: number,
  dependencies: WindowsComputerProbeDependencies,
): Promise<Observation> {
  if (!validPid(pid))
    throw failure('WINDOWS_UIA_PID_REQUIRED', 'Provide one exact already-running Windows process_id.');
  // Only validated numeric identity fields enter this fixed read-only script.
  // No titles, values, document text, passwords, input APIs or window activation.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName UIAutomationClient',
    `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
    '$started = $process.StartTime.ToUniversalTime().Ticks.ToString()',
    '$session = $process.SessionId',
    '$handle = $process.MainWindowHandle.ToInt64()',
    'if ($handle -le 0 -or $session -le 0 -or $session -ne [System.Diagnostics.Process]::GetCurrentProcess().SessionId) { throw "NO_INTERACTIVE_WINDOW" }',
    ...(expected
      ? [
          `if ($started -ne '${expected.started}' -or $handle.ToString() -ne '${expected.handle}' -or $session -ne ${expected.session}) { throw "STALE_BINDING" }`,
        ]
      : []),
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)',
    'if ($null -eq $root -or $root.Current.ProcessId -ne $process.Id -or $root.Current.NativeWindowHandle -ne $handle) { throw "WINDOW_MISMATCH" }',
    '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
    `$script:remaining = ${nodes}`,
    'function Read-Node($element, [int]$depth) {',
    '  $script:remaining--',
    '  $children = [System.Collections.Generic.List[object]]::new()',
    '  if ($depth -gt 0 -and $script:remaining -gt 0) {',
    '    $child = $walker.GetFirstChild($element)',
    '    while ($null -ne $child -and $script:remaining -gt 0) {',
    '      if ($child.Current.ProcessId -eq $process.Id) { $children.Add((Read-Node $child ($depth - 1))) }',
    '      $child = $walker.GetNextSibling($child)',
    '    }',
    '  }',
    '  return [pscustomobject]@{role=$element.Current.ControlType.ProgrammaticName;enabled=$element.Current.IsEnabled;children=$children.ToArray()}',
    '}',
    `$tree = Read-Node $root ${depth}`,
    '$process.Refresh()',
    'if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $started -or $process.MainWindowHandle.ToInt64() -ne $handle -or $root.Current.ProcessId -ne $process.Id -or $root.Current.NativeWindowHandle -ne $handle) { throw "WINDOW_CHANGED" }',
    '[pscustomobject]@{pid=$process.Id;started=$started;handle=$handle.ToString();session=$session;appName=$process.ProcessName;tree=$tree} | ConvertTo-Json -Depth 30 -Compress',
  ].join('\n');
  try {
    const raw = JSON.parse(await executeWindowsComputerProbe(script, dependencies)) as Record<string, unknown>;
    if (
      raw.pid !== pid ||
      !validDigits(raw.started) ||
      !validDigits(raw.handle) ||
      !validSession(raw.session) ||
      typeof raw.appName !== 'string' ||
      !raw.appName.trim() ||
      raw.appName.length > 256 ||
      (expected &&
        (raw.started !== expected.started || raw.handle !== expected.handle || raw.session !== expected.session))
    ) {
      throw new Error('identity mismatch');
    }
    return {
      pid,
      started: raw.started,
      handle: raw.handle,
      session: raw.session,
      appName: raw.appName,
      tree: decodeTree(raw.tree, depth, { left: nodes }),
    };
  } catch {
    throw failure(
      expected ? 'WINDOWS_UIA_BINDING_STALE' : 'WINDOWS_UIA_TARGET_UNVERIFIED',
      'Windows could not verify the exact interactive process and main window. No alternative window was selected.',
    );
  }
}

export function createWindowsComputerProvider(dependencies: WindowsComputerProbeDependencies = {}): ComputerProvider {
  return {
    providerId: WINDOWS_COMPUTER_PROVIDER_ID,
    capabilities: [COMPUTER_OBSERVE_CAPABILITY],
    async execute(request) {
      if (request.capability !== COMPUTER_OBSERVE_CAPABILITY) {
        throw failure(
          'WINDOWS_UIA_ACTION_UNSUPPORTED',
          'Windows provider currently supports read-only observation only.',
        );
      }
      const args = request as ComputerObserveRequest;
      if (args.rootSelector || args.includeValues === true) {
        throw failure(
          'WINDOWS_UIA_OBSERVATION_SCOPE_UNSUPPORTED',
          'Windows observation currently supports a bounded main-window control tree without values or selectors.',
        );
      }
      const binding = parseBinding(args.interactionId);
      const observed = await observeExact(
        binding.pid,
        binding,
        bound(args.maxDepth, 3, 6),
        bound(args.maxNodes, 64, 128),
        dependencies,
      );
      return {
        observed: true,
        observationOnly: true,
        interactionId: args.interactionId,
        pid: observed.pid,
        appName: observed.appName,
        scope: 'main_window',
        tree: observed.tree,
      };
    },
  };
}

/** Session management is a facade over the existing durable target authority,
 * not a second target registry. The binding includes process birth + window
 * identity and is revalidated in every worker. Close never terminates an app. */
export function createWindowsDesktopSessionProvider(
  dependencies: WindowsComputerProbeDependencies = {},
): Pick<AssistantPluginAdapter, 'executeAction' | 'resolveAuthorizationContext'> {
  return {
    async executeAction(input: AssistantPluginActionExecutionInput) {
      try {
        if (input.actionId === 'desktop_session_open') {
          const args = input.args;
          if (
            args.launch === true ||
            args.activate === true ||
            args.bundle_id !== undefined ||
            args.bundle_path !== undefined ||
            !validPid(args.process_id) ||
            typeof args.app_name !== 'string' ||
            !args.app_name.trim()
          ) {
            throw failure(
              'WINDOWS_UIA_EXACT_TARGET_REQUIRED',
              'Windows observation requires app_name and exact process_id, without launch, activation or bundle selectors.',
            );
          }
          const observed = await observeExact(args.process_id, undefined, 0, 1, dependencies);
          if (observed.appName !== args.app_name)
            throw failure('WINDOWS_UIA_TARGET_IDENTITY_MISMATCH', 'Windows returned a different process name.');
          return {
            interactionId: interactionId(observed),
            pid: observed.pid,
            exactProcessId: observed.pid,
            appName: observed.appName,
            applicationOwnership: 'preexisting',
          };
        }
        if (input.actionId === 'desktop_session_close') {
          parseBinding(input.args.interaction_id);
          if (input.args.terminate_owned_pid !== undefined)
            throw failure('WINDOWS_UIA_TERMINATION_UNSUPPORTED', 'Windows observation never terminates applications.');
          return { closed: true, termination_outcome: 'not_requested' };
        }
        throw failure(
          'WINDOWS_UIA_ACTION_UNSUPPORTED',
          'Windows session provider only attaches or retires exact read-only targets.',
        );
      } catch (error) {
        if (error instanceof ComputerProviderError)
          throw new AssistantPluginError(error.code, error.detailMessage, {
            retryable: false,
            effectOutcome: 'failed',
          });
        throw error;
      }
    },
  };
}
