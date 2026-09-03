# Platform Support

This document defines the currently claimed Forge user experience. It distinguishes the **normal packaged setup path** from source/maintainer infrastructure so users are not required to install development-only dependencies.

## Support matrix

| Platform | Status | Normal user path |
| --- | --- | --- |
| macOS | Supported | Package install, controller-first setup, Package Runtime via launchd, repositories, local files, MCP, browser/desktop providers, and plugins. |
| Modern Linux | Supported | Package install, controller-first setup, Package Runtime via `systemd --user` when available, repositories, local files, MCP, and portable providers. |
| WSL2 on Windows | Supported and recommended for Windows | Run the Linux Forge Runtime inside WSL2; Windows can host ChatGPT/browser clients. Forge bootstrap can provision a dedicated controlled Chromium profile when an extension-capable supported browser is available. |
| Native Windows | Preview | Package install, setup, portable Runtime/MCP, repository registration/inspection, and portable capabilities. Automatic reboot-persistent Runtime ownership and every external provider combination are not yet claimed. |

For scheduled ChatGPT Controller continuation on WSL2, Forge uses the existing ChatGPT Bridge authority rather than macOS native browser attach. The bridge keeps its capability token in the controller-scoped ChatGPT browser binding, opens the exact ChatGPT target through Windows browser interop, and treats prompt dispatch as complete only after the browser extension reports the postcondition. Forge may automatically provision only a dedicated Forge-controlled Chromium profile when the detected runtime explicitly supports unpacked-extension startup; that profile is separate from the user's ordinary browser profile. Google Chrome is not treated as automatic unpacked-extension bootstrap authority. An already enabled compatible bridge extension in an explicitly selected Chrome profile may be observed and reused, but otherwise setup returns a precise resumable user action instead of mutating or restarting the user's normal Chrome profile. This host bootstrap remains transport state, not a second Browser session authority.

## Base installation requirements

All normal installations require:

- Node.js 20.10 or newer;
- npm (bundled with Node.js) or Bun as package installer;
- a writable user home directory.

**Git is optional until repository/software-work capabilities are enabled.** Bun is optional for ordinary package users. A Forge source checkout, CodeGraph, Codex, Claude, Standalone Recovery, Cloudflare, Tailscale, or OpenAI tunnel-client is not a base dependency.

Capability-specific dependencies include:

- Git for repository adoption, Git operations, worktrees, commits, and source development;
- Codex or Claude only when explicitly configured as an external controller/execution entry;
- GitHub CLI for GitHub workflows that require it;
- browser/OS provider prerequisites for browser or desktop automation;
- Google/Apple/service credentials for their respective plugins;
- one remote connection provider when a hosted controller must reach the loopback MCP endpoint.

## Runtime ownership by platform

Normal package users use:

```bash
forge runtime service install-package
```

This path fingerprints the installed `@moretea-labs/forge` runtime surface and refuses to launch if that package content drifts from the recorded release identity.

- **macOS:** launchd user service.
- **Linux / WSL2 with user systemd:** `systemd --user` service with restart-on-failure.
- **Linux without user systemd:** explicit portable detached-session fallback with a persistence warning.
- **Native Windows:** portable user-process mode is preview. Forge does not currently claim automatic reboot persistence there.

The source-oriented `forge runtime service install --repo ...` immutable-release command and Standalone Recovery remain advanced maintainer operations. They are not normal installation prerequisites.

## Remote ChatGPT/MCP connection providers

Forge keeps its MCP listener on loopback. A remote controller chooses one of these explicit connection methods:

| Provider | Inbound public exposure | Typical use |
| --- | --- | --- |
| OpenAI Secure MCP Tunnel | No | Preferred for ChatGPT/OpenAI-hosted clients when the organization has tunnel permission. Uses official `tunnel-client`; Forge stores only the non-secret tunnel ID. |
| Cloudflare Tunnel | Yes / internet-reachable HTTPS | Stable named HTTPS endpoint when the user manages Cloudflare account/domain. |
| Tailscale Funnel | Yes / internet-reachable HTTPS | Convenient when the user already operates a compatible Tailscale setup. |
| Existing HTTPS `/mcp` | Depends on user infrastructure | Reverse proxy or tunnel already owned by the user. |
| None | No | Local controller only, or remote connectivity configured later. |

Setup detects the OS and available provider CLI. It does not assume Homebrew or macOS. Third-party authentication remains explicit and is never completed with credentials pasted into Forge setup.

## Native Windows scope

The native PowerShell path is release-tested for installer/CLI loading, doctor, setup/profile persistence, repository registry operations, Windows path/process behavior, and portable Node tests. Shell-heavy repository migration, every browser/provider integration, and persistent Windows service ownership remain outside the full-support claim; use WSL2 when those workflows are required.

## Verification boundary

The repository has platform/public-doc checks and a Windows smoke workflow. A platform claim means its named path is tested; it does not imply that every optional third-party provider is installed or available on every machine.
