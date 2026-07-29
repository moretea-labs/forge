# Changelog

All notable public changes to Matea are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

### Changed

- Adopted **Matea** as the product name: a local-first action assistant that starts with software work and can grow beyond repository control.
- Added `matea` and `matea-hook` as the primary CLI names while retaining `repo-harness` and `repo-harness-hook` as compatibility aliases for the 1.x migration.
- Reworked the public README, documentation hub, support guidance, and versioned GitHub Wiki source around installation, first use, concepts, operations, recovery, security, and releases.
- Added contribution, security, support, conduct, issue, and pull-request guidance.
- Added a version/tag/channel release contract and corrected the public installer package identity.
- Added versioned GitHub Wiki source and an open-source repository maintenance baseline.
- Hardened Windows command execution with case-insensitive `PATH`/`PATHEXT` resolution, safe `ComSpec` handling for batch shims, and cross-platform runtime test fixtures.
- Forced managed Cloudflare tunnel examples and keepalive paths to HTTP/2 so UDP/QUIC loss does not leave a live-but-unreachable tunnel process.
- Made Stable Supervisor releases use the full Git commit identity and added an explicit verified known-good attestation path for safe rollback.

## 1.4.0-rc.6 — 2026-07-29

`1.4.0-rc.6` is the GitHub prerelease baseline for the Matea product identity, Windows-native command execution, HTTP/2 tunnel resilience, full-revision Stable Supervisor releases, verified known-good recovery evidence, and the reworked public documentation and Wiki.

The npm package remains separately verified and must not be described as published until `@moretea-labs/matea@1.4.0-rc.6` is visible in the registry. The first stable target is `1.4.0`; stable publication still requires the installation path, CLI smoke tests, MCP connection path, immutable runtime cold start, tarball installation, package contents, and rollback documentation to be verified from one revision.

## Earlier development history

Detailed pre-baseline development notes remain in [docs/CHANGELOG.md](docs/CHANGELOG.md). Those notes use historical repo-harness terminology and do not override the current Matea product identity or release status.
