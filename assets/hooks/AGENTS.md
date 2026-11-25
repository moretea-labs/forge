# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

## Local Context Contract

- Describe only the ownership, boundaries, stable entrypoints, and local verification commands for this functional block.
- Keep sibling `CLAUDE.md` and `AGENTS.md` files aligned. Claude Code consumes `CLAUDE.md`; Codex consumes `AGENTS.md`.
- Record the local LSP/tooling profile here when it differs from the repo default.
- Route deep implementation detail into nearby docs instead of inflating root agent context files.
- Treat `.ai/context/context-map.json` as the index of discoverable context files.
- Do not keep pushing context files deeper by default; add lower-level files only for a separately owned functional block with its own commands and invariants.
- GitHub Issues/Projects are the only development progress ledger; authored repository context holds stable source knowledge and Forge owns mechanical execution/effect receipts. Do not require Work/Plan/WorkHandle.

<!-- BEGIN CAPABILITY CONTEXT -->
## Capability Context

- Capability ID: `runtime-harness-hook-adapters`
- Domain: `runtime-harness`
- Name: `hook-adapters`
- Primary prefix: `assets/hooks`

## Positioning

Owns the runtime-harness-hook-adapters capability boundary declared in .ai/context/capabilities.json.

## Source Map

- Primary prefix: `assets/hooks` (entrypoint)

## Refresh Hints

- `bun test tests/hook-runtime.test.ts tests/hook-contracts.test.ts tests/workflow-contract.test.ts`
- `forge run check-task-workflow --strict`
<!-- END CAPABILITY CONTEXT -->

<!-- BEGIN LOCAL SOURCE CONTRACT -->
## Local Source Contract

- Functional block: `assets/hooks`
- Capability ID: `runtime-harness-hook-adapters`
- Entrypoint: `assets/hooks`
- Authority: current source/public APIs/static checks/tests plus the project Requirement/Issue; no repo-local architecture document or event ledger is required.
- Allowed dependencies: follow root `AGENTS.md` / `CLAUDE.md` and preserve real path, permission, resource, process, Git/CAS, and effect-safety boundaries.
- Verification: `bun test tests/hook-runtime.test.ts tests/hook-contracts.test.ts tests/workflow-contract.test.ts`
<!-- END LOCAL SOURCE CONTRACT -->
