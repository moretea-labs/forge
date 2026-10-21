# Forge Module Boundaries and Language Evolution

This policy applies to **all Forge source development**. `AGENTS.md` is the entry point. `docs/architecture/CURRENT.md` records active authorities and `docs/reference-configs/runtime-architecture-guardrails.md` defines existing correctness and release constraints. Reconcile any disagreement within the same reviewed delivery; never introduce a second authority.

## Architecture

**The model owns semantic decisions. Thin Forge owns capabilities, durable facts and mechanical correctness.** Preserve one repository, one Runtime release and a modular monolith. Standalone Recovery is an independent failure domain, not another Kernel. Signed OS-native services may be separate processes to preserve platform permission identity; they do not own Requirement, Plan or Work facts.

| Responsibility | Canonical source area | Ownership |
| --- | --- | --- |
| Requirement/Plan/Work | `packages/kernel/goal`, `packages/kernel/work` | stable semantic intent, plan and work |
| Controller and ChatGPT effects | `packages/kernel/controller`, `supervisor` | controller identity/round; exact-send effect authority belongs to Supervisor |
| Scheduling | `packages/kernel/scheduler` | occurrence and wake, not model workflow decisions |
| Identity/grants | `packages/kernel/identity` | principal, permission and user requests |
| Knowledge | `packages/kernel/cognition`, `packages/kernel/memory` | distinct scoped evidence and knowledge facts |
| Wire contracts | `packages/protocols` | neutral typed contract only |
| External interfaces | `adapters/**`, migrated `src/cli/**` | translate MCP/CLI/provider calls; no duplicate durable writer |
| Runtime composition/GUI | runtime composition root, `apps/**` | wire implementations and render state, not business transitions |
| Plugin mechanisms | existing plugin-runtime and Computer owner | typed actions, target binding, native provider primitives |
| Recovery | standalone Recovery authority | restore crashed canonical release, not parallel semantic state |

Domain ownership is semantic, not just folder names. New cross-domain imports must use the target `packages/kernel/<domain>/api/index`; never reach into another domain's `domain/`, `application/`, `infrastructure/` or `ports/`. Kernel must not import concrete adapters, apps, Supervisor implementations or protocol transport writers. Only composition roots select implementations.

## Mechanical enforcement

`node scripts/check-module-boundaries.mjs` uses the TypeScript AST to examine imports, exports, literal dynamic imports and CommonJS `require`. It fails for new Kernel → `adapters/`, `apps/` or `supervisor/` dependencies, private cross-domain imports, cycles between kernel domains, and unapproved Kernel → legacy `src/**` edges.

The 21 existing imports from kernel infrastructure into historical `src/**` implementations are exact migration exceptions in `docs/architecture/kernel-legacy-edge-debt.json`. This file is **shrinking debt, not an authority or a blanket allowlist**: no new exceptions, no wildcard allowances. When old callers migrate, remove their entries in the same change. A stale entry is a failing check.

The checker is one step in existing `check:task` → `check:main` → `check:release`, not an additional lifecycle or CI authority. Verify the checker itself with a negative proof (an illegal import fails) and positive proof (the real existing source passes). If new path aliases/package export mappings are introduced, update its resolution rather than leaving an unchecked way around it.

## Change discipline

1. Examine the actual source, current architecture, owner, and existing Requirement/Plan/Work first; reuse the current objective. Small edits do not require a manufactured workflow.
2. Identify the root cause and one owning domain. Prefer delete/merge/repair over a fallback, extra status, duplicate provider or new background supervisor.
3. Implement one coherent slice. Move callers and remove the legacy writer/path; synchronize public contracts, existing checks and architecture documents. Preserve other writers' dirty files.
4. Verify changed behavior, external effects, unknown-send protection, authorization and release invariants without weakening gates. Reuse unchanged validation receipts.
5. Commit only the verified slice. Integration follows existing GitHub/main protections. Source commits do not prove installed Mac/WSL Runtimes or an active-release canary.

An explicit brief ADR is required for a **new** durable writer, authority, lifecycle state, daemon, cross-process protocol, production programming language, or independent deployable. Record owner, invariants, consumer boundaries, concurrency/crash/replay/retention, migration/deletion, packaging, rollback and observable acceptance. Routine refactoring needs no ADR.

## Language strategy

TypeScript remains responsible for fast-changing orchestration, MCP, plugin contracts and integrations. Keep Swift where native macOS Accessibility, TCC or AppKit identity is required. The existing Rust/Tauri desktop shell is not a reason to translate the Kernel.

Rust is optional and **incremental**, used only after identifying a real systems-level advantage (process/resource ownership, IPC/atomicity, crash/locking or a narrow performance hot path). Start with a bounded interface and measured problem, prove Mac and Linux/WSL behavior and packaging, cut over a single owner, then delete the replaced TypeScript writer and obsolete bridge. No dual persistent stores, permanent TS/Rust fallback, new state or Rust-percent target. Go/Python do not become alternate production Kernels without a separate proven requirement.

A file over 1,000 lines merits responsibility review, not an arbitrary failing size gate. Monitor actual dependency fan-out, cycles, duplicate ownership, controller bookkeeping overhead, delivery lead time and shrinking exceptions. Improve the common structural guard rather than expanding per-incident regex rules.
