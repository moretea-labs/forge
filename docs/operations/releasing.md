# Releasing repo-harness

The public package is `@moretea-labs/repo-harness-controller`. It installs the stable command names `repo-harness` and `repo-harness-hook`.

## Current state

The npm package is not public yet. The next candidate is `1.4.0-rc.6`; the first stable target is `1.4.0`. Until the first npm publication, public documentation must present source installation as the working path and label registry commands as upcoming.

## Distribution model

1. **npm** is the primary package registry and version authority for the CLI artifact.
2. **Bun** installs or executes the same npm package; no separate Bun publication is required.
3. **GitHub Releases** publish release notes and immutable release identity for the matching Git tag.
4. **Homebrew** is added through a Moretea Labs tap only after a stable release exists.

RC versions use npm dist-tag `next`. Stable versions use `latest`. `publishConfig.provenance` remains enabled, while the channel is selected explicitly by the release command or workflow.

## Required local gate

From a clean checkout at the intended release commit:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:release-version
npm run check:release-readiness
npm run release:dry-run
```

Also verify both supported launch paths:

```bash
node bin/repo-harness.mjs --help
bun bin/repo-harness.mjs --help
```

The release gate verifies package identity, documentation, licenses and notices, tracked-file hygiene, MCP compatibility, public export contents, npm pack output, and isolated tarball installation.

## First npm publication

npm Trusted Publishing cannot be configured for a package that does not exist yet. The bootstrap publication therefore requires an npm maintainer for the `@moretea-labs` scope with two-factor authentication.

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs

# Create and inspect the local tag, but do not push it before publication succeeds.
git tag -a v1.4.0-rc.6 -m "repo-harness 1.4.0-rc.6"
RELEASE_TAG=v1.4.0-rc.6 npm run release:rc
```

If publication fails, remove the unpushed local tag, correct the problem, rerun the full gate, and create a new release commit when repository content changes. Never reuse a published package version or move a pushed release tag.

After npm confirms the package:

```bash
git push origin v1.4.0-rc.6
gh release create v1.4.0-rc.6 --verify-tag --generate-notes --prerelease
npm run check:release-published
```

## Trusted Publishing after bootstrap

After the package exists:

1. Configure npm Trusted Publishing for `moretea-labs/repo-harness-controller-runtime` and `.github/workflows/release.yml`.
2. Configure the GitHub environment `npm-publish` with required maintainer approval.
3. Protect release tags and the `main` branch.
4. Push only an exact `v<package-version>` tag after the release gate passes.

The tag workflow uses GitHub OIDC and does not require `NODE_AUTH_TOKEN` or a stored npm token. It validates the exact tag, uses npm `next` for RCs and `latest` for stable versions, publishes the package, and creates the matching GitHub Release.

## Stable release

Before `1.4.0`:

- install the exact packed artifact on macOS, Linux, WSL2, and the supported Windows path;
- verify `repo-harness init`, `doctor`, repository registration/adoption, and the ChatGPT MCP connection;
- confirm no RC-only warning or unstable install command remains in the stable docs;
- change `package.json` to `1.4.0`; the package identity gate will require `latest`;
- publish from tag `v1.4.0` through the protected environment;
- only then create or update the Homebrew tap formula.

## Rollback and incident rule

npm versions and pushed release tags are immutable. A bad release is not overwritten: deprecate the affected npm version when appropriate, document the incident, restore the previous dist-tag if needed, and publish a new patch or RC version.
