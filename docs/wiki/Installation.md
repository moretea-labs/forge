# Install Forge — ChatGPT MCP local action runtime

Forge is a local-first MCP execution runtime. ChatGPT (or another explicitly selected external controller) makes decisions; Forge handles permission-scoped computer, repository, browser, and service operations. **Stable release: v1.8.1**, published to npm `latest`.

## Install from npm (recommended)

Requirements: **Node.js 20.10+**, npm (or Bun), and a writable home directory. Git is only needed for software/repository operations.

```bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

You can also use `bun add -g @moretea-labs/forge`. For ChatGPT, setup prefers the OpenAI Secure MCP Tunnel; connection requires your ChatGPT account/session and appropriate authorization. Codex, Claude, and other MCP clients are optional external controllers.

## Upgrade an existing install

```bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup next
forge doctor
```

For an installed Package Runtime, use `forge runtime service install-package` to reconcile its service. Follow [Releases and Upgrades](Releases-and-Upgrades) and [release notes](https://github.com/moretea-labs/forge/releases/tag/v1.8.1).

## Source development (not required for installation)

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
bun install --frozen-lockfile
npm install -g . --omit=optional --no-audit --no-fund
```

## Supported platforms

- **macOS:** supported user-level Package Runtime using launchd.
- **Linux:** supported with systemd user service where available; portable-session fallback otherwise.
- **Windows + WSL2:** recommended Windows path, using Linux instructions inside WSL2.
- **Native Windows:** preview; check the explicitly supported CLI and portable Runtime scope.

See the [platform support matrix](https://github.com/moretea-labs/forge/blob/main/docs/operations/platform-support.md). Forge publishes `forge`, `forge-hook`, and `forge-runtime`. A successful CLI version check alone does not prove MCP connectivity; complete the [ChatGPT connection tutorial](https://github.com/moretea-labs/forge/blob/main/docs/tutorials/02-connect-chatgpt.md) and verify the connector.
