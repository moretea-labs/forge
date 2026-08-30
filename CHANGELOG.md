# Changelog

All notable public Forge changes are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

## 1.7.1 - 2026-08-30

### Runtime and lifecycle stabilization

- Prevent effect-only Work from losing repository source deltas during finalization, and recognize successful trusted Work-bound `git push` Process receipts as remote-effect completion authority.
- Harden controller continuation and terminalization across MCP/session rollover while keeping unrelated conversations isolated, and add stable Requirement-backed business-goal identity so stale continuation cannot silently revive superseded goals.
- Add bounded post-deadline external Codex claim settlement plus precise Work checkout-mismatch diagnostics, preserving fail-closed fencing without false launcher timeouts.

### Browser and release closure

- Converge Browser/desktop automation on the signed Forge Desktop Operator boundary, retain Runtime packaging for the browser handoff host, and close historical capability/permission drift without granting privileged macOS access to Runtime.
- Re-run the full main, MCP compatibility, package, public-surface, open-source, tarball-install, Runtime Recovery, schedule, and tool-surface release contracts before publication.

## 1.7.0 - 2026-08-27

### Persistent autonomous control

- Add the durable Schedule → Work → ChatGPT conversation continuation contract, explicit round dispositions, effect-only Work/finalization semantics, and tab settlement after Controller release instead of immediately after prompt dispatch.
- Keep transient Browser/connector readiness failures on bounded backoff without permanently disabling schedules, while authentication, consent, destructive actions, and other hard boundaries remain fail-closed.
- Make real timer-origin continuation and the Continuous Evolution Supervisor a stable-release gate rather than treating schedule configuration alone as proof of autonomous operation.

### Browser Runtime V3

- Promote Browser Runtime V3 as the current browser architecture with one Controller Home BrowserSession authority, stable plugin-owned native tab identity, background-safe navigation, exact rebind, and explicit physical-input fallback.
- Harden native replacement with strict postconditions, HTTP(S) settlement that rejects transitional `about:*` pages, destination-origin authorization, and preservation of user-owned tabs.
- Improve Chrome/Vivaldi provider behavior, postcondition evidence, restart/rebind handling, and visual evidence integration without adding a second Browser authority.

### Capabilities, plugins, and iOS

- Add deterministic natural-intent capability discovery while keeping `plugin_action_execute` as the sole typed plugin executor and preserving the stable ChatGPT facade.
- Add controller-global plugin profiles with repository overlays, including reusable App Store Connect credential references without copying private-key contents into repository state or tool output.
- Add typed physical-device iOS build destinations and opt-in Xcode provisioning updates using file-backed App Store Connect key references, with bounded/redacted execution evidence.

### Runtime, recovery, and governance

- Continue converging Work/Plan/finalizer lifecycle authority, target-advancement validation, process/session fencing, source coherence, and whole-Runtime immutable activation/rollback under the independent Recovery boundary.
- Keep ChatGPT as the semantic controller and Forge as the deterministic execution/control plane, with Direct-first execution and durable Work/Plan state only where continuity, isolation, recovery, scheduling, or external effects require it.
- Tighten maintained architecture/documentation authority and capability-closure governance so stale Work or superseded design documents do not become parallel current truth.

## 1.6.0 - 2026-08-16

### Architecture V2 and execution governance

- Complete the V2 Direct / bounded Work / Plan execution model, including isolated Work materialization, authoritative finalization, dead-Plan recovery, duplicate-writer prevention, and safer Work validation.
- Decouple durable Work ownership from transient MCP transport sessions so scheduled and interactive ChatGPT execution can resume against stable controller leases and checkout identity.
- Add bounded impact context and CodeGraph-aware retrieval while keeping routing, semantic context, and repository authority converged on one deterministic control path.

### Performance and Runtime

- Reduce controller hot-path overhead with canonical repository-root reuse, exact-file retrieval fast paths, Runtime proxy session reuse, batched Process identity probes, narrower service claims, and read-only SQLite diagnostics.
- Preserve resumable Process/check execution while improving persisted-check retry idempotency, stale-process handling, worktree reconciliation, and release/runtime identity safety.
- Keep the stable 19-tool ChatGPT surface while moving more domain behavior behind typed capability and plugin contracts.

### Automation and plugins

- Add Forge-native ChatGPT workflows, schedules, Work-bound browser watchers, cross-session workflow attribution, and more reliable ChatGPT mode/reasoning selection.
- Add trusted external-plugin registration lifecycle support and official Forge Figma Bridge catalog installation; retire the bundled desktop helper in favor of the external provider boundary.
- Improve plugin scope/compatibility handling, browser URL behavior, image artifact delivery, Gmail Unicode subjects, and automation history/configuration surfaces.

## 1.5.1 - 2026-08-13

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
