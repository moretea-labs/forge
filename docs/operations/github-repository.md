# GitHub Repository Maintenance Baseline

This document records the intended public GitHub configuration for Forge. The repository should remain useful from the README alone, while detailed behavior stays versioned under `docs/`.

## Repository metadata

- **Description:** `Local-first action assistant for durable, reviewable software work.`
- **Homepage:** `https://github.com/moretea-labs/forge/wiki`
- **Topics:** `ai-agents`, `ai-assistant`, `chatgpt`, `mcp`, `local-first`, `developer-tools`, `automation`, `agentic-workflow`, `typescript`
- **Features:** Issues, Discussions, Wiki, security policy, and Private Vulnerability Reporting enabled.
- **License:** MIT, with `NOTICE` and third-party notices preserved.

The README should keep a clear product statement, release/CI/license badges, npm-first Quick Start, architecture entry point, official-provider table, safety boundary, and direct links to docs/support/contributing.

## Main branch protection

`main` keeps linear history, blocks force-pushes and deletion, and requires the always-running `Main gate` check to pass. The Windows smoke workflow remains path-scoped: it runs when Windows/portable-runtime surfaces change and is additional evidence rather than a globally required check that would stay absent on documentation-only changes.

Forge also uses maintainer automation that can legitimately integrate reviewed local work directly. Do not add a blanket mandatory human-review rule that disables that workflow without first migrating the automation to pull requests. External contributors should use pull requests; maintainer direct integration remains subject to required checks and release gates.

## Release protection

- Protect `v*` release tags from accidental mutation/deletion where the repository ruleset supports it.
- Use the GitHub `npm-publish` environment for npm publication.
- Use npm Trusted Publishing/OIDC from `.github/workflows/release.yml`; do not store a long-lived npm token when OIDC is available.
- Package version, exact Git tag, npm dist-tag, and GitHub Release must agree.
- Release candidates publish to npm `next`; stable releases publish to `latest`.
- A release is not complete until npm registry state and the GitHub Release are both verified after the tag workflow finishes.

## Community surface

Keep these files current:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `SUPPORT.md`
- `CODE_OF_CONDUCT.md`
- issue forms and pull-request template
- `.github/release.yml` release-note categories

Use Issues for reproducible defects and scoped feature requests. Use Discussions for open-ended usage questions. Security vulnerabilities belong in Private Vulnerability Reporting, never in a public issue.

## Documentation ownership

The GitHub Wiki is a presentation target. Versioned source lives under `docs/wiki/`. Deeper engineering detail remains under `docs/architecture/CURRENT.md` and `docs/operations/`.

Public documentation must distinguish current facts from historical evidence. Avoid hard-coding “next release” versions in operational runbooks; derive versions from `package.json` so routine releases do not leave stale docs behind.

## Maintenance cadence

For every release candidate:

1. review the README and installation claims;
2. run public-doc, open-source, package, and release-surface gates;
3. check repository metadata, topics, security reporting, Issues/Discussions, and release notes;
4. verify official provider pins and fresh-install behavior when the catalog changed;
5. push the exact release revision and wait for required checks;
6. publish the exact version tag;
7. verify GitHub Release and npm dist-tags independently;
8. keep the release notes concise, user-facing, and linked to upgrade/support documentation.
