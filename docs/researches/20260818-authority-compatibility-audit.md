# Authority and compatibility audit

Date: 2026-08-18
Baseline: `8540e85583498ef6a21215788b549db48e28fab7`

This audit distinguishes authoritative mutable state, derived evidence, and retained compatibility. It records the phase-5 caller decision rather than treating every stored record as equivalent authority.

| Concern | Authority after this slice | Decision |
|---|---|---|
| repository contents/integration | Git and the selected checkout | retain |
| deterministic edit batch | Edit Session revision/savepoint | retain |
| ordinary command lifecycle | in-memory Lightweight handle while live; Git/audit after loss | removed from Process SQLite, Lease, and restart reconciliation |
| durable workflow command/check | Process Runtime record and terminal receipt | retain only when Work/verification explicitly binds it |
| workflow continuity | WorkContract | retain only for actual continuity/orchestration |
| managed worktree delivery/cleanup | WorkHandle | retain; it owns physical checkout/finalization state that WorkContract does not encode |
| validation | exact validation result/Process check receipt | retain; Work verification snapshot is an immutable temporary materialization, not an independent status authority |
| implementation scope | `scopeEvidence` for initial/inspected/changed evidence; `allowedPaths` only for policy | separates discovery evidence from authorization |
| checkout/controller views | projections derived from registry/Git/Work | retain as read models; never completion authority |
| Work completion | one Work completion receipt | retain; Task/Run projections cannot manufacture terminal Work |
| resource exclusion | Lease store for durable concurrent ownership only | ordinary local commands no longer acquire leases |
| Runtime release/recovery | complete Runtime release authority and standalone recovery owner | retain; separate from ordinary command recovery |

## Removed compatibility/state

- Public `controller_context_pack` registration and handlers are removed. `rh_context.search` is the sole progressive repository context contract.
- Ordinary local commands no longer create persistent Process records, active indexes, exit receipts, recovery members, request replay bindings, or Process leases.
- Expected file/line counts and debugging/investigation no longer create Work or recovery state by themselves.

## Intentionally retained compatibility

- `controller_context` remains a full-profile operational/read-model compatibility surface; it is not the source-code retrieval contract.
- The full legacy MCP tool service remains for explicit `toolset=full` clients. Retired Issue/Task mutation handlers remain blocked after cutover; deleting that entire profile requires a separately versioned client migration rather than silently breaking supported full-profile callers.
- WorkHandle remains because managed checkout finalization, validation joining, cleanup preservation, and controller capability ownership are physical execution concerns, not duplicated WorkContract business status.
- Work verification snapshots remain immutable temporary trees used to prevent unrelated dirty paths from contaminating a durable Work check. They are deleted after use and do not drive lifecycle transitions.
