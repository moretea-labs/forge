# Environment and DX hardening

forge supports two local development profiles:

1. **Full Bun profile** — required for the exhaustive `bun:test` suite and Bun-native scripts.
2. **Portable Node profile** — supports install, CLI launch, typecheck, runtime smoke checks, and Node smoke tests when Bun is not available.

## Commands

```bash
npm run check:env
npm run check:type -- --pretty false
npm test
npm run check:ci:portable
```

`npm test` now uses `scripts/run-tests-portable.sh`. When Bun is installed it runs the full Bun test suite. When Bun is missing it runs `tests/node/*.test.mjs` and prints a clear warning that exhaustive tests still require Bun.

## Full CI

```bash
bash scripts/check-ci.sh
```

Full CI still requires Bun because the repository test suite imports `bun:test` in many files. To run a Node-only gate instead:

```bash
FORGE_ALLOW_NODE_ONLY=1 bash scripts/check-ci.sh
```

## Installation runtime selection

`install.sh` supports:

```bash
FORGE_INSTALL_RUNTIME=auto ./install.sh
FORGE_INSTALL_RUNTIME=node ./install.sh
FORGE_INSTALL_RUNTIME=bun ./install.sh
```

`auto` uses Bun when available and falls back to Node.js 20+ with npm when Bun is missing.

## Dev container

```bash
docker build -f Dockerfile.dev -t forge-dev .
docker run --rm -it -v "$PWD:/workspace" forge-dev bash
```

The dev container includes Node, npm, Bun, bash, git, and OpenSSH client so CI and local smoke commands behave consistently across machines.
