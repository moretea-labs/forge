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

## 2. Install the CLI today

The npm package `@moretea-labs/repo-harness-controller` is not public yet. Install from a reviewed source checkout:

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

Bun can use the same source package:

```bash
bun install
bun add -g .
```

After the RC is published, the registry commands will be:

```bash
npm install -g @moretea-labs/repo-harness-controller@next
# or
bun add -g @moretea-labs/repo-harness-controller@next
```

The package installs `repo-harness` and `repo-harness-hook`. Do not install an unscoped package as a substitute.

## 3. Initialize the user runtime

```bash
repo-harness --version
repo-harness init --target both
repo-harness doctor
```

Use `--target codex` or `--target claude` when only one host is needed. `repo-harness init --help` lists optional integrations that can be skipped.

## 4. Adopt or register a repository

For macOS, Linux, or WSL2, preview adoption first:

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
```

All platforms can register explicitly:

```bash
repo-harness repo register /path/to/your-project --name my-project --json
repo-harness repo list --json
```

Keep the returned `repoId`; it is the stable repository identity used by ChatGPT and the Controller.

## 5. Confirm readiness

```bash
repo-harness doctor
repo-harness status --json
repo-harness repo list --json
```

Runtime state belongs in Controller Home and ignored repository links, not in public source control. Never commit tokens, MCP runtime files, local jobs, logs, or generated worktrees.

Continue with [Tutorial 2: Connect ChatGPT](02-connect-chatgpt.md). For errors, use [Troubleshooting](../operations/troubleshooting.md).
