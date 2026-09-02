# Plan Governance

`plans/` is the repository-owned planning surface. It is not the runtime execution queue, a historical database, or a substitute for durable Control Plane Plan/Work state.

## Directory contract

- `plans/prds/` — product intent and acceptance boundaries.
- `plans/sprints/` — ordered delivery backlogs derived from PRDs or current product intent.
- `plans/plan-*.md` — live, reviewable implementation plans selected explicitly for a worktree.

A plan becomes execution context only through an explicit active-plan/worktree binding or the durable Forge Plan -> Work lineage. The mere presence, timestamp, or status text of a plan file never creates current work.

## Lifecycle and history

```text
Draft -> Reviewed -> Active -> Completed | Superseded | Abandoned -> terminal closeout
```

At terminal closeout, final plan/contract/review/notes state is committed first. Repo-local lifecycle artifacts may then be removed once Forge proves that Git contains their exact final state and no unique staged, unstaged, or untracked evidence would be lost. The durable historical authorities are:

- Git history for repository-authored planning and implementation evidence.
- Forge Control Plane Requirement/Plan/Work/Verification records for execution lineage and currentness.
- Current architecture, operations, product, and release documents for present-tense truth.

Do not create a parallel `plans/archive/` or `tasks/archive/` history tree. Unknown user-authored legacy files are preserved in place and explicitly triaged rather than copied into a second authority.

## Performance and retention

- Gateway, Runtime health, scheduler, and Work currentness paths must not scan `plans/`.
- Large logs, generated artifacts, runtime state, credentials, dependencies, and worktrees never belong here.
- Long-lived capability progress belongs in `tasks/workstreams/`; release history belongs in `CHANGELOG.md` / release metadata; current architecture belongs under `docs/architecture/current/` and `docs/architecture/CURRENT.md`.
