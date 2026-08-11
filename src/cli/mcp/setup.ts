import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isIP } from "net";
import { dirname, join, relative } from "path";
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
  defaultLocalAgentRunners,
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
  "latest_handoff",
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
  return `# forge ChatGPT Controller Setup

## Purpose

The \`controller\` profile makes ChatGPT the project control plane. ChatGPT can inspect code and documents, maintain durable Issues and dependency-aware Tasks, apply bounded direct edits, publish Issues to GitHub Projects, dispatch short local Codex/Claude runs or visible GitHub Copilot cloud sessions, and review the resulting state. Repository files remain the source of truth; chat history is not required for recovery.

## Prerequisites

- A forge adopted repository.
- Bun and the \`forge\` CLI on PATH.
- Codex and/or Claude CLI installed for delegated local execution.
- GitHub CLI \`gh\` authenticated when GitHub Issues, Projects, or Copilot cloud sessions are used.
- ChatGPT workspace access to Developer Mode and custom MCP Connectors.
- A public HTTPS \`/mcp\` endpoint for ChatGPT.

For a shared editable installation, keep the forge checkout at a stable path such as \`~/DevProjects/forge\`, run \`bun install\`, and reinstall the CLI after pulling updates.

## One-time setup

\`\`\`bash
forge mcp setup chatgpt --repo .
forge runtime service install \
  --controller-home <absolute-controller-home> \
  --repo <absolute-repo-root> \
  --host 127.0.0.1 \
  --port 8765
\`\`\`

The \`controller\` profile writes the service-level MCP configuration consumed by the single \`forge-runtime\`. The macOS launchd service starts and restarts that one root process; Gateway, Controller Services, Scheduler, and MCP Transport share the same Runtime lifecycle owner. There is no MCP KeepAlive wrapper or component-level lifecycle command.

The Runtime endpoint is loopback-only at \`http://127.0.0.1:8765/\`. The local visual controller surface is part of the same Runtime configuration; do not expose it directly.

Health check:

\`\`\`bash
curl http://127.0.0.1:8765/ready
forge runtime status --controller-home <absolute-controller-home>
forge mcp doctor --repo .
\`\`\`

For a fixed Cloudflare domain, verify both local and public discovery without leaking tokens:

\`\`\`bash
curl http://127.0.0.1:8765/ready
curl https://${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}/.well-known/oauth-protected-resource/mcp
env | grep -Ei 'proxy|no_proxy'
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= curl -v https://${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}/mcp
\`\`\`

If a local HTTP proxy interferes with endpoint checks, add the fixed domain, \`*.trycloudflare.com\`, \`*.ts.net\`, and \`100.64.0.0/10\` to \`NO_PROXY\` instead of disabling proxies globally.

The controller profile stores service-level MCP config under \`controllerHome/mcp/mcp.local.json\`, including allowed local agents, timeout, endpoint, and \`chatgpt.serverName\`. OAuth credentials live in \`controllerHome/mcp/mcp.oauth.json\`; the bearer fallback lives in \`controllerHome/mcp/mcp.tokens.json\`. Existing repo-local \`.forge/mcp.*\` files remain a legacy fallback.

Repository-specific MCP access rules may be added in \`.forge/mcp.policy.json\`. Repository policy can narrow access, but immutable secret, credential, Git-internal, and build-output denies remain enforced.

## Stable endpoint

Use this Connector URL:

\`\`\`text
${endpoint}
\`\`\`

Quick tunnels are useful for one-off smoke tests, but their URL may change. For routine use, prefer a fixed Cloudflare domain. Forge never owns the tunnel process: publish the loopback Runtime endpoint through your own stable HTTPS tunnel. With Cloudflare, create and route a named tunnel:

\`\`\`bash
cloudflared tunnel login
cloudflared tunnel create forge-mcp
cloudflared tunnel route dns forge-mcp ${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}
cloudflared tunnel run forge-mcp
\`\`\`

Keep forge on the fixed public origin without owning the tunnel process:

\`\`\`bash
forge mcp setup chatgpt --repo . --endpoint https://${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}/mcp
forge runtime service install --controller-home <absolute-controller-home> --repo <absolute-repo-root> --host 127.0.0.1 --port 8765
\`\`\`

Regenerate this guide with the stable endpoint:

\`\`\`bash
forge mcp setup chatgpt --repo . --endpoint <https-url>/mcp
\`\`\`

The real endpoint stays in ignored local config; the tracked guide stays placeholder-only. The OAuth discovery endpoint includes \`oauth-protected-resource\` metadata.

## Create the ChatGPT Connector

1. Open ChatGPT Settings and enable Developer Mode.
2. Create a custom Connector using the server name from \`controllerHome/mcp/mcp.local.json\` under \`chatgpt.serverName\`.
3. Paste the public HTTPS URL ending in \`/mcp\`.
4. Configure Connector authentication as OAuth. ChatGPT must use the \`/mcp\` OAuth URL; do not point ChatGPT at \`/mcp-bearer\`.
5. Scan tools and authorize with the passphrase from \`controllerHome/mcp/mcp.oauth.json\`.
6. Keep write confirmations enabled.
7. Re-scan tools after updating forge tool schemas.

### Grok and other OAuth MCP clients

Current Grok custom connectors support OAuth dynamic client registration + PKCE. Use the same canonical endpoint as ChatGPT:

\`\`\`text
<https-tunnel-url>/mcp
\`\`\`

Do not use the legacy \/mcp-grok route for new connectors. Grok's current OAuth callback is \/connectors-oauth-exchange-code\/ on grok.com; forge accepts that callback through dynamic registration or its public-client fallback.

### Non-OAuth MCP clients

Clients that cannot complete OAuth dynamic client registration + PKCE should use the dedicated bearer endpoint instead of \`/mcp\` or \`/authorize\`:

\`\`\`text
<https-tunnel-url>/mcp-bearer
\`\`\`

Authenticate with \`Authorization: Bearer <token>\` using the token stored under \`controllerHome/mcp/mcp.tokens.json\` (or \`FORGE_MCP_TOKEN\`). Do not paste the raw token into chat or docs. \`/health\` advertises both \`mcpEndpoint\` and \`bearerEndpoint\`. Incomplete OAuth hits on \`/authorize\` return HTTP 400 and point clients to \`/mcp-bearer\`.

## Verify the loaded tool surface

Default \`--toolset core\` and \`--toolset advanced\` expose the same bounded 20-tool ChatGPT surface: the five \`rh_*\` facades (with code retrieval routed through \`rh_context.search\`) plus repository selection, \`repository_command_execute\`, exact source read, safe patch, \`run_check\`, one typed \`plugin_action_execute\` dispatcher (action schemas via \`rh_context\`), managed process lifecycle, result retrieval, and approval resolution. Use \`--toolset full\` for exhaustive legacy compatibility, which keeps every atomic handler (including Git) registered. Confirm all five \`rh_*\` tools appear after connect. If only legacy planning tools are visible, refresh or recreate the Connector so ChatGPT reloads the MCP tool schema.

## Refresh newly added repository tools

For the current repository only, prefer a bounded local restart:

\`\`\`bash
launchctl kickstart -k gui/$(id -u)/com.moretea.forge.runtime.<controller-home-suffix>
\`\`\`

The launchd label is printed by \`forge runtime service install\` (it is \`com.moretea.forge.runtime.<controller-home-suffix>\`). The single Runtime restart also refreshes repository tools. There is no per-repository rollout or component restart surface.

After the restart, rescan or recreate the ChatGPT Connector, then call \`controller_capabilities\` again and verify \`expectedTools\` still includes \`repository_latest_source_diagnose\` and \`repository_bootstrap_local_project\`.

## Daily workflow

Start a new ChatGPT conversation with:

\`\`\`text
Use forge as the project controller. Read project_snapshot, current Issues, active Runs, and relevant code before deciding the next action. Keep work in small dependency-aware Tasks. Do not dispatch one large Issue as one agent run.
\`\`\`

Typical requests:

\`\`\`text
Analyze this requirement and the current implementation. Create or update an Issue and split it into executable Tasks. Do not execute yet.
\`\`\`

\`\`\`text
Inspect readiness for this Issue, publish it to GitHub when collaboration is useful, and launch at most two independent Tasks. Review every local diff or GitHub pull request and record verification evidence before accepting it.
\`\`\`

\`\`\`text
Read the project board and failed Runs. Retry only the smallest failed Task, or re-plan the Issue when the original split is wrong.
\`\`\`

\`\`\`text
This is a small local fix. Open a bounded edit session, modify only the named files, inspect the Git diff, run focused checks, and finalize or rollback the edit.
\`\`\`

## Persistent model

\`\`\`text
Issue
  -> Task T1
       -> Run 1
       -> Run 2 (retry)
  -> Task T2
  -> Task T3
\`\`\`

- Issues and Tasks are stored under \`tasks/issues/\` as JSON plus readable Markdown.
- Agent jobs, logs, edit backups, and worktrees are stored under ignored \`.ai/harness/\` runtime directories.
- A completed isolated agent Run moves its Task to review. ChatGPT must inspect it with \`get_task_diff\`, integrate it with \`integrate_task_run\`, record named-check and criterion evidence through \`verify_task\`, then explicitly accept it or request changes.
- Dependency completion unlocks later Tasks automatically.
- Any new ChatGPT conversation can recover state through \`project_snapshot\` and \`get_project_board\`.

## Capability boundaries

- \`observe\`: inspect repository state, search code, and read bounded file ranges.
- \`manage\`: create Issues, dynamically split Tasks, inspect launch readiness, publish to GitHub Issues/Projects, update status, and maintain project documents.
- \`edit\`: use a bounded edit session with allowed paths, SHA preconditions, change limits, backups, and rollback.
- \`execute\`: dispatch a ready Task to an allowed local agent in an isolated worktree or to a visible GitHub Copilot cloud session.
- Protected operations such as secrets, Git internals, package lockfiles, CI workflow changes, commits, merges, and pushes are not default controller actions.

Kernel-managed Agent goals and persistent Task Runs are retired. New work uses
\`rh_work\` to create or continue a WorkContract, \`rh_work.controller_claim\` to
establish ownership, and \`rh_work.launcher_start\` to begin an external
SuperController session.

## Dev Mode Agent Runner

Local Agent execution is opt-in. GitHub cloud sessions use authenticated \`gh\` and do not require the local dev runner:

The runner is enabled through the service-level MCP configuration written by \`forge mcp setup chatgpt\` (\`devMode.agentRunner\` and \`devMode.allowedAgents\`). It executes inside the single Forge Runtime's bounded worker processes; there is no separate \`forge mcp serve\` lifecycle to supervise.

The runner defaults to 60 minutes per local Task and supports explicit values up to 12 hours. Requested values are validated and persisted unchanged; an invalid value fails instead of silently falling back to 120 seconds.

The runner:

- accepts only configured \`codex\` or \`claude\` agents;
- creates one persistent Run per Task;
- normally creates an isolated Git worktree;
- records prompt, process metadata, streaming stdout/stderr, structured events, and result under \`.ai/harness/jobs/\`;
- never exposes arbitrary shell input through MCP;
- does not commit, merge, or push automatically.

Watch local or GitHub execution from a terminal:

\`\`\`bash
forge controller runs --repo .
forge controller watch <RUN-ID> --repo . --log
\`\`\`

The \`--log\` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.

## Local Codex MCP

Configure Codex to read forge state:

\`\`\`bash
forge mcp setup codex --repo . --scope project
\`\`\`

The executor profile remains read-oriented. Controller-dispatched Codex work is scoped by the generated Task prompt and worktree.

## Security

- Keep OAuth passphrases, bearer tokens, tunnel tokens, \`~/.codex/auth.json\`, and other credentials out of chat and Git.
- Keep the MCP server bound to loopback; expose it only through the authenticated tunnel.
- Do not remove immutable hard-deny patterns in order to make a Task pass.
- Review every completed local diff or GitHub pull request and record passing Verification Gate evidence before accepting a Task.
- Use the smallest allowed path set and focused checks for direct edits.

## Troubleshooting

- ChatGPT cannot connect: verify the HTTPS tunnel ends in \`/mcp\` and local \`/ready\` responds.
- Grok cannot connect: recreate it with the canonical \`…/mcp\` URL. The legacy \`…/mcp-grok\` URL is compatibility-only.
- A genuinely non-OAuth client loops on \`/authorize\`: use \`…/mcp-bearer\` with a bearer token from \`controllerHome/mcp/mcp.tokens.json\`.
- ChatGPT auth loops: retry authorization and inspect \`controllerHome/mcp/mcp.oauth.json\` first, then legacy \`.forge/mcp.oauth.json\` only when using fallback; do not paste the passphrase into chat.
- Tool scan misses tools: restart the Forge Runtime service with \`launchctl kickstart -k gui/$(id -u)/com.moretea.forge.runtime.<controller-home-suffix>\`, then rescan or recreate the versioned Connector and verify \`controller_capabilities.expectedTools\` includes \`repository_latest_source_diagnose\` and \`repository_bootstrap_local_project\`.
- Codex cannot see the MCP server: rerun \`forge mcp setup codex --repo . --scope project\`.
- A quick tunnel URL changed: update the Connector URL or switch to a named tunnel.
- A Task is blocked: inspect \`get_task_run\`, shrink or re-plan the Task, then retry that Task rather than redispatching the full Issue.
`;
}

export function runMcpSetupChatgpt(opts: {
  repo?: string;
  host?: string;
  port?: string;
  endpoint?: string;
  serverName?: string;
}): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const controllerHome = ensureRepoPreferredControllerHome(repoRoot);
  const changed: string[] = [];
  const existingConfig = loadMcpServiceLocalConfig(controllerHome, repoRoot);
  const host = opts.host ?? existingConfig?.server?.host ?? "127.0.0.1";
  const port = opts.port ?? String(existingConfig?.server?.port ?? 8765);
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
  const guidePath = join(repoRoot, "docs", "forge-chatgpt-mcp-setup.md");
  const token = ensureMcpControllerHomeBearerToken(controllerHome);
  const oauth = ensureMcpControllerHomeOAuthPassphrase(controllerHome);
  if (token.changed) changed.push(token.path);
  if (oauth.changed) changed.push(oauth.path);
  const migratedToolset = migrateControllerToolsetConfig(existingConfig);
  const toolset = migratedToolset.toolset;
  const config = {
    version: Math.max(existingConfig?.version ?? 1, 2),
    repo: repoRoot,
    server: {
      ...existingConfig?.server,
      host,
      port: Number(port),
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
    },
    profile: existingConfig?.profile ?? "controller",
    toolset,
    toolsetExplicit: migratedToolset.toolsetExplicit,
    accessMode: existingConfig?.accessMode
      ?? accessModeForLegacyToolset(existingConfig?.toolset ?? toolset),
    accessModeUpdatedAt: existingConfig?.accessModeUpdatedAt,
    accessModeRevision: existingConfig?.accessModeRevision ?? 0,
    localController: existingConfig?.localController ?? {
      enabled: true,
      host: "127.0.0.1",
      port: 8766,
      autoOpen: false,
    },
    devMode: {
      ...existingConfig?.devMode,
      agentRunner: existingConfig?.devMode?.agentRunner ?? true,
      allowedAgents: existingConfig?.devMode?.allowedAgents ?? defaultLocalAgentRunners(),
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

  return {
    status: "ok",
    repoRoot,
    changed,
    lines: [
      `[forge mcp] Repo: ${repoRoot}`,
      "[forge mcp] Profile: controller",
      `[forge mcp] Toolset: ${config.toolset}`,
      `[forge mcp] ChatGPT MCP server name: ${serverName}`,
      `[forge mcp] Local endpoint: http://${host}:${port}/mcp`,
      `[forge mcp] Local Controller: http://${config.localController.host}:${config.localController.port}/`,
      `[forge mcp] Local agent timeout: ${config.devMode.timeoutMs}ms (max ${config.devMode.maxTimeoutMs}ms)`,
      endpoint
        ? `[forge mcp] ChatGPT endpoint: ${endpoint}`
        : "[forge mcp] ChatGPT endpoint: requires stable HTTPS tunnel",
      `[forge mcp] Auth: OAuth passphrase (${relative(repoRoot, oauth.path)})`,
      `[forge mcp] Bearer fallback token: ${relative(repoRoot, token.path)}`,
      `[forge mcp] Config: ${relative(repoRoot, configPath)}`,
      `[forge mcp] Guide: ${relative(repoRoot, guidePath)} (generic; endpoint stays in ignored local config)`,
      `[forge mcp] Runtime state: ${relative(repoRoot, mcpControllerHomeRuntimeStatePath(controllerHome))}`,
      `Next: forge runtime service install --controller-home ${controllerHome} --repo ${repoRoot} --host ${host} --port ${port}`,
    ],
  };
}

const CODEX_MCP_BLOCK = `[mcp_servers.forge]
command = "forge"
args = [
  "mcp",
  "serve",
  "--repo",
  ".",
  "--transport",
  "stdio",
  "--profile",
  "executor"
]
enabled_tools = [
  "harness_status",
  "read_workflow_file",
  "latest_handoff",
  "latest_checks",
  "prepare_codex_goal_from_sprint",
  "write_codex_goal",
  "run_workflow_check"
]
default_tools_approval_mode = "prompt"
`;

export function patchCodexConfigToml(current: string): string {
  const normalized = current.trimEnd();
  const blockPattern = /\n?\[mcp_servers\.forge\][\s\S]*?(?=\n\[|$)/;
  const prefix = normalized.length > 0 ? `${normalized}\n\n` : "";
  if (!blockPattern.test(normalized)) return `${prefix}${CODEX_MCP_BLOCK}`;
  return `${normalized.replace(blockPattern, `\n${CODEX_MCP_BLOCK}`.trimEnd())}\n`;
}

export function runMcpSetupCodex(opts: {
  repo?: string;
  scope?: string;
  dryRun?: boolean;
}): McpSetupResult {
  if ((opts.scope ?? "project") !== "project") {
    throw new Error(
      "forge mcp setup codex currently supports --scope project only",
    );
  }
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? ".");
  const configPath = join(repoRoot, ".codex", "config.toml");
  const changed: string[] = [];
  const current = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";
  const next = patchCodexConfigToml(current);
  if (opts.dryRun === true) {
    return {
      status: "ok",
      repoRoot,
      changed: [],
      lines: [
        `[forge mcp] Dry run: would patch ${relative(repoRoot, configPath)}`,
        next,
      ],
    };
  }
  if (existsSync(configPath) && current !== next) {
    const backupPath = `${configPath}.bak`;
    writeFileIfChanged(backupPath, current, changed);
  }
  writeFileIfChanged(configPath, next, changed);
  return {
    status: "ok",
    repoRoot,
    changed,
    lines: [
      `[forge mcp] Codex config: ${relative(repoRoot, configPath)}`,
      "[forge mcp] Server: forge",
      "[forge mcp] Transport: stdio",
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
        allowedAgents: localConfig?.devMode?.allowedAgents ?? defaultLocalAgentRunners(),
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
