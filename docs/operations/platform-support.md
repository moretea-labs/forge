# Platform Support

This document defines the currently claimed Forge user experience. It distinguishes the **normal packaged setup path** from source/maintainer infrastructure so users are not required to install development-only dependencies.

## Support matrix

| Platform | Runtime | Controller / MCP | Browser | Native Desktop / Computer | Recovery | Service persistence |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | **Supported.** Packaged Runtime is the normal path. | **Supported.** Local and explicit remote MCP/controller setup are normal product paths. | **Supported.** Browser semantics use product discovery/registration rather than a developer-specific executable or profile. | **Supported when the registered macOS Computer provider is installed and healthy.** Missing provider/permission state is reported per capability. | **Advanced.** Standalone Recovery remains a maintainer capability, not an installation prerequisite. | **Supported** through the user launchd owner. |
| Modern Linux | **Supported.** Packaged Runtime is the normal path. | **Supported.** Local and explicit remote MCP/controller setup are normal product paths. | **Supported** for portable Browser-side Computer capabilities. | **Not claimed** for native Desktop interaction. | **Not claimed as a normal-user prerequisite.** Recovery remains capability/host-specific. | **Supported** through `systemd --user` when available; otherwise Forge selects an explicit **non-persistent portable** session and reports that limitation. |
| WSL2 on Windows | **Supported and recommended for Windows.** The Linux Runtime runs inside WSL2. | **Supported.** Windows may host ChatGPT/browser clients while WSL owns the Forge Runtime. | **Supported** through discovered Windows browser interop and, when allowed, a dedicated Forge-controlled Chromium profile. | **Partial.** Browser capability may be usable while native Desktop capabilities remain non-ready until a truthful Windows-host provider exists. | **Supported for the Windows-host Recovery binding** when Windows environment/mount discovery succeeds; paths are derived from the host rather than a fixed drive or username. | WSL uses `systemd --user` when available or the explicit portable fallback; native Windows Runtime reboot persistence is not implied. |
| Native Windows | **Preview.** Portable package/runtime use is tested at the advertised surface. | **Preview.** Setup/MCP and repository inspection are tested, but shell-heavy parity is not claimed. | **Preview / capability-specific.** Do not infer every browser/provider integration from OS support. | **Not claimed.** | **Not claimed as native Runtime persistence.** The Windows-host Recovery capability is a distinct WSL/host binding. | **Portable only / preview.** Automatic reboot-persistent Runtime ownership is not claimed. |

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
- Computer provider prerequisites for Browser or native Desktop interaction; Forge discovers supported Chromium-family products instead of binding readiness to one developer browser/path;
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

Portability is checked at two separate layers:

- `check:platform-support` is the static anti-binding gate. Product/runtime surfaces may not encode personal absolute home paths as deployment authority, and the documented package/runtime contracts must remain present.
- `check:portable-package` installs the packed npm artifact into a temporary application with an isolated `HOME`, `XDG_STATE_HOME`, npm cache, and `FORGE_CONTROLLER_HOME`. It exercises the packaged CLI/hook without Bun or pre-existing Forge state and rejects source-checkout leakage into Controller state.
- The Windows smoke workflow covers the advertised native PowerShell/Node preview surface. Platform-specific live provider checks remain capability-scoped rather than being inferred from the operating-system name.

A platform claim therefore means its named capability path is tested; it does not imply that every optional third-party provider is installed or available on every machine.
