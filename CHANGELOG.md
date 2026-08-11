# Changelog

All notable public Forge changes are recorded here. Release entries are tied to immutable Git tags and the matching package version.

## Unreleased

No unreleased public changes are currently recorded.

## 1.5.0-rc.1 - 2026-08-11

### Official plugin distribution

- Added the pinned official plugin catalog and `forge plugin catalog`, `forge plugin list`, and `forge plugin install` commands.
- Added trusted `managed_cli_json` external-provider transport for bounded cross-platform product providers.
- Published and pinned Forge Desktop Operator `v0.2.0`, Forge Design `v0.3.0`, and Personal Knowledge Assistant `v0.2.1` as independent repositories.
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
