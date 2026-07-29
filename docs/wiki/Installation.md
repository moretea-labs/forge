# Installation

## Supported paths

### Source installation

This is the verified path while `@moretea-labs/matea` remains unpublished:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

### npm RC channel

After the package is visibly published to npm:

```bash
npm install -g @moretea-labs/matea@next
```

Bun installs the same npm artifact:

```bash
bun add -g @moretea-labs/matea@next
```

Do not infer npm publication from a GitHub tag or prerelease alone.

## Platforms

- macOS and Linux are primary runtime hosts.
- WSL2 is the recommended Windows host for the complete controller runtime.
- Native Windows supports the documented CLI and command-shim surface; check the current matrix before relying on host-specific integrations.

See [Platform Support](https://github.com/moretea-labs/matea/blob/main/docs/operations/platform-support.md).

## Command compatibility

`matea` and `matea-hook` are the primary names. `repo-harness` and `repo-harness-hook` remain 1.x compatibility aliases, and existing `.repo-harness` state is intentionally preserved.

## Verify installation

```bash
matea --version
matea doctor
matea repo list --json
```

A successful CLI launch is not enough to prove the MCP runtime is healthy; verify the connector separately when using ChatGPT.
