import { spawnSync } from 'child_process';
import type { ControllerType } from '../../../../packages/kernel/controller/api/index';
import { claudeMcpConfigArgs, codexMcpConfigArgs, type ProviderMcpBootstrap } from './provider-mcp-bootstrap';
import { repositoryChildProcessEnvironment } from '../../shared/process-environment';

export interface LauncherExecutableRequest {
  controllerType: Exclude<ControllerType, 'human'>;
  executable?: string;
  cwd: string;
}

export interface ExternalControllerInvocationRequest extends LauncherExecutableRequest {
  args?: string[];
}

export function launcherProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const repositoryEnv = repositoryChildProcessEnvironment(env);
  return {
    ...env,
    PATH: repositoryEnv.PATH,
  };
}

export function resolveLauncherExecutable(
  request: LauncherExecutableRequest,
  env: NodeJS.ProcessEnv = process.env,
  probeAvailability = true,
): string {
  if (request.controllerType === 'chatgpt') {
    throw new Error('LAUNCHER_CHATGPT_SESSION_OWNED');
  }
  const configured = request.executable?.trim();
  if (configured) return configured;
  const executable = request.controllerType === 'codex'
    ? 'codex'
    : request.controllerType === 'claude'
      ? 'claude'
      : '';
  if (!executable) throw new Error(`LAUNCHER_EXECUTABLE_REQUIRED: ${request.controllerType} requires an external launcher executable`);
  if (!probeAvailability) return executable;
  const probe = spawnSync(executable, ['--version'], {
    cwd: request.cwd,
    stdio: 'ignore',
    timeout: 5_000,
    env: launcherProcessEnvironment(env),
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`LAUNCHER_EXECUTABLE_UNAVAILABLE: ${executable}`);
  }
  return executable;
}

export interface CodexControllerInvocationRequest {
  executable: string;
  prompt: string;
  mcpBootstrap: ProviderMcpBootstrap;
  sandbox: 'read-only' | 'workspace-write';
  args?: string[];
  resumeSessionId?: string;
  json?: boolean;
}

export function buildCodexControllerInvocation(
  request: CodexControllerInvocationRequest,
): { executable: string; args: string[] } {
  const prefix = [
    '--ask-for-approval', 'never',
    '--disable', 'apps',
    ...codexMcpConfigArgs(request.mcpBootstrap),
    'exec',
  ];
  if (request.resumeSessionId?.trim()) {
    return {
      executable: request.executable,
      args: [
        ...prefix,
        'resume', '--ignore-user-config',
        ...(request.json ? ['--json'] : []),
        ...(request.args ?? []),
        '--',
        request.resumeSessionId.trim(),
        request.prompt,
      ],
    };
  }
  return {
    executable: request.executable,
    args: [
      ...prefix,
      '--ignore-user-config', '--sandbox', request.sandbox,
      ...(request.json ? ['--json'] : []),
      ...(request.args ?? []),
      '--',
      request.prompt,
    ],
  };
}

export interface ClaudeControllerInvocationRequest {
  executable: string;
  prompt: string;
  mcpBootstrap: ProviderMcpBootstrap;
  args?: string[];
}

export function buildClaudeControllerInvocation(
  request: ClaudeControllerInvocationRequest,
): { executable: string; args: string[] } {
  const userArgs = request.args ?? [];
  if (userArgs.some(arg => arg === '--mcp-config' || arg.startsWith('--mcp-config='))) {
    throw new Error('LAUNCHER_CLAUDE_MCP_CONFIG_CONFLICT: caller must not provide --mcp-config when Forge MCP bootstrap is active');
  }
  if (userArgs.some(arg => arg === '--strict-mcp-config' || arg.startsWith('--strict-mcp-config='))) {
    throw new Error('LAUNCHER_CLAUDE_STRICT_MCP_CONFIG_CONFLICT: Forge manages strict-mcp-config');
  }
  return {
    executable: request.executable,
    args: [
      '--print',
      '--permission-mode', 'auto',
      ...claudeMcpConfigArgs(request.mcpBootstrap),
      ...userArgs,
      request.prompt,
    ],
  };
}

export function buildSuperControllerInvocation(
  request: ExternalControllerInvocationRequest,
  executable: string,
  prompt: string,
  mcpBootstrap?: ProviderMcpBootstrap,
): { executable: string; args: string[] } {
  if (request.controllerType === 'codex') {
    if (!mcpBootstrap) throw new Error('LAUNCHER_CODEX_FORGE_MCP_REQUIRED');
    return buildCodexControllerInvocation({
      executable,
      prompt,
      mcpBootstrap,
      sandbox: 'workspace-write',
      args: request.args,
    });
  }
  if (request.controllerType === 'claude') {
    if (!mcpBootstrap) throw new Error('LAUNCHER_CLAUDE_FORGE_MCP_REQUIRED');
    return buildClaudeControllerInvocation({
      executable,
      prompt,
      mcpBootstrap,
      args: request.args,
    });
  }
  if (request.controllerType === 'chatgpt') {
    throw new Error('LAUNCHER_CHATGPT_SESSION_OWNED');
  }
  return { executable, args: [...(request.args ?? []), prompt] };
}
