# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-08-30
> **Scope**: Goals intentionally deferred outside the active Forge Cloud Windows source-optimization handoff

The active post-1.7.1 source checklist is tracked in `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`.
Do not duplicate that execution checklist here.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Complete historical macOS Automation/TCC cleanup and macOS-only browser live acceptance | Forge source optimization is moving to Forge Cloud Windows. Selector-bound System Settings cleanup, Accessibility/Screen Recording/Automation grants, and Chrome Apple Events behavior require the macOS host and sometimes user-presence confirmation. | Historical macOS principals or unresolved live-browser proof can remain visible even after platform-neutral source fixes; this must not be misreported as Windows-verifiable closure. | Revisit only on the macOS host when exact TCC/browser evidence is required; preserve the signed `Forge Desktop Operator` authority and do not grant equivalent powers to Runtime. |
| Recover/export data from the historical logged-out ChatGPT browser profile | This is account/history recovery rather than Forge product-source correctness and the saved old profile is logged out. | Historical data may remain unavailable, but it does not block Forge source development or release correctness. | Revisit only when the user explicitly asks to recover that account/history and can provide required authentication. |
