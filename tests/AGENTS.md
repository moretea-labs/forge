# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

## Local Context Contract

- Describe only the ownership, boundaries, stable entrypoints, and local verification commands for this functional block.
- Keep sibling `CLAUDE.md` and `AGENTS.md` files aligned. Claude Code consumes `CLAUDE.md`; Codex consumes `AGENTS.md`.
- Record the local LSP/tooling profile here when it differs from the repo default.
- Route deep implementation detail into nearby docs instead of inflating root agent context files.
- Treat `.ai/context/context-map.json` as the index of discoverable context files.
- Do not keep pushing context files deeper by default; add lower-level files only for a separately owned functional block with its own commands and invariants.
- Prefer repo-local workflow artifacts over tool-specific chat memory.

## Test boundary

Tests are a bounded safety net, not an ever-growing specification archive.
Preserve only current observable contracts and high-risk process, worktree,
Controller, effect/idempotency, recovery, and release behavior.

During the current Kernel V2 single-authority convergence:

- Do not add new test files or new test cases. Govern and shrink the existing suite first.
- A failing historical test is evidence, not architecture authority. Never restore a retired production API, compatibility shim, lifecycle state, provider writer, fallback, or wrapper solely to satisfy it.
- Delete a test when its only contract is retired implementation shape, internal field/source-string presence, old lifecycle ordering, obsolete error wording, or a removed compatibility path.
- Update an existing test only when the externally meaningful behavior or mechanical-safety invariant still exists under the accepted architecture.
- Prefer the cheapest authoritative proof: TypeScript/compiler -> architecture/import/AST gate -> retained focused behavior/E2E -> broad regression suite.
- Avoid duplicate proof. If a maintained architecture gate already establishes a structural invariant, remove expensive Runtime tests that only re-check that same structure.
- Keep inner-loop validation focused. Full-suite execution is diagnostic/candidate evidence, not a reason to preserve obsolete tests.

This temporary no-new-tests freeze ends only after the single-authority Runtime
candidate is accepted and the remaining suite has been reclassified by value.
