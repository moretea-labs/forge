# Changelog

All notable public Forge changes are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

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
