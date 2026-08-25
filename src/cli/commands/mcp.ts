import { Command } from 'commander';
import { isAbsolute, relative } from 'path';
import { createMcpToolContext } from '../mcp/server';
import { startMcpHttp } from '../mcp/transports/http';
import { startMcpStdio } from '../mcp/transports/stdio';
import { callMcpTool } from '../mcp/tools';
import { callAccessTool } from '../mcp/access-tools';
import { assertControllerLifecycleOwner } from '../controller/lifecycle-authority';
import { bindInheritedRuntimeWriteClaimFromEnvironment } from '../../runtime/root/write-fence';
import {
  runMcpDoctor,
  runMcpPrintGuide,
  runMcpSetupChatgpt,
  runMcpSetupCodex,
  runMcpSetupClaude,
} from '../mcp/setup';

export interface McpServeOptions {
  repo?: string;
  controllerHome?: string;
  transport: string;
  host: string;
  port: string;
  profile: string;
  auth?: string;
  enableChatgptBrowser?: boolean;
  enableDevRunner?: boolean;
  devRunnerAgents?: string;
  devRunnerTimeoutMs?: string;
  devRunnerMaxTimeoutMs?: string;
  toolset?: 'facade' | 'core' | 'advanced' | 'full';
}

interface McpAccessOptions {
  repo?: string;
  controllerHome?: string;
  repoId?: string;
  allRepositories?: boolean;
  mode?: string;
  confirmAuthorization?: boolean;
  confirmationText?: string;
}

interface McpSetupChatgptOptions {
  repo?: string;
  controllerHome?: string;
  userLevel?: boolean;
  host?: string;
  port?: string;
  endpoint?: string;
  serverName?: string;
  localControllerPort?: string;
  connectorPort?: string;
}

interface McpSetupLocalControllerOptions {
  repo?: string;
  scope?: string;
  profile?: string;
  dryRun?: boolean;
}


interface McpPrepareGoalOptions {
  repo?: string;
  prd: string;
  sprint: string;
  referenceRepo?: string;
  extraInstructions?: string;
  overwrite?: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port "${value}"`);
  }
  return port;
}

function parsePositiveIntegerOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid --${name} "${value}"`);
  return parsed;
}

async function runMcpAction(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`forge mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

async function runRepositoryAccessCommand(
  toolName: 'repository_access_get' | 'repository_access_set',
  rawOpts: McpAccessOptions,
): Promise<void> {
  const ctx = createMcpToolContext({
    repo: rawOpts.repo ?? '.',
    controllerHome: rawOpts.controllerHome,
    profile: 'controller',
    toolset: 'core',
  });
  const result = callAccessTool(ctx, toolName, {
    repo_id: rawOpts.repoId,
    all_repositories: rawOpts.allRepositories === true,
    mode: rawOpts.mode,
    confirm_authorization: rawOpts.confirmAuthorization === true,
    confirmation_text: rawOpts.confirmationText,
  });
  if (!result) throw new Error(`ACCESS_POLICY_FAILED: unsupported access tool ${toolName}`);
  const firstContent = result.content[0];
  const payload = result.structuredContent
    ?? JSON.parse(firstContent?.type === 'text' ? firstContent.text : '{}');
  const error = (payload as { error?: { code?: string; message?: string } }).error;
  if (result.isError || error) {
    throw new Error(`${error?.code ?? 'ACCESS_POLICY_FAILED'}: ${error?.message ?? 'repository access operation failed'}`);
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function prepareCodexGoalFromSprint(rawOpts: McpPrepareGoalOptions): Promise<string[]> {
  const ctx = createMcpToolContext({ repo: rawOpts.repo ?? '.', profile: 'planner' });
  const prdPath = toRepoRelativeInput(ctx.repoRoot, rawOpts.prd);
  const sprintPath = toRepoRelativeInput(ctx.repoRoot, rawOpts.sprint);
  const result = await callMcpTool(ctx, 'prepare_codex_goal_from_sprint', {
    prd_path: prdPath,
    sprint_path: sprintPath,
    goal_prd_path: rawOpts.prd,
    goal_sprint_path: rawOpts.sprint,
    reference_repo: rawOpts.referenceRepo,
    extra_instructions: rawOpts.extraInstructions,
    overwrite: rawOpts.overwrite === true,
  });
  const firstContent = result.content[0];
  const payload = JSON.parse(firstContent?.type === 'text' ? firstContent.text : '{}');
  if (payload.error) {
    throw new Error(`${payload.error.code}: ${payload.error.message}`);
  }
  return [
    `[forge mcp] Codex goal: ${payload.path}`,
    '[forge mcp] Host-native /goal prompt:',
    '',
    String(payload.prompt ?? '').trimEnd(),
  ];
}

function toRepoRelativeInput(repoRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const relativePath = relative(repoRoot, path).split('\\').join('/');
  if (relativePath === '' || relativePath.startsWith('../') || relativePath === '..') return path;
  return relativePath;
}

export function buildMcpCommand(): Command {
  const mcp = new Command('mcp').description('Run and configure the forge MCP workflow sidecar');

  mcp
    .command('serve')
    .description('Start the forge MCP server')
    .option('--repo <path>', 'Repository root to expose through the selected MCP profile')
    .option('--controller-home <path>', 'Controller state root; defaults to repo _ops/controller-home when present')
    .option('--transport <transport>', 'Transport: stdio|http', 'stdio')
    .option('--host <host>', 'HTTP bind host', '127.0.0.1')
    .option('--port <port>', 'HTTP bind port', '8765')
    .option('--profile <profile>', 'MCP profile: planner|executor|orchestrator|controller', 'controller')
    .option('--toolset <toolset>', 'Controller toolset: facade|core|advanced|full (default advanced; facade is an explicit five-tool ChatGPT surface)')
    .option('--auth <mode>', 'HTTP auth mode: oauth|bearer|none', 'oauth')
    .option('--enable-chatgpt-browser', 'Expose tools that operate the user logged-in ChatGPT Web browser session')
    .option('--enable-dev-runner', 'Enable local Codex/Claude task runners for controller or orchestrator profiles')
    .option('--dev-runner-agents <agents>', 'Comma-separated dev runner agents: codex,claude')
    .option('--dev-runner-timeout-ms <ms>', 'Default local agent timeout in milliseconds (default: 3600000)')
    .option('--dev-runner-max-timeout-ms <ms>', 'Maximum per-run timeout in milliseconds (default: 43200000)')
    .action(async (rawOpts: McpServeOptions) => {
      await runMcpAction(async () => {
        bindInheritedRuntimeWriteClaimFromEnvironment();
        const devRunnerTimeoutMs = parsePositiveIntegerOption('dev-runner-timeout-ms', rawOpts.devRunnerTimeoutMs);
        const devRunnerMaxTimeoutMs = parsePositiveIntegerOption('dev-runner-max-timeout-ms', rawOpts.devRunnerMaxTimeoutMs);
        if (rawOpts.transport === 'stdio') {
          await startMcpStdio({
            // stdio preserves its historical current-directory default.
            // The HTTP controller Gateway deliberately leaves this unset so
            // it can serve Controller Home without registering a launchd
            // working directory as a repository.
            repo: rawOpts.repo ?? '.',
            controllerHome: rawOpts.controllerHome,
            profile: rawOpts.profile,
            toolset: rawOpts.toolset,
            enableChatgptBrowser: rawOpts.enableChatgptBrowser === true,
            enableDevRunner: rawOpts.enableDevRunner,
            devRunnerAgents: rawOpts.devRunnerAgents,
            devRunnerTimeoutMs,
            devRunnerMaxTimeoutMs,
          });
          return;
        }
        if (rawOpts.transport === 'http') {
          if (rawOpts.profile === 'controller') assertControllerLifecycleOwner('Controller MCP HTTP server');
          await startMcpHttp({
            repo: rawOpts.repo,
            controllerHome: rawOpts.controllerHome,
            profile: rawOpts.profile,
            toolset: rawOpts.toolset,
            host: rawOpts.host,
            port: parsePort(rawOpts.port),
            auth: rawOpts.auth,
            enableChatgptBrowser: rawOpts.enableChatgptBrowser === true,
            enableDevRunner: rawOpts.enableDevRunner,
            devRunnerAgents: rawOpts.devRunnerAgents,
            devRunnerTimeoutMs,
            devRunnerMaxTimeoutMs,
          });
          return;
        }
        throw new Error(`serve: invalid --transport "${rawOpts.transport}" (expected: stdio, http)`);
      });
    });

  mcp
    .command('doctor')
    .description('Check forge MCP setup status')
    .option('--repo <path>', 'Repository root to inspect', '.')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { repo?: string; json?: boolean }) => {
      void runMcpAction(() => {
        const result = runMcpDoctor(rawOpts);
        console.log(result.lines.join('\n'));
      });
    });

  const setup = new Command('setup').description('Configure an external controller connection to Forge');

  setup
    .command('chatgpt')
    .description('Generate ChatGPT Connector local config and manual setup guide')
    .option('--repo <path>', 'Repository root to configure', '.')
    .option('--controller-home <path>', 'User Controller Home (used with --user-level)')
    .option('--user-level', 'Configure the user-level Controller without writing repository guide/gitignore files')
    .option('--host <host>', 'Local MCP HTTP bind host', '127.0.0.1')
    .option('--port <port>', 'Local MCP HTTP bind port', '8765')
    .option('--local-controller-port <port>', 'Local-only Utility Console port; defaults to MCP port + 1')
    .option('--connector-port <port>', 'Loopback OAuth connector port for ChatGPT tunnels; defaults to MCP port + 2')
    .option('--endpoint <url>', 'Stable public HTTPS /mcp endpoint to store in ignored local config')
    .option('--server-name <name>', 'ChatGPT Connector/MCP server name to record in ignored local config')
    .action((rawOpts: McpSetupChatgptOptions) => {
      void runMcpAction(() => {
        const result = runMcpSetupChatgpt(rawOpts);
        console.log(result.lines.join('\n'));
      });
    });

  setup
    .command('codex')
    .description('Configure Codex as an explicit Forge controller or executor')
    .option('--repo <path>', 'Repository root to configure', '.')
    .option('--scope <scope>', 'Config scope: project|user', 'project')
    .option('--profile <profile>', 'Forge MCP role: controller|executor', 'executor')
    .option('--dry-run', 'Print planned changes without writing files')
    .action((rawOpts: McpSetupLocalControllerOptions) => {
      void runMcpAction(() => {
        const result = runMcpSetupCodex(rawOpts);
        console.log(result.lines.join('\n'));
      });
    });


  setup
    .command('claude')
    .description('Configure Claude Code as an explicit Forge controller or executor through the Claude CLI')
    .option('--repo <path>', 'Repository root to expose initially', '.')
    .option('--scope <scope>', 'Claude MCP scope: local|project|user', 'user')
    .option('--profile <profile>', 'Forge MCP role: controller|executor', 'controller')
    .option('--dry-run', 'Print the Claude MCP command without changing Claude config')
    .action((rawOpts: McpSetupLocalControllerOptions) => {
      void runMcpAction(() => {
        const result = runMcpSetupClaude(rawOpts);
        console.log(result.lines.join('\n'));
      });
    });

  mcp.addCommand(setup);

  const access = new Command('access').description('Read or change repository Request / Full Access permission levels');

  access
    .command('get')
    .description('Read the access mode for one registered repository')
    .option('--repo <path>', 'Repository root used to resolve controllerHome', '.')
    .option('--controller-home <path>', 'Controller state root; defaults to repo _ops/controller-home when present')
    .option('--repo-id <id>', 'Stable registered repository id')
    .action((rawOpts: McpAccessOptions) => {
      void runMcpAction(() => runRepositoryAccessCommand('repository_access_get', rawOpts));
    });

  access
    .command('set')
    .description('Set Request or Full Access for one repository or every enabled repository')
    .option('--repo <path>', 'Repository root used to resolve controllerHome', '.')
    .option('--controller-home <path>', 'Controller state root; defaults to repo _ops/controller-home when present')
    .option('--repo-id <id>', 'Stable registered repository id; cannot be combined with --all-repositories')
    .option('--all-repositories', 'Apply to every enabled registered repository')
    .requiredOption('--mode <mode>', 'Access mode: request|full_access')
    .option('--confirm-authorization', 'Confirm the access policy write')
    .option('--confirmation-text <text>', 'Legacy optional confirmation text; access changes require --confirm-authorization')
    .action((rawOpts: McpAccessOptions) => {
      void runMcpAction(() => runRepositoryAccessCommand('repository_access_set', rawOpts));
    });

  mcp.addCommand(access);


  mcp
    .command('prepare-goal')
    .description('Prepare .ai/harness/controller/packets/codex-goal.md and print a host-native /goal prompt from a PRD and checklist Sprint')
    .option('--repo <path>', 'Repository root to configure', '.')
    .requiredOption('--prd <path>', 'PRD path to read')
    .requiredOption('--sprint <path>', 'Checklist Sprint path to execute')
    .option('--reference-repo <path>', 'Read-only reference repo path to include in the Goal')
    .option('--extra-instructions <text>', 'Additional bounded execution instruction for Codex')
    .option('--overwrite', 'Replace an existing Codex goal handoff')
    .action((rawOpts: McpPrepareGoalOptions) => {
      void runMcpAction(async () => {
        const lines = await prepareCodexGoalFromSprint(rawOpts);
        console.log(lines.join('\n'));
      });
    });

  mcp
    .command('print-chatgpt-guide')
    .description('Print the ChatGPT Connector setup guide')
    .option('--repo <path>', 'Repository root to inspect', '.')
    .option('--endpoint <url>', 'Public HTTPS /mcp endpoint to include in the guide')
    .option('--write', 'Write docs/forge-chatgpt-mcp-setup.md')
    .action((rawOpts: { repo?: string; endpoint?: string; write?: boolean }) => {
      void runMcpAction(() => {
        const result = runMcpPrintGuide(rawOpts);
        console.log(result.lines.join('\n'));
      });
    });

  return mcp;
}
