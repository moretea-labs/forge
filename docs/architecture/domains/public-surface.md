# Architecture Domain: Public Surface

> **Source**: `.ai/context/capabilities.json`
> **Owner**: CLI/MCP command facade docs.

## Purpose

The public surface turns user intent into one of the supported CLI+hooks harness
actions without duplicating engine policy in prose. It includes the README, root agent docs, the `forge` CLI, and thin
`forge-*` command facades.

## Capabilities

- `public-surface-root-router` -> `docs/architecture/modules/public-surface/root-router.md`
- `public-surface-action-commands` -> `docs/architecture/modules/public-surface/action-commands.md`

## Stable Rules

- Forge ships no host Skill; CLI/MCP and host adapters are the execution surfaces.
- Root `AGENTS.md` and `CLAUDE.md` stay concise; detailed operating rules live in `docs/reference-configs/`.
- Public commands are CLI-backed facades. Internal steps such as `hooks-init`, `docs-init`, and `create-project-dirs` stay behind `init`, `scaffold`, `migrate`, and `upgrade`.
- The former `project-initializer` install paths have been fully removed; no tooling recognizes, syncs, or cleans them up.

## Verification Surface

- `bun test tests/action-command-skills.test.ts`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
