# Changelog

All notable public Forge changes are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

### Forge 1.5 plugin distribution

- Added the official pinned plugin catalog and `forge plugin catalog`, `forge plugin list`, and `forge plugin install` commands.
- Added trusted `managed_cli_json` external-provider transport so cross-platform product providers can be installed without compiling their implementation into Forge.
- Published and pinned Forge Desktop Operator 0.2.0, Forge Design 0.3.0, and Personal Knowledge Assistant 0.2.1 as independent repositories/releases.
- Official installs validate the package manifest, clone only a fixed Moretea Labs HTTPS repository at an immutable version tag, then write through the existing Controller Home external-registration authority.
- Investment Decision System remains an independent product and is intentionally absent from the Forge plugin catalog.

### Changed

- Unified the product, npm package, CLI, Runtime, protocol, environment, state-directory, documentation, and repository identity under **Forge**.
- Removed previous product command aliases and compatibility binaries; the public command surface is `forge`, `forge-hook`, and `forge-runtime`.
- Converged lifecycle authority on one canonical Forge Runtime service and one atomic active/previous whole-release authority.
- Added standalone Recovery watchdog behavior that performs bounded whole-Runtime restart attempts before an independently attested previous release and its SQLite backup can be restored, restarted, and verified.
- Kept blue-green slots, mixed generations, component rollout, and component rollback retired.
- Added the resumable `forge setup open`, `forge setup next`, `forge setup status`, and `forge setup close` first-run configuration flow.
- Removed completed migration reports, obsolete architecture snapshots, retired Supervisor/Daemon documentation, and stale compatibility guidance.
- Hardened terminal Work cleanup so cleanup blockers cannot downgrade already-landed delivery state.

### Pending verification

- The Forge source convergence is not a release until the protected lockfile is synchronized and the complete type, architecture, documentation, package, release-surface, and Controller checks pass from one immutable revision.
- No live Runtime activation, service installation, remote repository rename, push, or publication is implied by these source changes.

## Earlier development history

Detailed pre-Forge development notes remain in [docs/CHANGELOG.md](docs/CHANGELOG.md) as historical evidence only. They do not define the current product identity, Runtime architecture, or release status.
