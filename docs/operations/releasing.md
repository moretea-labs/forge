# Releasing Forge

The public package is `@moretea-labs/forge`. It exposes exactly `forge`, `forge-hook`, and `forge-runtime`; previous product aliases are not published.

## Release model

`@moretea-labs/forge` publishes release candidates to npm `next` and stable releases to `latest`. Release documentation does not hard-code the “next version”; package version, Git tag, npm channel, and GitHub Release must be derived from the current `package.json` and agree exactly.

## Distribution model

1. **npm** is the primary package registry and version authority for the CLI artifact.
2. **Bun** installs or executes the same npm package; no separate Bun publication is required.
3. **GitHub Releases** publish release notes and immutable release identity for the matching Git tag.
4. **Homebrew** is added through a Moretea Labs tap only after a stable release exists.

RC versions use npm dist-tag `next`. Stable versions use `latest`. `publishConfig.provenance` remains enabled, while the channel is selected explicitly by the release command or workflow.

## Required local gate

From a clean checkout at the intended release commit:

```bash
bun install --frozen-lockfile
bun run check:main
bun run check:release
```

Also verify both supported launch paths:

```bash
node bin/forge.mjs --help
bun bin/forge.mjs --help
```

The main gate reuses the focused task receipt and does not run the full suite. The release gate reuses that receipt, verifies package identity, documentation, licenses and notices, tracked-file hygiene and public export contents, then creates one tarball under `.ai/harness/artifacts/release/`. Isolated installation and publication consume that same tarball. `test:full` is a manual diagnostic only.

## Bootstrap npm publication (only while the package does not exist)

npm Trusted Publishing cannot be configured for a package that does not exist yet. The bootstrap publication therefore requires an npm maintainer for the `@moretea-labs` scope with two-factor authentication. Because this one-time local path has no OIDC provider, `NPM_RELEASE_BOOTSTRAP=1` disables provenance only for that bootstrap publish; `publishConfig.provenance` remains `true` for normal GitHub OIDC releases.

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs

# Create and inspect the local tag, but do not push it before publication succeeds.
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "Forge ${VERSION}"
NPM_RELEASE_BOOTSTRAP=1 RELEASE_TAG="v${VERSION}" npm run release:rc
```

If publication fails, remove the unpushed local tag, correct the problem, rerun the focused and release gates, and create a new release commit when repository content changes. Never reuse a published package version or move a pushed release tag.

After npm confirms the package:

```bash
git push origin "v${VERSION}"
gh release create "v${VERSION}" --verify-tag --generate-notes --prerelease
npm run check:release-published
```

## Trusted Publishing after bootstrap

After the package exists:

1. Configure npm Trusted Publishing for `moretea-labs/forge` and `.github/workflows/release.yml`.
2. Configure the GitHub environment `npm-publish` with required maintainer approval.
3. Protect release tags and the `main` branch.
4. Push only an exact `v<package-version>` tag after the release gate passes.

The tag workflow uses GitHub OIDC and does not require `NODE_AUTH_TOKEN` or a stored npm token. It validates the exact tag and channel. If the exact version was already published by the one-time bootstrap path, the workflow skips duplicate npm publication and still creates the matching GitHub Release; later versions publish normally through Trusted Publishing.

## Stable release

Before a stable `X.Y.Z` release:

- install the exact packed artifact on macOS, Linux, WSL2, and the supported Windows path;
- verify `forge install`, `forge doctor`, repository registration/adoption, and the ChatGPT MCP connection;
- confirm no RC-only warning or unstable install command remains in the stable docs;
- change `package.json` from an RC version to the intended stable `X.Y.Z`; the package identity gate will require `latest`;
- publish from the exact `vX.Y.Z` tag through the protected environment;
- only then create or update the Homebrew tap formula.

## Rollback and incident rule

npm versions and pushed release tags are immutable. A bad release is not overwritten: deprecate the affected npm version when appropriate, document the incident, restore the previous dist-tag if needed, and publish a new patch or RC version.
