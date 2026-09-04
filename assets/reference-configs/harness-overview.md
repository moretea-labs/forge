# Harness Overview

Forge uses ChatGPT (or another explicit semantic Controller) for interpretation and decisions, while Forge owns deterministic execution, durable Runtime authority, scoped authorization/resource fencing, evidence, verification, recovery, and optional continuation.

## Current state boundary

- Repository-authored/declarative surfaces: source, tests, `docs/spec.md`, `docs/researches/`, `tasks/todos.md`, `tasks/lessons.md`, intentional human-maintained plans/docs, and root `forge.config.json`.
- Controller Home: Requirement/Plan/Work/ControllerRound, Schedule/occurrence, Process/Job, leases/resource claims, authorization requests/grants, verification receipts, mutable Plugin configuration, Runtime/session bindings, operational evidence, recovery state, and retention metadata.
- Provider/cache/temp data: Controller-owned provider/cache roots with explicit retention, or OS temp for disposable scratch.

A Markdown or JSON file is not repository source merely because a human can read it. Ownership, authority, lifecycle, and retention decide placement.

## Workflow

1. **Understand**: use current raw source and bounded context evidence.
2. **Design**: for material/high-risk changes, close the Engineering Design contract across identity/authority, authorization, resources, lifecycle, persistence, replay, evidence, recovery, topology, capacity, security, portability, migration, release, and performance.
3. **Plan only when useful**: bounded understood work may remain direct; durable Plan/Work is for real decomposition, continuity, isolation, scheduling, recovery, or external effects.
4. **Execute coherently**: one owner, one mutable authority, explicit resource claims, no incident-specific parallel lifecycle.
5. **Review and verify**: implementation review is tied to exact source/workspace/check evidence and the same design/acceptance contract.
6. **Terminalize**: release leases/worktrees/temp state, retain only policy-required evidence, and let bounded GC reclaim terminal operational data.

## Omission and drift control

Prompt instructions are advisory. Correctness comes from executable gates:

- Context Closure makes material evidence gaps visible before design.
- Engineering Design receipts require cross-cutting decisions for high-risk work.
- Plan supersession must reconcile unresolved predecessor obligations as KEEP/CHANGE/DEFER/DROP.
- Implementation review and verification bind to exact source/workspace/check identity.
- Repository hygiene prevents modern producers from recreating repo-local Runtime state.

## Legacy compatibility

Older `.ai/harness/**`, `tasks/current.md`, `tasks/contracts/`, `tasks/reviews/`, `tasks/notes/`, `tasks/workstreams/`, repo-local Plugin config, and repo-local cache/session surfaces are migration inputs only when a legacy project still contains them. New projects and modern `forge.config.json` projects must not create or mirror-write them. Git history remains the source-history archive; Controller Home owns mutable Runtime history according to retention policy.
