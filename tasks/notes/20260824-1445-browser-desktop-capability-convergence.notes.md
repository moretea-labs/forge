# Implementation Notes: browser-desktop-capability-convergence

> **Status**: Active
> **Plan**: plans/plan-20260824-1445-browser-desktop-capability-convergence.md
> **Contract**: tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md
> **Review**: tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md
> **Last Updated**: 2026-08-24 14:45
> **Lifecycle**: notes

## Design Decisions

- Browser remains a repository-routed plugin for authorization and artifact/profile placement, but durable Browser session identity is Controller-owned SQLite state. Repository IDs are references, not duplicate authorities.
- Desktop Operator owns durable desktop application-session metadata only. It does not own Browser tab/session policy; the internal browser broker stays a bounded RPC primitive.
- Native tab identity is globally deduplicated. Managed Playwright sessions remain repository-bound because their persistent profile and live context are repository resources.
- Existing `.forge/browser/sessions/*.json` is import-only compatibility state. ChatGPT consultation history remains an artifact domain; only its browser profile binding may seed Browser configuration compatibility.
- Silent reuse is fail-closed. Managed fallback is an explicit opt-in because it is visible and may use a different login profile.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Merge Browser and Desktop into one plugin/process | Reject | It combines unrelated lifecycle/permission/session semantics and creates a second Browser policy owner. |
| Keep all Browser sessions repo-local | Reject | It cannot reuse one user tab across repositories and creates duplicate metadata authorities. |
| Store Browser authority in new JSON files | Reject | Controller-owned mutable state already converges on the Control Plane SQLite envelope. |
| Persist AX refs/screenshots across provider restart | Reject | Those references are process/snapshot-local and unsafe to revalidate implicitly. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
