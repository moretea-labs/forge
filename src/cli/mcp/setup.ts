import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isIP } from "net";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";
import {
  ensureMcpControllerHomeBearerToken,
  ensureMcpControllerHomeOAuthPassphrase,
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  mcpControllerHomeLocalConfigPath,
  mcpControllerHomeOAuthPath,
  mcpControllerHomeRuntimeStatePath,
  mcpControllerHomeTokenPath,
  mcpOAuthPath,
  mcpRuntimeStatePath,
  mcpTokenPath,
} from "./auth";
import { resolveMcpRepoRoot } from "./repo";
import {
  FORGE_TOOL_SURFACE,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
} from "../controller/runtime-config";
import { ensureControllerHome, ensureRepoPreferredControllerHome } from "../repositories/controller-home";
import { accessModeForLegacyToolset } from "./access-mode";
import { migrateControllerToolsetConfig } from "./toolset-selection";

export interface McpSetupResult {
  status: "ok";
  repoRoot: string;
  changed: string[];
  lines: string[];
}

const REQUIRED_CODEX_TOOLS = [
  "harness_status",
  "read_workflow_file",
  "latest_session_context",
  "latest_checks",
  "prepare_codex_goal_from_sprint",
  "write_codex_goal",
  "run_workflow_check",
];

const CHATGPT_MCP_ENDPOINT_PLACEHOLDER = "<https-tunnel-url>/mcp";
const CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER = "<named-tunnel-host>";
const DEFAULT_CHATGPT_MCP_SERVER_NAME = "forge";
const LEGACY_DEFAULT_SERVER_NAMES = new Set([
  "forge",
  "forge-controller-v1",
  "forge-controller-v2",
  "forge-controller-v3",
  "forge-controller-v4",
  "forge-controller-v5",
  "forge-controller-v6",
]);
const ENDPOINT_ERROR =
  "expected a public HTTPS URL exactly ending in /mcp with no username, password, query, or fragment";
const SERVER_NAME_ERROR =
  "expected a ChatGPT MCP server name using 1-80 letters, numbers, spaces, dots, underscores, or hyphens";

function writeFileIfChanged(
  path: string,
  content: string,
  changed: string[],
): void {
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  changed.push(path);
}

function ensureGitignoreEntries(
  repoRoot: string,
  entries: string[],
  changed: string[],
): void {
  const path = join(repoRoot, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = current.split(/\r?\n/);
  let next = current.trimEnd();
  for (const entry of entries) {
    if (lines.includes(entry)) continue;
    next += `${next.length > 0 ? "\n" : ""}${entry}`;
  }
  next += "\n";
  writeFileIfChanged(path, next, changed);
}

function isPrivateOrLocalIPv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateOrLocalIPv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const ipCandidate = normalized.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(ipCandidate);
  if (ipVersion === 4) return isPrivateOrLocalIPv4(ipCandidate);
  if (ipVersion === 6) return isPrivateOrLocalIPv6(ipCandidate);
  return false;
}

function normalizePublicMcpEndpoint(
  endpoint: string | undefined,
): string | undefined {
  if (endpoint === undefined) return undefined;
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    throw new Error(`invalid --endpoint "${endpoint}" (${ENDPOINT_ERROR})`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/mcp" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    isPrivateOrLocalHost(parsed.hostname)
  ) {
    throw new Error(`invalid --endpoint "${endpoint}" (${ENDPOINT_ERROR})`);
  }
  return parsed.toString();
}

function normalizeChatgptMcpServerName(value: string | undefined): string {
  const trimmed = (value ?? DEFAULT_CHATGPT_MCP_SERVER_NAME).trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 80 ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(trimmed) ||
    / {2,}/.test(trimmed)
  ) {
    throw new Error(
      `invalid --server-name "${value ?? ""}" (${SERVER_NAME_ERROR})`,
    );
  }
  return trimmed;
}

export function chatgptGuideMarkdown(
  endpoint = CHATGPT_MCP_ENDPOINT_PLACEHOLDER,
): string {
  return `# Forge ChatGPT Controller — Low-level Reference

> For normal onboarding, start with \`forge setup\` and [Tutorial 2](tutorials/02-connect-chatgpt.md). This file is the lower-level MCP reference and may also be regenerated by repository-scoped compatibility setup.

## Product model

Forge has no internal AI brain. ChatGPT is one external controller option: ChatGPT decides semantic next steps, while Forge owns bounded execution, durable state, authorization, Runtime lifecycle, and evidence. Codex/Claude are optional and are not enabled merely because they are installed.

## Normal package path

A repository is not required for the user-level ChatGPT connection:

\`\`\`bash
forge setup configure --controller chatgpt --tunnel auto
forge setup next
\`\`\`

The corresponding low-level commands are:

\`\`\`bash
forge mcp setup chatgpt --user-level
forge runtime service install-package
forge runtime status --json
\`\`\`

The Package Runtime does not require a Forge Git checkout, Bun compilation, CodeGraph, or Standalone Recovery. The older \`forge runtime service install --repo ...\` command is an advanced source/immutable-release path.

## Local boundaries

Forge MCP remains loopback-only, normally at:

\`\`\`text
http://127.0.0.1:8765/mcp
\`\`\`

The local Utility Console uses a separate loopback port (normally 8766). Never expose the Utility Console to the internet.

Service-level MCP configuration lives below \`Controller Home/mcp/\`. OAuth credentials and bearer fallback tokens are local secrets and must not be pasted into chat or committed. Repository-specific \`.forge/mcp.policy.json\` can narrow access when a repository is later adopted.

## Remote controller connection

The setup profile owns the connection choice. Supported paths are:

1. **OpenAI Secure MCP Tunnel** — preferred when the OpenAI organization/workspace has tunnel permission; no public inbound Forge endpoint is required. Forge stores only the non-secret \`tunnel_id\`. The runtime API key remains an \`env:\`/file reference owned by the official \`tunnel-client\`.
2. **Cloudflare Tunnel** — stable public/internet-reachable HTTPS endpoint.
3. **Tailscale Funnel** — HTTPS endpoint for compatible Tailscale environments.
4. **Existing HTTPS** — user-managed reverse proxy/tunnel ending in \`/mcp\`.
5. **None** — local setup only; remote connectivity can be configured later.

For OpenAI Secure MCP Tunnel, setup uses the official supervised runtime surface and considers it ready only when \`tunnel-client runtimes status forge --json\` reports the runtime running, healthy, and ready.

For public HTTPS paths, the configured connector URL is:

\`\`\`text
${endpoint}
\`\`\`

Record a stable endpoint with:

\`\`\`bash
forge setup configure --controller chatgpt --tunnel existing --endpoint https://forge.example.com/mcp
\`\`\`

Forge synchronizes an explicitly recorded endpoint into the user-level ChatGPT MCP configuration. A configured URL is not proof of live end-to-end connectivity; verify from ChatGPT with a real tool call.

## ChatGPT-side setup

ChatGPT developer-mode/MCP availability is controlled by the current ChatGPT plan and workspace policy. Follow OpenAI's current developer-mode documentation; Forge cannot bypass plan, administrator, RBAC, or tool-action restrictions.

- With **Secure MCP Tunnel**, create the ChatGPT app/connector using the Tunnel connection and the tunnel ID.
- With **HTTPS**, use the stable URL ending in \`/mcp\` and Forge's OAuth flow.
- Refresh/scan tools after Forge tool definitions change.

The bounded default surface intentionally exposes the preferred \`rh_*\` facade plus repository/source/check/process/plugin escape hatches. Do not switch to exhaustive compatibility mode merely to see more tool names.

## Verify

Local Runtime:

\`\`\`bash
forge runtime status --json
forge mcp doctor
\`\`\`

Then verify from the selected external controller:

\`\`\`text
Use Forge. Call rh_status and report whether the Runtime is ready. Do not modify anything yet.
\`\`\`

A successful controller-to-Forge tool call is the meaningful end-to-end setup milestone.

## Optional controller entries

Codex and Claude are configured only when explicitly selected:

\`\`\`bash
forge mcp setup codex --scope user --profile controller
forge mcp setup claude --scope user --profile controller
\`\`\`

Multiple controller entries may coexist, while one external controller remains the semantic owner at a time.

## Advanced source/Recovery path

Maintainers who intentionally need immutable Git/source releases and independent disaster recovery may use the source Runtime and Standalone Recovery documentation. Those mechanisms are not required by ordinary npm/package users and are deliberately excluded from normal setup.
`;
}

export function runMcpSetupChatgpt(opts: {
  repo?: string;
  controllerHome?: string;
  userLevel?: boolean;
  host?: string;
  port?: string;
  endpoint?: string;
  serverName?: string;
  localControllerPort?: string;
  connectorPort?: string;
}): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = opts.userLevel
    ? ensureControllerHome(opts.controllerHome)
    : ensureRepoPreferredControllerHome(repoRoot, opts.controllerHome);
  const changed: string[] = [];
  const existingConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const host = opts.host ?? existingConfig?.server?.host ?? "127.0.0.1";
  const port = opts.port ?? String(existingConfig?.server?.port ?? 8765);
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) throw new Error(`forge mcp setup chatgpt: invalid port ${port}`);
  const localControllerPort = opts.localControllerPort !== undefined
    ? Number(opts.localControllerPort)
    : existingConfig?.localController?.port ?? (parsedPort < 65_535 ? parsedPort + 1 : 8766);
  if (!Number.isInteger(localControllerPort) || localControllerPort < 1 || localControllerPort > 65_535) throw new Error(`forge mcp setup chatgpt: invalid Local Controller port ${opts.localControllerPort}`);
  if (localControllerPort === parsedPort) throw new Error('forge mcp setup chatgpt: Local Controller port must differ from MCP port');
  const connectorPort = opts.connectorPort !== undefined
    ? Number(opts.connectorPort)
    : parsedPort <= 65_533 ? parsedPort + 2 : 8767;
  if (!Number.isInteger(connectorPort) || connectorPort < 1 || connectorPort > 65_535) throw new Error(`forge mcp setup chatgpt: invalid connector port ${opts.connectorPort}`);
  if (connectorPort === parsedPort || connectorPort === localControllerPort) throw new Error('forge mcp setup chatgpt: connector port must differ from Runtime and Local Controller ports');
  const existingServerName = existingConfig?.chatgpt?.serverName;
  const migratedServerName =
    existingServerName && !LEGACY_DEFAULT_SERVER_NAMES.has(existingServerName)
      ? existingServerName
      : undefined;
  const serverName = normalizeChatgptMcpServerName(
    opts.serverName ?? migratedServerName,
  );
  const endpoint = normalizePublicMcpEndpoint(
    opts.endpoint ?? existingConfig?.chatgpt?.endpoint,
  );
  const configPath = mcpControllerHomeLocalConfigPath(controllerHome);
  const guidePath = opts.userLevel ? undefined : join(repoRoot, "docs", "forge-chatgpt-mcp-setup.md");
  const token = ensureMcpControllerHomeBearerToken(controllerHome);
  const oauth = ensureMcpControllerHomeOAuthPassphrase(controllerHome);
  if (token.changed) changed.push(token.path);
  if (oauth.changed) changed.push(oauth.path);
  const migratedToolset = migrateControllerToolsetConfig(existingConfig);
  const toolset = migratedToolset.toolset;
  const config = {
    version: Math.max(existingConfig?.version ?? 1, 2),
    ...(opts.userLevel ? (existingConfig?.repo ? { repo: existingConfig.repo } : {}) : { repo: repoRoot }),
    server: {
      ...existingConfig?.server,
      host,
      port: parsedPort,
      transport: existingConfig?.server?.transport ?? "http",
    },
    auth: existingConfig?.auth ?? {
      mode: "oauth",
      oauthFile: "mcp/mcp.oauth.json",
      tokenFile: "mcp/mcp.tokens.json",
    },
    chatgpt: {
      ...existingConfig?.chatgpt,
      serverName,
      ...(endpoint ? { endpoint } : {}),
      localEndpoint: `http://127.0.0.1:${connectorPort}/mcp`,
    },
    profile: existingConfig?.profile ?? "controller",
    toolset,
    toolsetExplicit: migratedToolset.toolsetExplicit,
    accessMode: existingConfig?.accessMode
      ?? accessModeForLegacyToolset(existingConfig?.toolset ?? toolset),
    accessModeUpdatedAt: existingConfig?.accessModeUpdatedAt,
    accessModeRevision: existingConfig?.accessModeRevision ?? 0,
    localController: opts.userLevel && !existingConfig?.repo
      ? {
          enabled: false,
          host: existingConfig?.localController?.host ?? "127.0.0.1",
          port: localControllerPort,
          autoOpen: false,
          mode: "disabled",
        }
      : {
          ...(existingConfig?.localController ?? { enabled: true, host: "127.0.0.1", autoOpen: false }),
          port: localControllerPort,
        },
    devMode: {
      ...existingConfig?.devMode,
      agentRunner: existingConfig?.devMode?.agentRunner ?? false,
      allowedAgents: existingConfig?.devMode?.allowedAgents ?? [],
      timeoutMs:
        !existingConfig?.devMode?.timeoutMs ||
        existingConfig.devMode.timeoutMs === 120_000
          ? DEFAULT_AGENT_TIMEOUT_MS
          : existingConfig.devMode.timeoutMs,
      maxTimeoutMs:
        existingConfig?.devMode?.maxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
    },
  };
  writeFileIfChanged(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    changed,
  );
  if (guidePath) {
    writeFileIfChanged(guidePath, chatgptGuideMarkdown(), changed);
    ensureGitignoreEntries(
      repoRoot,
      [
        ".forge/mcp.local.json",
        ".forge/mcp.tokens.json",
        ".forge/mcp.oauth.json",
        ".forge/mcp.oauth-tokens.json",
        ".forge/mcp.runtime.json",
        ".ai/harness/mcp/audit.log",
        ".ai/harness/local-jobs/",
        ".ai/harness/controller/",
      ],
      changed,
    );
  }

  return {
    status: "ok",
    repoRoot,
    changed,
    lines: [
      opts.userLevel ? `[forge mcp] Scope: user (${controllerHome})` : `[forge mcp] Repo: ${repoRoot}`,
      "[forge mcp] Profile: controller",
      `[forge mcp] Toolset: ${config.toolset}`,
      `[forge mcp] ChatGPT MCP server name: ${serverName}`,
      `[forge mcp] Internal Runtime endpoint: http://${host}:${port}/mcp`,
      `[forge mcp] ChatGPT local OAuth endpoint: http://127.0.0.1:${connectorPort}/mcp`,
      `[forge mcp] Local Controller: http://${config.localController.host}:${config.localController.port}/`,
      `[forge mcp] Optional external delegation: ${config.devMode.agentRunner ? `enabled (${config.devMode.allowedAgents.join(',') || 'none'})` : 'disabled'}`,
      endpoint
        ? `[forge mcp] ChatGPT endpoint: ${endpoint}`
        : "[forge mcp] ChatGPT endpoint: requires stable HTTPS tunnel",
      `[forge mcp] Auth: OAuth passphrase (${relative(repoRoot, oauth.path)})`,
      `[forge mcp] Bearer fallback token: ${relative(repoRoot, token.path)}`,
      `[forge mcp] Config: ${relative(repoRoot, configPath)}`,
      ...(guidePath ? [`[forge mcp] Guide: ${relative(repoRoot, guidePath)} (generic; endpoint stays in ignored local config)`] : []),
      `[forge mcp] Runtime state: ${mcpControllerHomeRuntimeStatePath(controllerHome)}`,
      opts.userLevel
        ? 'Next: forge setup next'
        : `Next: forge runtime service install-package --controller-home ${controllerHome} --host ${host} --port ${port}`,
    ],
  };
}

type LocalControllerProfile = 'controller' | 'executor';

function localControllerProfile(value: string | undefined, label: string, fallback: LocalControllerProfile): LocalControllerProfile {
  const normalized = (value ?? fallback).trim().toLowerCase();
  if (normalized !== 'controller' && normalized !== 'executor') {
    throw new Error(`${label}: expected controller|executor`);
  }
  return normalized;
}

export function codexMcpBlock(profile: LocalControllerProfile = 'executor'): string {
  const lines = [
    '[mcp_servers.forge]',
    'command = "forge"',
    'args = [',
    '  "mcp",',
    '  "serve",',
    '  "--repo",',
    '  ".",',
    '  "--transport",',
    '  "stdio",',
    '  "--profile",',
    `  "${profile}"`,
    ']',
  ];
  if (profile === 'executor') {
    lines.push(
      'enabled_tools = [',
      ...REQUIRED_CODEX_TOOLS.map((tool) => `  "${tool}",`),
      ']',
      'default_tools_approval_mode = "prompt"',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function patchCodexConfigToml(current: string, profile: LocalControllerProfile = 'executor'): string {
  const block = codexMcpBlock(profile);
  const normalized = current.trimEnd();
  const blockPattern = /\n?\[mcp_servers\.forge\][\s\S]*?(?=\n\[|$)/;
  const prefix = normalized.length > 0 ? `${normalized}\n\n` : '';
  if (!blockPattern.test(normalized)) return `${prefix}${block}`;
  return `${normalized.replace(blockPattern, `\n${block}`.trimEnd())}\n`;
}

export function runMcpSetupCodex(opts: {
  repo?: string;
  scope?: string;
  profile?: string;
  dryRun?: boolean;
}): McpSetupResult {
  const scope = (opts.scope ?? 'project').trim().toLowerCase();
  if (scope !== 'project' && scope !== 'user') {
    throw new Error('forge mcp setup codex --scope: expected project|user');
  }
  const profile = localControllerProfile(opts.profile, 'forge mcp setup codex --profile', 'executor');
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const configPath = scope === 'user' ? join(homedir(), '.codex', 'config.toml') : join(repoRoot, '.codex', 'config.toml');
  const changed: string[] = [];
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const next = patchCodexConfigToml(current, profile);
  if (opts.dryRun === true) {
    return {
      status: 'ok', repoRoot, changed: [],
      lines: [`[forge mcp] Dry run: would patch ${scope === 'user' ? configPath : relative(repoRoot, configPath)}`, next],
    };
  }
  if (existsSync(configPath) && current !== next) {
    const backupPath = `${configPath}.bak`;
    writeFileIfChanged(backupPath, current, changed);
  }
  writeFileIfChanged(configPath, next, changed);
  return {
    status: 'ok', repoRoot, changed,
    lines: [
      `[forge mcp] Codex config: ${scope === 'user' ? configPath : relative(repoRoot, configPath)}`,
      '[forge mcp] Server: forge',
      '[forge mcp] Transport: stdio',
      `[forge mcp] Role: external ${profile === 'controller' ? 'primary controller' : 'executor/delegate'}`,
    ],
  };
}

export function claudeMcpSetupCommand(repoRoot: string, profile: LocalControllerProfile = 'controller', scope = 'user'): string[] {
  return [
    'claude', 'mcp', 'add', 'forge', '--scope', scope, '--',
    'forge', 'mcp', 'serve', '--repo', repoRoot, '--transport', 'stdio', '--profile', profile,
  ];
}

export function runMcpSetupClaude(opts: {
  repo?: string;
  scope?: string;
  profile?: string;
  dryRun?: boolean;
}): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const scope = (opts.scope ?? 'user').trim().toLowerCase();
  if (!['local', 'project', 'user'].includes(scope)) {
    throw new Error('forge mcp setup claude --scope: expected local|project|user');
  }
  const profile = localControllerProfile(opts.profile, 'forge mcp setup claude --profile', 'controller');
  const command = claudeMcpSetupCommand(scope === 'user' ? '.' : repoRoot, profile, scope);
  if (opts.dryRun === true) {
    return {
      status: 'ok', repoRoot, changed: [],
      lines: [`[forge mcp] Dry run: ${command.join(' ')}`],
    };
  }
  const result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('Claude Code CLI is not installed. Install/authenticate Claude only if you selected it as a Forge controller.');
  }
  if (result.status !== 0) {
    throw new Error(`Claude MCP configuration failed (${result.status ?? 'unknown'}): ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  }
  return {
    status: 'ok', repoRoot, changed: [],
    lines: [
      '[forge mcp] Claude Code MCP server configured through the Claude CLI.',
      `[forge mcp] Scope: ${scope}`,
      `[forge mcp] Role: external ${profile === 'controller' ? 'primary controller' : 'executor/delegate'}`,
      '[forge mcp] Verify: claude mcp get forge',
    ],
  };
}

export function runMcpPrintGuide(opts: {
  repo?: string;
  endpoint?: string;
  write?: boolean;
}): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const changed: string[] = [];
  const endpoint = normalizePublicMcpEndpoint(opts.endpoint);
  const content = chatgptGuideMarkdown(
    opts.write === true ? undefined : endpoint,
  );
  if (opts.write === true) {
    writeFileIfChanged(
      join(repoRoot, "docs", "forge-chatgpt-mcp-setup.md"),
      chatgptGuideMarkdown(),
      changed,
    );
  }
  return {
    status: "ok",
    repoRoot,
    changed,
    lines: [
      content.trimEnd(),
      ...(opts.write === true && endpoint
        ? [
            "",
            `[forge mcp] ChatGPT endpoint for this session: ${endpoint}`,
          ]
        : []),
    ],
  };
}

export function runMcpDoctor(opts: {
  repo?: string;
  json?: boolean;
}): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = ensureRepoPreferredControllerHome(repoRoot);
  const localConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const runtimeState = loadMcpServiceRuntimeState(controllerHome, repoRoot);
  const configuredServerName = localConfig?.chatgpt?.serverName;
  const host = localConfig?.server?.host ?? "127.0.0.1";
  const port = localConfig?.server?.port ?? 8765;
  const authMode = localConfig?.auth?.mode ?? "missing";
  const codexConfigPath = join(repoRoot, ".codex", "config.toml");
  const codexConfig = existsSync(codexConfigPath)
    ? readFileSync(codexConfigPath, "utf-8")
    : "";
  const codexHasServer = codexConfig.includes("[mcp_servers.forge]");
  const missingTools = REQUIRED_CODEX_TOOLS.filter(
    (tool) => !codexConfig.includes(`"${tool}"`),
  );
  const codexCommand = Bun.which("codex");
  const report = {
    status: existsSync(join(repoRoot, ".ai", "harness", "policy.json"))
      ? "ready_local"
      : "not_adopted",
    repo: repoRoot,
    mcp: {
      toolset: migrateControllerToolsetConfig(localConfig).toolset,
      localConfig: existsSync(mcpControllerHomeLocalConfigPath(controllerHome)) || existsSync(
        join(repoRoot, ".forge", "mcp.local.json"),
      ),
      guide: existsSync(
        join(repoRoot, "docs", "forge-chatgpt-mcp-setup.md"),
      ),
      authConfigured:
        (authMode === "oauth" && (existsSync(mcpControllerHomeOAuthPath(controllerHome)) || existsSync(mcpOAuthPath(repoRoot)))) ||
        (authMode === "bearer" && (existsSync(mcpControllerHomeTokenPath(controllerHome)) || existsSync(mcpTokenPath(repoRoot)))),
      localController: {
        enabled: localConfig?.localController?.enabled ?? true,
        host: localConfig?.localController?.host ?? "127.0.0.1",
        port: localConfig?.localController?.port ?? 8766,
        autoOpen: localConfig?.localController?.autoOpen ?? false,
      },
      devMode: {
        agentRunner: localConfig?.devMode?.agentRunner === true,
        allowedAgents: localConfig?.devMode?.allowedAgents ?? [],
        timeoutMs: localConfig?.devMode?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        maxTimeoutMs:
          localConfig?.devMode?.maxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
      },
    },
    codex: {
      cliAvailable: codexCommand !== null,
      configured: codexHasServer && missingTools.length === 0,
      configPath: ".codex/config.toml",
      hasServer: codexHasServer,
      missingTools,
      fix: "forge mcp setup codex --repo . --scope project",
    },
    chatgpt: {
      ...(configuredServerName ? { serverName: configuredServerName } : {}),
      serverNameConfigured: Boolean(configuredServerName),
      defaultServerName: DEFAULT_CHATGPT_MCP_SERVER_NAME,
      expectedToolSurface: FORGE_TOOL_SURFACE,
      localEndpoint: `http://${host}:${port}/mcp`,
      localController: `http://${localConfig?.localController?.host ?? "127.0.0.1"}:${localConfig?.localController?.port ?? 8766}/`,
      publicEndpoint: localConfig?.chatgpt?.endpoint,
      authMode,
      manualStepsRequired: true,
      setup: "forge mcp setup chatgpt --repo .",
    },
    runtime: runtimeState
      ? {
          status: runtimeState.status,
          tunnelMode: runtimeState.tunnelMode,
          localHealthy: runtimeState.server.healthy,
          localPid: runtimeState.server.pid,
          localRestartCount: runtimeState.server.restartCount,
          publicEndpoint: runtimeState.tunnel?.publicEndpoint,
          publicHealthy: runtimeState.tunnel?.healthy,
          tunnelPid: runtimeState.tunnel?.pid,
          tunnelRestartCount: runtimeState.tunnel?.restartCount,
          connectorNeedsReconnect:
            runtimeState.tunnel?.connectorNeedsReconnect === true,
          updatedAt: runtimeState.updatedAt,
        }
      : null,
  };
  return {
    status: "ok",
    repoRoot,
    changed: [],
    lines:
      opts.json === true
        ? [JSON.stringify(report, null, 2)]
        : [
            `[forge mcp] Repo: ${repoRoot}`,
            `[forge mcp] Status: ${report.status}`,
            `[forge mcp] ChatGPT MCP server name: ${
              configuredServerName ??
              `missing (run setup; default is ${DEFAULT_CHATGPT_MCP_SERVER_NAME})`
            }`,
            `[forge mcp] ChatGPT guide: ${report.mcp.guide ? "present" : "missing"}`,
            `[forge mcp] Toolset: ${report.mcp.toolset}`,
            `[forge mcp] Local Controller: ${report.mcp.localController.enabled ? report.chatgpt.localController : "disabled"}`,
            `[forge mcp] ChatGPT auth: ${report.mcp.authConfigured ? `${authMode} present` : "missing"}`,
            `[forge mcp] Runtime: ${
              report.runtime
                ? `${report.runtime.status} (local=${report.runtime.localHealthy ? "ok" : "down"}${
                    report.runtime.tunnelMode !== "none"
                      ? `, public=${report.runtime.publicHealthy ? "ok" : "down"} via ${report.runtime.tunnelMode}`
                      : ""
                  })`
                : "not running"
            }`,
            ...(report.runtime?.connectorNeedsReconnect === true
              ? [
                  "[forge mcp] Runtime note: public quick tunnel URL changed; update the ChatGPT connector or switch to a named tunnel",
                ]
              : []),
            `[forge mcp] Dev runner: ${report.mcp.devMode.agentRunner ? `enabled (${report.mcp.devMode.allowedAgents.join(",")})` : "disabled"}`,
            `[forge mcp] Codex config: ${report.codex.configured ? "present" : "missing"}`,
            `[forge mcp] Codex CLI: ${report.codex.cliAvailable ? "present" : "missing"}`,
            `[forge mcp] Next ChatGPT setup: ${report.chatgpt.setup}`,
          ],
  };
}
