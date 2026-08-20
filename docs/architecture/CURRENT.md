# Forge Current Architecture

Status: **Runtime Authority**

This file is the sole maintained architecture authority for the current Forge runtime. Executable code and persisted schemas are authoritative for implementation facts; this document defines the architecture contracts they are expected to preserve. Do not hard-code a source commit here: release-specific snapshots belong in [`versions/`](versions/).

## Product model

Forge is an executable AI harness for a semantic controller. The controller owns requirement interpretation, repository understanding, implementation decisions, review, and the decision to keep exploring. Forge supplies fast context retrieval, deterministic local execution, provider actions, bounded verification, evidence, and optional durable continuity.

```text
Semantic Controller
  -> Context Engine
  -> Thin Execution Harness
  -> Verification / Evidence
  -> Optional Durable Workflow / External Effect boundary
```

Quality is prioritized over interactive performance; performance is prioritized over durability machinery that does not materially improve ordinary coding.

## Context engine

- `rh_context` is the primary discovery/read path and may be called repeatedly.
- The first request may perform one broad parallel discovery fan-in; natural-language lexical terms are heuristic hints, not completeness obligations, so individual guessed terms do not need to produce results.
- Once credible paths or symbols are discovered, the semantic controller derives the next retrieval from returned source and prefers exact known paths, compiler-backed symbol navigation, or structural relationships over repeating the same broad lexical scan. Follow-up requests reuse in-process/session caches.
- Exact known paths reserve retrieval budget and current raw source is authoritative.
- Complete small files and complete matched symbols are preferred over arbitrary line windows.
- CodeGraph is discovery/relationship evidence, not semantic-completeness authority. Stale structural evidence must be labeled and current changed files remain raw-source authoritative.
- TypeScript Language Service navigation provides compiler-backed definition/reference/implementation lookup for TypeScript symbols through `rh_context`. Swift uses the same bounded `semantic_navigation` route with SourceKit-LSP, but only on explicit symbol requests and only when SwiftPM, BSP (`buildServer.json`), or compilation-database build settings are already available; Forge never performs an implicit build/index just to answer context. Multiple Swift requests in one context call share one short-lived LSP session. Missing/stale build settings degrade explicitly to lexical/CodeGraph evidence rather than returning a false complete closure.
- The default 19-tool MCP schemas are a deployment ABI because approved ChatGPT apps may retain a frozen action/input snapshot. Core quality capabilities therefore need a path through already-stable facade fields. `rh_context` supports precise `@tsnav` and `@swiftnav` directives in `query` as compatibility paths; refreshed clients may use the existing structured `semantic_navigation` field.
- Exact lexical search remains necessary for dynamic registrations, manifests, string capability IDs, persisted aliases, and unrelated same-name implementations, but it is a discovery/fallback mechanism rather than the proof of static symbol completeness.

## Execution lanes

### Ephemeral Direct — default

Ordinary local reads, Git inspection, edits, local scripts, builds, and short checks should execute with minimal controller overhead. No persistent Work is created merely because the task is complex or investigative.

### Lightweight Managed

Commands that outlive the interactive admission window may expose an in-memory/lightweight process handle with bounded logs and wait/cancel/status. This lane does not require durable Process records, recovery membership, or Lease ownership merely to remain queryable during the current Runtime lifetime.

### Durable Workflow / Process

Persistent Work/Process state is reserved for actual continuity requirements: scheduled workflows, multi-session continuation, independent deliverables, explicit recoverability, long asynchronous workflows, release boundaries, or multi-controller coordination.

### External effects

Remote or non-idempotent effects are explicit boundaries. Ambiguous outcomes are reported as `outcome_unknown`; Forge must not silently replay a non-idempotent remote operation.

## Work and Plan

Work is a continuity/orchestration mechanism, not a coding-quality mechanism. File count, changed-line count, protected paths, dirty workspace state, review intent, or investigation alone must not create Work. Complex implementation quality is achieved through better repository understanding and fresh review, not heavier lifecycle state.

Plan is optional intent/coordination state. Initial likely paths are evidence, not a frozen semantic scope. The controller may discover and edit additional policy-allowed files without creating a second lifecycle solely because understanding improved.

## State ownership

- Git/worktree owns repository source truth.
- Edit Session owns one deterministic local patch transaction and reviewable diff evidence.
- Lightweight process handles own only current-runtime attach state.
- Validation results own check evidence for the exact inputs they verified.
- Work owns durable continuity only when continuity is actually required.
- Durable Process owns persisted command/check lifecycle only when the selected lane is durable.
- Runtime release/recovery state owns Forge service availability and immutable release activation; it is separate from ordinary command recovery.
- Historical Issue/Task/Local Job and compatibility projections must not become second mutable authorities.

## Runtime and MCP boundary

- Canonical Runtime is activated as one immutable whole release with a previous release retained for rollback.
- Runtime availability/recovery keeps Forge itself healthy; it does not imply exactly-once crash recovery for every local shell command.
- The default Controller MCP schema is the stable **19-tool** surface.
- `core` and `advanced` expose that same stable surface.
- `toolset=full` is an explicit compatibility profile and may contain historical definitions; current default schema construction must not depend on those legacy definitions.
- Current schemas/handlers should live with their owning module. Legacy compatibility may delegate but must not independently own current business rules.

## Provider boundary

Typed provider/plugin actions should use Forge capability/resource semantics directly instead of hiding host/browser/device operations inside arbitrary repository shell commands. Built-in providers may remain inside Forge when they are tightly coupled to Controller policy and lifecycle; independent products/providers retain independent release boundaries and integrate through the Plugin Protocol.

## Testing and verification

Tests are verification evidence, not an alternate architecture authority.

- Development/task gate: typecheck + static architecture + manifest validity + affected tests.
- Main candidate: task gate + core regression + Runtime smoke.
- Release candidate: main gate + full regression + release packaging/readiness.
- Test governance validates registration, resource classification, selection and execution isolation; it does not impose arbitrary global test-line or resource-count budgets.
- Prefer a small number of architectural invariants, focused module tests and essential integration/E2E coverage. Delete implementation-coupled or retired-compatibility tests when the underlying obligation is removed.

## Documentation authority

The maintained documentation surface is intentionally small:

- [`../README.md`](../README.md) — documentation entry.
- [`../ROADMAP.md`](../ROADMAP.md) — current/next priorities.
- `CURRENT.md` — current architecture authority.
- [`EVOLUTION.md`](EVOLUTION.md) — append-only architecture change log.
- [`versions/`](versions/) — architecture snapshot created at release/version boundaries.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) — release/user-visible change log.

Research notes, tasks, reviews, old architecture pages, plans and Git history are evidence/history only. They do not need to be synchronized on every source edit.

## Intentionally retained compatibility debt

- Explicit `toolset=full` remains a supported legacy compatibility boundary for now.
- Some large runtime modules still aggregate multiple responsibilities and should be decomposed only when a clear ownership boundary is available.
- CodeGraph may be structurally stale between index refreshes; current raw source and changed-file overlays remain authoritative.

These items belong on the roadmap, not in parallel current-architecture documents.
