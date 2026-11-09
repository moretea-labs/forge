# Architecture Queue Card: root

> **Status**: Resolved (superseded)
> **Detected**: 2026-10-23T16:30:16+0800
> **Updated**: 2026-11-10T06:23:00+0800
> **Severity**: medium
> **Change Type**: boundary-or-config
> **File**: `package.json`
> **Functional Block**: `root`
> **Capability ID**: `root`
> **Matched Prefix**: `root`
> **Architecture Domain**: `root`
> **Architecture Capability**: `_root`
> **Architecture Module**: `docs/architecture/index.md`
> **Contract Files**: `none`, `none`
> **Contract Sync Required**: false
> **Spawn Recommended**: false
> **Open Edits**: 0

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual explains the boundary better than prose, add or update a Mermaid fenced block in the relevant architecture module or snapshot Markdown first; that Markdown is the semantic source for LLM readers.
- When a human-readable rendering is useful, generate a matching `$mermaid` architecture HTML file under `docs/architecture/diagrams/` and link it back to the Markdown semantic source.
- Treat `mermaid` as an external installed skill dependency at `~/.codex/skills/mermaid`; do not copy, vendor, or inline its templates into this repo.
- Durable Requirement/Plan/Work progress belongs to Forge Controller Home; do not create repo-local workstream/session projections for this architecture event.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links only to authored architecture artifacts.

## Resolution (2026-11-10)

- The originating `package.json` event was commit `8b738e73`, which added `cleanup:works` entrypoints alongside automatic Work finalization.
- Commit `a351dc207` (`#483`) retired automatic Work finalization and removed the cleanup scripts and implementation. The subsequent `#313`/`#483` architecture direction keeps Work historical/read-only; `docs/architecture/CURRENT.md` now records the retired Work lifecycle and the surviving Launch Session/Schedule boundaries.
- Current `package.json` no longer contains the `cleanup:works` entrypoints and matches `origin/main` for this file. No persistent module-boundary, dependency, runtime-path, or verification-entrypoint change remains from this event. No snapshot or contract sync is required; this request is closed as superseded rather than leaving a stale blocking drift item.

## Touched Files

| Last Event | Severity | Change Type | File |
| --- | --- | --- | --- |
| 2026-10-23T16:30:16+0800 | medium | boundary-or-config | `package.json` |

## Event Fields

```json
{
  "ts": "2026-10-23T16:30:16+0800",
  "file_path": "package.json",
  "severity": "medium",
  "functional_block": "root",
  "capability_id": "root",
  "matched_prefix": "root",
  "architecture_domain": "root",
  "architecture_capability": "_root",
  "architecture_module": "docs/architecture/index.md",
  "workstream_dir": "tasks/workstreams/root/_root",
  "contract_agents": "",
  "contract_claude": "",
  "change_type": "boundary-or-config",
  "request_file": "docs/architecture/requests/root.md",
  "spawn_recommended": false,
  "contract_sync_required": false
}
```
