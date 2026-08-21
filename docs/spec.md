# Product Spec

> **Status**: Approved
> **Owner**: Forge maintainers

## Product outcome

Forge is an executable local engineering harness for a semantic controller. It should make repository understanding, implementation, verification, and external tool use faster and more reliable without turning ordinary coding into a durable workflow system.

The controller owns semantic judgement: what the user means, whether more context is needed, what to change, and whether the result is correct. Forge owns deterministic repository mechanics, bounded context retrieval, execution, provider actions, verification evidence, and durable continuity only when continuity is actually required.

## Product principles

- **Direct-first**: ordinary investigation, edits, local commands, builds, and focused checks should use the shortest safe local path.
- **Current source is truth**: Git/worktree source is authoritative for code. `rh_context` and CodeGraph help retrieve evidence; they do not define semantic scope.
- **Durability is selective**: Work and durable Process state exist for real multi-session continuity, independent deliverables, scheduling, release/recovery, or external coordination—not because a task is large or difficult.
- **One authority per concern**: diagnostics, compatibility projections, tests, plans, reviews, and historical records must not become competing runtime or product authorities.
- **External effects are explicit**: remote, destructive, or non-idempotent actions remain permission- and evidence-bounded and are never silently replayed after ambiguous outcomes.
- **Verification follows risk**: use focused checks while developing and authoritative gates at candidate/release boundaries. Tests are evidence, not a second implementation.

## Core user outcomes

1. Understand a repository through bounded raw-source retrieval with optional structural and compiler-semantic navigation.
2. Execute ordinary local work through Ephemeral Direct with minimal fixed overhead.
3. Attach to longer current-Runtime commands through Lightweight Managed handles without promoting them to durable recovery state.
4. Use durable Work/Process only when the task actually needs continuity or orchestration.
5. Use typed plugins/providers for browser, device, account, and other external capabilities while retaining Forge policy and evidence boundaries.
6. Review completion from the actual diff, relevant checks, runtime evidence, and a fresh semantic impact review.

## Non-goals

Forge is not a hosted autonomous-agent platform, personal-assistant runtime, goal/portfolio manager, project-management methodology, or replacement for a repository's own build/test/deploy/release authority. Chat history, generated status files, plans, reviews, and tests are not substitutes for current source and observed runtime facts.

## Architecture contract

[`architecture/CURRENT.md`](architecture/CURRENT.md) is the sole maintained current-runtime architecture authority. This spec defines stable product intent; implementation details and current ownership rules belong there.

## Acceptance

A healthy Forge should keep the default MCP surface small and stable, preserve one canonical Runtime/release authority, make ordinary local work avoid unnecessary persistence/lease/recovery tax, keep Work/Plan optional and purpose-specific, expose coverage gaps rather than fabricate semantic completeness, and prove important behavior with bounded reproducible checks.
