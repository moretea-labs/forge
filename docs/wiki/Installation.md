# Installation

## Supported paths

### Source installation

This is the verified path while `@moretea-labs/forge` remains unpublished:

```bash
bun install --frozen-lockfile
npm install -g . --omit=optional --no-audit --no-fund
```

### npm RC channel

After the package is visibly published to npm:

```bash
npm install -g @moretea-labs/forge
```

Bun installs the same npm artifact:

```bash
bun add -g @moretea-labs/forge
```

Do not infer npm publication from a GitHub tag or prerelease alone.

## Platforms

- macOS and Linux are primary runtime hosts.
- WSL2 is the recommended Windows host for the complete controller runtime.
- Native Windows supports the documented CLI and command-shim surface; check the current matrix before relying on host-specific integrations.

See [Platform Support](https://github.com/moretea-labs/forge/blob/main/docs/operations/platform-support.md).

## Command compatibility

Forge exposes only `forge`, `forge-hook`, and `forge-runtime`. State directories, environment variables, protocol identifiers, and release artifacts use the Forge namespace.

## Verify installation

```bash
forge --version
forge doctor
forge repo list --json
```

A successful CLI launch is not enough to prove the MCP runtime is healthy; verify the connector separately when using ChatGPT.
