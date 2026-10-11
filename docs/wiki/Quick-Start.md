# Quick Start — use ChatGPT to work with your computer via Forge MCP

Forge gives an external controller (ChatGPT recommended) a local-first, permission-scoped execution runtime for files, Git repositories, browser/desktop actions, and connected services. Forge itself is **not** a second AI agent and does not require a separate OpenAI API key when your controller is ChatGPT.

## 1. Install the current stable CLI

Requires Node.js 20.10+, npm, and a writable home directory.

```bash
npm install -g @moretea-labs/forge@latest
forge --version
```

Bun alternative: `bun add -g @moretea-labs/forge`. Source compilation is **not** necessary for a normal install; see [Installation](Installation).

## 2. Configure ChatGPT as the external controller

```bash
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

Follow each reported next step to configure the Package Runtime and authenticated connector. OpenAI Secure MCP Tunnel is preferred when available; it is a transport, not another Forge controller. Read the [ChatGPT MCP setup tutorial](https://github.com/moretea-labs/forge/blob/main/docs/tutorials/02-connect-chatgpt.md).

## 3. Adopt a code repository only when needed

```bash
forge adopt --repo /path/to/project --dry-run
forge adopt --repo /path/to/project
forge repo list --json
```

You can use authorized file, browser or service capabilities without first adopting a Git repository.

## 4. Complete a small task and check the result

Ask ChatGPT to inspect a repository, make a scoped change, run the focused check, review the diff, and commit if verified. The [first repository task](https://github.com/moretea-labs/forge/blob/main/docs/tutorials/03-first-repository-task.md) walks through the process. Destructive, secret-bearing and external effects have separate authorization requirements.

## Source checkout for contributors

A normal package install does not require source, Git, or Bun. If you are modifying Forge itself, use the same frozen Bun dependency lock as CI:

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
bun install --frozen-lockfile
npm install -g . --omit=optional --no-audit --no-fund
```

## Upgrade and help

```bash
npm install -g @moretea-labs/forge@latest
forge setup next
forge doctor
```

Read [Releases and Upgrades](Releases-and-Upgrades), [Troubleshooting](Troubleshooting), and the [full documentation](https://github.com/moretea-labs/forge/tree/main/docs). Current stable: [v1.8.1](https://github.com/moretea-labs/forge/releases/tag/v1.8.1).
