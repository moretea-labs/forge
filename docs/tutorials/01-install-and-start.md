# Tutorial 1: Install and choose your controller

This tutorial gets Forge from a package install to a resumable setup session. Forge has **no internal AI brain**: one external controller decides what should happen, while Forge owns bounded execution, durable state, permissions, and evidence.

## 1. Pick the platform path

- **macOS:** supported; the packaged Runtime can persist through launchd.
- **Modern Linux:** supported; the packaged Runtime uses `systemd --user` when available and otherwise reports a portable-session fallback.
- **Windows + WSL2:** recommended Windows path; follow the Linux flow inside WSL2.
- **Native Windows:** preview; CLI, setup, portable Runtime, MCP, and bounded portable capabilities work, but reboot-persistent Runtime ownership and every provider combination are not yet claimed.

Base installation needs **Node.js 20.10 or newer**, npm (or Bun), and a writable user home. **Git is optional until you enable repository/software-work features.** Codex, Claude, `gh`, Cloudflare, Tailscale, CodeGraph, and service credentials are capability-specific dependencies, not Forge installation prerequisites.

```bash
node --version
npm --version
```

See [Platform Support](../operations/platform-support.md) for the exact matrix.

## 2. Install Forge

Release candidates use npm `next`:

```bash
npm install -g @moretea-labs/forge
# or
bun add -g @moretea-labs/forge
forge --version
```

For Forge source development only:

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

The published package exposes `forge`, `forge-hook`, and `forge-runtime`. Normal package users do **not** need a Forge source checkout, Bun compilation, CodeGraph, or Standalone Recovery to start the user-level Runtime.

## 3. Start guided setup

```bash
forge setup
```

On a fresh install the first action is to choose the external controller. ChatGPT is recommended, but it is not mandatory:

```bash
forge setup configure --controller chatgpt --tunnel auto
# Alternatives:
# forge setup configure --controller codex
# forge setup configure --controller claude
# forge setup configure --controller mcp
```

You can preconfigure additional controller entries while keeping one primary controller:

```bash
forge setup configure \
  --controller chatgpt \
  --add-controller codex \
  --add-controller claude \
  --tunnel auto
```

Forge does not install or check Codex/Claude merely because they exist on the machine. Their readiness becomes relevant only when you explicitly select them.

## 4. Follow one Next action at a time

```bash
forge setup next
```

The setup session is stored below the user-level Forge directory, so you can close the terminal and resume later. Depending on the selected controller, the flow may ask for:

1. controller registration;
2. the packaged user-level Runtime;
3. secure public HTTPS for a remote controller;
4. account/browser authentication that only you can complete;
5. a connection verification.

`forge setup status` shows persisted progress. `forge setup check` is read-only. `forge setup close` closes a ready setup session.

The normal Runtime action is:

```bash
forge runtime service install-package
```

The older `forge runtime service install --repo ...` path builds an immutable Git/source Runtime and is an **advanced maintainer path**, not normal onboarding. Standalone Recovery is likewise optional advanced infrastructure.

## 5. Repositories are optional at first

Forge can be useful for authorized files, browser/desktop actions, and service plugins without adopting a Git repository. Add a project when you need software-work capabilities:

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

Git becomes required for that repository workflow.

## 6. Verify the base install

```bash
forge setup status
forge doctor
```

If ChatGPT is your controller, continue with [Tutorial 2: Connect ChatGPT](02-connect-chatgpt.md). For errors, use [Troubleshooting](../operations/troubleshooting.md).
