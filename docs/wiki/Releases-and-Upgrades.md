# Forge Releases and Upgrades

## Published stable release

**Forge v1.8.2** was released on October 19, 2026. The canonical package is [`@moretea-labs/forge` on npm](https://www.npmjs.com/package/@moretea-labs/forge), and the matching [GitHub Release](https://github.com/moretea-labs/forge/releases/tag/v1.8.2) provides an immutable `v1.8.1` tag. npm `latest` is the stable channel; `next` is reserved for release candidates.

## Install or upgrade to the latest stable

```bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup next
forge doctor
```

When using the packaged persistent service, `forge runtime service install-package` reconciles the installed Package Runtime. Review [Installation](Installation) and [ChatGPT connection](Connecting-ChatGPT) for platform-specific setup. Updates do not remove the requirement to validate the authenticated MCP connector.

## How releases are verified

Source version, package identity, immutable Git tag, npm dist-tag, and GitHub Release must agree. `check:release` checks source gates, packaging, licensing/open-source hygiene, and isolated installation; `check:release-published` checks npm registry metadata and downloaded tarball integrity against the local version and tag. Publication is performed by protected GitHub Actions with npm OIDC Trusted Publishing.

Release readiness and active whole-Runtime activation are different authorities; do not infer a healthy local service just from successful package publication. Contributor release changes are validated by repository release checks and tracked in the relevant GitHub Issue/Project; publication still uses the protected GitHub Actions workflow.

For future releases, derive their version from the then-current `package.json` and update the matching immutable GitHub Release link.
