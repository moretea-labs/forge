# Quick Start

## 1. Install from source

Until the npm RC is publicly available, use the verified source path:

```bash
git clone https://github.com/moretea-labs/matea.git
cd matea
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

Requirements: Git, Node.js 20.10+, npm, and a writable user directory. Bun is recommended for development and the complete test suite.

## 2. Initialize and diagnose

```bash
matea --version
matea init --target both
matea doctor
```

## 3. Register a repository

```bash
matea adopt --repo /path/to/project --dry-run
matea adopt --repo /path/to/project
matea repo list --json
```

Use dry-run first when adopting an existing project. Review the proposed files and runtime configuration before applying.

## 4. Connect ChatGPT

Follow the maintained [connector tutorial](https://github.com/moretea-labs/matea/blob/main/docs/tutorials/02-connect-chatgpt.md). After connection, verify status and repository context before starting write work.

## 5. Complete one bounded task

Start with a small change, inspect the diff, run the focused check, commit, and clean the branch or worktree. The full walkthrough is in [First Repository Task](https://github.com/moretea-labs/matea/blob/main/docs/tutorials/03-first-repository-task.md).

## Next

- [Core Concepts](Core-Concepts)
- [Work Lifecycle](Work-Lifecycle)
- [Troubleshooting](Troubleshooting)
