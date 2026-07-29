# Contributing to repo-harness

Thanks for helping make repo-harness safer and easier to use. The project values small, reviewable changes backed by real checks more than broad rewrites or unverified claims.

## Before opening a change

1. Search existing issues and pull requests.
2. For bugs, include a minimal reproduction and redacted diagnostic output.
3. For a user-facing change, describe the intended workflow before proposing implementation details.
4. Keep security-sensitive reports out of public issues; follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Git;
- Node.js 20.10 or newer;
- npm;
- Bun 1.0 or newer for the complete test suite.

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
npm ci --ignore-scripts --no-audit --no-fund
node bin/repo-harness.mjs --help
bun bin/repo-harness.mjs --help
```

Run focused tests while working. Before requesting review, run the checks relevant to the change; public and release-facing changes should normally include:

```bash
npm run check:type
npm run check:public-docs
npm run check:release-surface
npm run check:package-identity
```

The complete release gate is:

```bash
npm run check:release-readiness
```

## Change rules

- Do not commit Controller Home, `.ai/harness` runtime state, local jobs, logs, worktrees, tokens, OAuth material, or machine-specific paths.
- Prefer an isolated worktree or a dedicated branch. Do not mix unrelated fixes.
- Preserve structured authorization boundaries. Remote writes, destructive actions, and secret access must remain explicit.
- Add or update tests for behavior changes.
- Keep the root README user-focused. Detailed architecture and operations belong in `docs/` and the GitHub Wiki source under `docs/wiki/`.
- English and Simplified Chinese are the maintained public documentation languages. Other translation landing pages must clearly identify themselves as unmaintained unless a maintainer owns them.
- Do not bump a package version or create a release tag without following [the release process](docs/operations/releasing.md).

## Pull requests

A pull request should contain:

- a clear problem statement;
- a bounded summary of the solution;
- the exact checks run and their outcomes;
- migration, compatibility, or rollback notes when relevant;
- screenshots only when they add evidence.

Maintainers may ask for a smaller patch when a change combines documentation, runtime architecture, and unrelated cleanup.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE) and that required attribution can be recorded in [NOTICE](NOTICE) or [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
