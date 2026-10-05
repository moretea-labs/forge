# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-10-05
> **Scope**: Human-maintained deferred goals only. Active Requirement/Plan/Work state lives in Forge Controller Home.

This file is durable project knowledge, not an execution queue or Runtime projection.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Complete historical macOS Automation/TCC cleanup and macOS-only browser live acceptance | Forge source optimization is moving to Forge Cloud Windows. Selector-bound System Settings cleanup, Accessibility/Screen Recording/Automation grants, and Chrome Apple Events behavior require the macOS host and sometimes user-presence confirmation. | Historical macOS principals or unresolved live-browser proof can remain visible even after platform-neutral source fixes; this must not be misreported as Windows-verifiable closure. | Revisit only on the macOS host when exact TCC/browser evidence is required; preserve the signed `Forge Desktop Operator` authority and do not grant equivalent powers to Runtime. |
| Recover/export data from the historical logged-out ChatGPT browser profile | This is account/history recovery rather than Forge product-source correctness and the saved old profile is logged out. | Historical data may remain unavailable, but it does not block Forge source development or release correctness. | Revisit only when the user explicitly asks to recover that account/history and can provide required authentication. |
| Quarantine invalid terminal Work contracts during scheduler relay discovery, and compact bounded control-plane audit retention | The current Runtime repeatedly reads `work-technical-delivery-reconciliatio-56e82fd1` (a `reconciliation` Work incorrectly carrying `completed_changed`), logs `WORK_SEMANTICS_INVALID` on every scheduler tick, and keeps the Runtime status projection stale. The repeated write path has left `control_plane_audit` plus its index at about 1.9 GB. | A repair must preserve evidence and avoid silently changing a completed Work's semantic meaning; it must quarantine/retire invalid legacy data once and prevent repeated logs/audit growth. | Revisit as one controller-runtime repair: add migration/quarantine semantics and bounded audit retention, then verify that an invalid Work cannot block liveness or cause recurring writes. |
