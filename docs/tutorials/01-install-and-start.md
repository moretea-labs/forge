# Tutorial 1: Install and start

This tutorial installs the CLI, initializes the user-level runtime, checks the host, and registers one repository.

## 1. Platform and prerequisites

- macOS or Linux: full supported workflow.
- Windows: use WSL2 for the full workflow.
- Native Windows PowerShell: preview support for installation, doctor, repository registration/inspection, and portable controller operations.

Install Git, Node.js 20.10 or newer, npm, and a writable home directory. Bun 1.0+ is optional and recommended for source development and the complete test suite.

```bash
git --version
node --version
npm --version
```

See [Platform Support](../operations/platform-support.md) for the exact matrix.

## 2. Install the CLI

Release candidates are published on npm's `next` channel:

```bash
npm install -g @moretea-labs/forge@next
# or
bun add -g @moretea-labs/forge@next
forge --version
```

For Forge source development, install from the repository instead:

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

The package exposes exactly `forge`, `forge-hook`, and `forge-runtime`. Release candidates use `next`; stable releases use `latest`.

## 3. Open the guided setup session

```bash
forge --version
forge setup open --target both
```

`forge setup open` creates or resumes one user-level setup session below `~/.forge/setup/`. It runs the readiness checks and prints exactly one next configuration action. Complete that action, then continue with the same command loop:

```bash
forge setup next
```

Repeat `forge setup next` until the session reports `ready`, then close it:

```bash
forge setup close
```

Use `forge setup status` to inspect the persisted session and `forge setup check` for a one-shot read-only report. `--target codex` or `--target claude` limits host-specific configuration. The setup session never silently performs remote, secret-bearing, destructive, or service-installing actions.

## 4. Adopt or register a repository

For macOS, Linux, or WSL2, preview adoption first:

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
```

All platforms can register explicitly:

```bash
forge repo register /path/to/your-project --name my-project --json
forge repo list --json
```

Keep the returned `repoId`; it is the stable repository identity used by ChatGPT and the Controller.

## 5. Confirm readiness

```bash
forge setup status
forge doctor
forge status --json
forge repo list --json
```

Runtime state belongs in Controller Home and ignored repository links, not in public source control. Never commit tokens, MCP runtime files, local jobs, logs, or generated worktrees.

Continue with [Tutorial 2: Connect ChatGPT](02-connect-chatgpt.md). For errors, use [Troubleshooting](../operations/troubleshooting.md).
