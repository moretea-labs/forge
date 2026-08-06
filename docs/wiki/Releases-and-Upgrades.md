# Releases and Upgrades

## Release channels

- `next`: release candidates; `1.4.0-rc.6` is the current GitHub prerelease
- `latest`: stable releases only

The package version, Git tag, npm channel, GitHub prerelease state, and release notes must agree. GitHub Releases and npm publication are separate facts.

## Release gate

A release candidate must pass the repository's release-readiness check on the exact revision. The gate covers type checking, package identity, public documentation, platform contracts, MCP compatibility, public export, package creation, and tarball installation.

## Stable runtime evidence

Before publication, build an immutable release from a clean canonical source tree, activate it, verify the complete MCP path, cold-restart the OS-managed Supervisor, and confirm the active revision still equals the intended commit. Record the fully verified release as known-good.

## Upgrade principles

- Keep the Forge-only command, state, environment, protocol, and release identity consistent across upgrades.
- Read release notes before changing runtime or connector configuration.
- Do not overwrite a healthy active release with a stale rollout operation.
- Keep a verified rollback path before changing production runtime state.

## Publication sequence

1. Merge reviewed code and docs.
2. Push the exact main revision.
3. Wait for required CI and Windows checks on that revision.
4. Synchronize reviewed Wiki source.
5. Create the exact `v`-prefixed tag and GitHub prerelease.
6. Verify npm separately; never claim publication without registry evidence.

See the maintained [release process](https://github.com/moretea-labs/forge/blob/main/docs/operations/releasing.md).
