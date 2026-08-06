# GitHub repository maintenance baseline

This document records the intended public repository configuration. It is reviewable source; applying remote settings remains an explicit maintainer action.

## Recommended repository metadata

- Description: `Local-first action assistant for durable, reviewable software work.`
- Homepage: `https://github.com/moretea-labs/forge/wiki`
- Topics: `ai-assistant`, `chatgpt`, `mcp`, `local-first`, `developer-tools`, `automation`, `code-review`, `agentic-workflow`
- Features: Issues, Wiki, Discussions, and private vulnerability reporting enabled.

## Main branch protection

Require pull requests, the exact `CI / Main gate` status check, resolved review conversations, and a linear history. Block force pushes and deletion. The required check installs dependencies once in the workflow and runs `bun run check:main` on every pull request and push to `main`; release packaging remains outside the ordinary CI gate.

## Release protection

- Protect `v*` tags from deletion and modification.
- Use a GitHub environment named `npm-publish` with required maintainer approval.
- Configure npm Trusted Publishing only for `.github/workflows/release.yml`.
- Do not store a long-lived npm token when OIDC is available.
- GitHub Releases and npm versions must match the exact package version.

## Community surface

Keep `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, issue forms, and the pull-request template current. Enable Discussions for open-ended support and keep Issues focused on reproducible work.

## Wiki source

The GitHub Wiki is a presentation target. Versioned source lives under `docs/wiki/`, while deeper engineering detail remains under `docs/architecture/current/` and `docs/operations/`. Syncing the Wiki is a deliberate remote write and should occur only after the source diff is reviewed.

## Maintenance cadence

For every release candidate, review README installation claims, open issues, dependency alerts, security reporting, stale Wiki pages, package contents, and release notes. Before stable release, close or explicitly defer release-blocking issues and publish a support statement for the stable line.
