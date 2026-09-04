# Development Protocol Reference

## Authority model

Forge is Controller-first. Repository files hold authored product/architecture/source/test/declarative content; mutable execution lifecycle state belongs to Controller Home. Optional host skills and prompts may improve reasoning but cannot authorize mutation or declare completion.

## Default flow

1. Read the requirement and current source/context evidence.
2. Establish product/architecture direction before low-level patching.
3. For high-risk/cross-cutting work, satisfy the Engineering Design completeness contract.
4. Use direct execution for bounded work; use durable Plan/Work only for real continuity/decomposition/recovery/external-effect needs.
5. Implement one coherent slice, then run focused checks and exact implementation review.
6. Reconcile blockers and terminal cleanup before delivery.
7. If replanning, account for every unresolved predecessor obligation explicitly; never silently lose scope.

Human durable repo surfaces include `docs/spec.md`, `docs/researches/`, `tasks/todos.md`, and `tasks/lessons.md`. Legacy task-contract/review/current/workstream files are migration evidence, not the modern workflow source of truth.
