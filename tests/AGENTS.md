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
Extend an existing test file before adding a new one, remove duplicate or
historical cases when behavior changes, and keep the manifest within its
machine-checked 80-file/40,000-line budget. Preserve only current observable
contracts and high-risk process, worktree, Controller, and release behavior.
