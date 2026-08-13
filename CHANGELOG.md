# Changelog

All notable public Forge changes are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

### ChatGPT Secure Tunnel and package setup

- Make `--tunnel auto` prefer OpenAI Secure MCP Tunnel instead of silently selecting an installed public-ingress CLI. Cloudflare, Tailscale, existing HTTPS, and deferred remote access remain explicit fallbacks.
- Add a package-managed loopback OAuth Gateway for ChatGPT alongside the bearer-only Canonical Runtime, and persist the local OAuth endpoint in user-level MCP configuration so Secure Tunnel never targets the internal Runtime directly.
- Accept modern ChatGPT `server/discover` probing with the correct legacy fallback response, detect tunnel runtimes by `tunnel_id` rather than a hard-coded alias, and prefer an existing repository Controller Home during setup reconciliation.
- Clarify that the ChatGPT App/connector owns application/tool identity while Secure Tunnel owns transport, document migration from Cloudflare/HTTPS, and add the supported npm update flow (`npm install -g @moretea-labs/forge@latest` then `forge setup next`).

## 1.5.0 - 2026-08-13

### Stable Runtime and recovery

- Graduated the single Canonical Runtime plus independent Recovery architecture to the first stable Forge release.
- Hardened whole-Runtime restart, rollback, source coherence, launcher resolution, process storage lifecycle, and recovery activation behavior.
- Isolated Work verification snapshots from unrelated concurrent files and fixed persisted check semantic identity under compiled Runtime releases.

### ChatGPT continuity and execution performance

- Added bound ChatGPT work continuation across natural restarts with authenticated controller ownership and safer continuation activation.
- Reduced avoidable MCP/reasoning round trips, composed direct edit validation, and kept short Process Runtime commands synchronous long enough to avoid unnecessary follow-up waits.
- Removed redundant Runtime schema discovery round trips from the MCP hot path while retaining session schema fencing.

### Product surface

- Added the React-based local Forge utility workstation and continued consolidating retired controller/campaign compatibility surfaces.
- Kept the stable ChatGPT MCP surface at 19 tools while preserving the official provider/plugin model introduced in the release candidate.

## 1.5.0-rc.1 - 2026-08-11

### Official plugin distribution

- Added the pinned official plugin catalog and `forge plugin catalog`, `forge plugin list`, and `forge plugin install` commands.
- Added trusted `managed_cli_json` external-provider transport for bounded cross-platform product providers.
- Published and pinned Forge Desktop Operator `v0.2.0`, Forge Design `v0.3.0`, and Personal Knowledge Assistant `v0.2.1` as independent repositories.
- Updated the Desktop Operator pin to `v0.2.1`, adding silent background Chrome/Vivaldi sessions, stable native tab reattachment, and fail-closed foreground-only screenshot behavior.
- Official installs validate the package manifest, clone only the fixed Moretea Labs HTTPS repository at an immutable tag, and write through the existing Controller Home external-registration authority.
- Investment Decision System remains an independent product and is intentionally absent from the Forge plugin catalog.

### Runtime and execution

- Unified the product, npm package, CLI, Runtime, protocol, environment, state directory, documentation, and repository identity under **Forge**.
- Kept bounded work Direct-first and reserved durable Work/worktrees for recovery, isolation, dependencies, concurrency, or longer lifecycle needs.
- Converged lifecycle authority on one Canonical Runtime service plus an independent Recovery boundary.
- Hardened Process receipt recovery, terminal Work cleanup, local-system behavior, and stale tool-schema fencing.
- Added resumable `forge setup open`, `forge setup next`, `forge setup status`, and `forge setup close` first-run configuration.

### Public project surface

- Reworked the GitHub homepage and documentation navigation around npm-first installation, the 19-tool ChatGPT surface, architecture, safety, plugins, support, and contribution paths.
- Removed stale pre-release/version claims from maintained tutorials and release documentation.
- Added a maintained Chinese documentation hub and professionalized the official provider repositories with CI, security, support, contribution, issue, and pull-request surfaces.

## Earlier development history

Detailed pre-Forge development notes remain in [docs/CHANGELOG.md](docs/CHANGELOG.md) as historical evidence only. They do not define the current product identity, Runtime architecture, or release status.
