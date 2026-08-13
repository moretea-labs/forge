# Versioning and release baseline

Forge uses Semantic Versioning for the public CLI package and matching GitHub tags.

## One version authority

For every public release, these values must agree:

- `package.json` version;
- root `package-lock.json` version;
- Git tag `v<package-version>`;
- GitHub Release tag;
- npm package version.

`node scripts/check-release-version.mjs` enforces the package/tag/channel relationship. A tag that does not exactly equal `v${package.version}` fails closed.

## Channels

- `X.Y.Z-rc.N` publishes to npm dist-tag `next` and creates a GitHub prerelease.
- `X.Y.Z` publishes to npm dist-tag `latest` and creates a stable GitHub Release.
- `publishConfig.tag` is intentionally omitted so package metadata cannot silently force a stable package to `next` or an RC to `latest`.
- `publishConfig.provenance` remains `true`; protected GitHub OIDC publishing is the normal provenance path after bootstrap.

The current stable release line is `1.5.1`. Future release candidates use the same `X.Y.Z-rc.N` → `next` contract before promotion to `latest`.

## Runtime compatibility

The public launcher requires Node.js 20.10 or newer. Bun 1.0 or newer is supported as an alternative package client and development runtime, but Bun consumes the same npm package; there is no separate Bun release line.

## Homebrew

Homebrew is a distribution wrapper, not a version authority. A formula may be added to a Moretea Labs tap only after a stable npm/GitHub release exists with an immutable source URL and checksum. Formula updates must use the same stable version and pass an installation test.

## Historical tags

Only tags present on the canonical GitHub remote and described by GitHub Releases belong to this project’s public release line. Local tags inherited from older or unrelated repositories are not release evidence.
