# Implementation Notes: forge-evaluation-framework

> **Status**: Completed
> **Plan**: `plans/plan-20260820-1800-forge-evaluation-framework.md`
> **Contract**: `tasks/contracts/20260820-1800-forge-evaluation-framework.contract.md`
> **Review**: `tasks/reviews/20260820-1800-forge-evaluation-framework.review.md`
> **Last Updated**: 2026-08-20 18:30

## Design Decisions

- Keep scenario evaluation separate from the existing `evals/` skill-prompt benchmark.
- Clone an immutable source commit with `git clone --no-local`; never create a Git worktree from the source repository.
- Make report output explicit and reject output underneath the source repository.
- Treat an absent evidence category as unmeasured, not as a zero-risk pass.
- Exclude the optional executor trace handoff file from changed-file precision checks, because it is evaluation evidence rather than an implementation change.
- Remove the clone's `origin` remote before invoking Forge and do not expose the source path in the executor environment.

## Deviations From Plan Or Spec

- The built-in adapter is intentionally Forge CLI only. It does not claim to be an autonomous code-writing executor; the historical seed records that limitation in its provenance.

## Open Questions

- Which user-facing Forge execution adapter should be first after the CLI adapter: a desktop/controller bridge or an external agent adapter?
