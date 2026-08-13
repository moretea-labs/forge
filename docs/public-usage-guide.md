# Public Usage Guide

Use this page for the shortest current Forge path.

## 1. Install and choose the external controller

```bash
npm install -g @moretea-labs/forge
forge setup
```

Forge has no internal AI brain. Choose one primary external controller; ChatGPT is recommended, while Codex, Claude, or another MCP client can be selected explicitly. Multiple controller entries may be configured without turning unselected clients into dependencies.

```bash
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

## 2. Follow setup until the selected path is usable

For a hosted controller, setup guides the user-level Package Runtime and a remote connection. Prefer OpenAI Secure MCP Tunnel when eligible; Cloudflare Tunnel, Tailscale Funnel, an existing HTTPS `/mcp` endpoint, or deferred remote access are alternatives.

The normal package Runtime is `forge runtime service install-package`. Source immutable Runtime and Standalone Recovery are advanced maintainer paths.

## 3. Add only the capabilities you need

A Git repository is optional during first setup. Adopt one for software work:

```bash
forge adopt --repo /path/to/project --dry-run
forge adopt --repo /path/to/project
```

Or authorize a normal folder / configure Browser, Desktop, Gmail, Calendar, Apple, GitHub, or other typed providers later. Git, Codex, Claude, service credentials, and tunnel CLIs are capability-specific dependencies.

## 4. Verify with a real controller call

For ChatGPT, follow [Connect ChatGPT](tutorials/02-connect-chatgpt.md), then start with a read-only `rh_status` call. A running local process or saved endpoint is not enough; the first successful controller-to-Forge tool call is the useful setup milestone.

See [Features](operations/features.md), [Platform Support](operations/platform-support.md), [Plugin Management](forge-plugin-management.md), and [Troubleshooting](operations/troubleshooting.md) for deeper paths.
