# Changelog

All notable public changes to Matea are recorded here. Release entries are tied to immutable Git tags and the matching npm package version.

## Unreleased

### Changed

- Adopted **Matea** as the product name: a local-first action assistant that starts with software work and can grow beyond repository control.
- Added `matea` and `matea-hook` as the primary CLI names while retaining `repo-harness` and `repo-harness-hook` as compatibility aliases for the 1.x migration.
- Simplified the primary README around product purpose, verified setup, support, and release status.
- Added contribution, security, support, conduct, issue, and pull-request guidance.
- Added a version/tag/channel release contract and corrected the public installer package identity.
- Added versioned GitHub Wiki source and an open-source repository maintenance baseline.

## 1.4.0-rc.6 — planned

`1.4.0-rc.6` is the next release-candidate baseline. It is not published until the release gate passes on the exact tagged revision and the npm package is visible under `@moretea-labs/matea`.

The first stable target is `1.4.0`. Stable publication requires the RC installation path, CLI smoke tests, MCP connection path, tarball installation, package contents, and rollback documentation to be verified from one immutable revision.

## Earlier development history

Detailed pre-baseline development notes remain in [docs/CHANGELOG.md](docs/CHANGELOG.md). Those notes use historical repo-harness terminology and do not override the current Matea product identity or release status.
