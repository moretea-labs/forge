# 2026-08-23 Recovery-stable control plane notes

## Incident evidence

A live primary MCP failure at approximately 20:40 +08:00 reproduced a schema-fence split that differs from prior initialize/500 failures:

- public OAuth `initialize` succeeded against the live Canonical Runtime schema;
- `notifications/initialized` immediately returned 404 `MCP_TOOL_SURFACE_CHANGED`;
- the session fingerprint represented live schema while the Runtime `status.json` fingerprint was stale after runtime plugin/tool code changed in another session;
- restarting the Canonical Runtime republished status and restored the connector, proving restart repaired the projection but not the underlying convergence design;
- real OAuth end-to-end verification after restart passed initialize -> initialized -> tools/call.

The local self-host checkout also contains an operational-documentation commit reported as `4b4dbf45`. This GitHub repair branch is based on published `main`, so rollout/cutover must reconcile that local commit and unrelated dirty work instead of assuming GitHub branch state is the complete local checkout.

## Decisions

1. Canonical Runtime live `tools/list` is schema authority; Runtime `status.json` remains a read-only projection.
2. The first defense is Runtime-side status convergence on live schema observation. The public Gateway must additionally live-confirm any published/session disagreement before returning a schema-change reset.
3. Standalone Recovery is the sole independent lifecycle recovery owner. Do not add a second Runtime, supervisor or alternate rollout path.
4. Recovery Connector acceptance is the existing `forge recovery verify-connector` contract: dedicated Recovery release/Gateway/Watchdog/tunnel plus public OAuth PKCE and MCP initialize/list/read-only calls.
5. OAuth credentials are control-plane state and use crash-safe atomic persistence; corrupt state cannot silently become an empty credential database.
6. Startup recovery must surface failed Managed Process reconciliation and reconstruct repository projections even if a dirty marker was lost.
7. Package release readiness is not proof of a safe self-host baseline; operational baseline acceptance remains a separate planned gate.

## Implemented on `fix/recovery-schema-auth-stability`

- OAuth temp/fsync/rename persistence, explicit corrupt-primary handling and fallback repair.
- Atomic access/refresh token-pair issuance/rotation and correct direct refresh-token revocation.
- Authorization-code TTL, client binding, one-time use and bounded pending-code capacity.
- Canonical Runtime live tool-surface observation hook and status fingerprint republish.
- Startup recovery `processes` phase with visible errors/degraded state.
- Unconditional repository projection rebuild on Runtime startup recovery.
- Focused tests for OAuth persistence/revocation/code bounds and Runtime fingerprint republish.
- Execution plan: `plans/plan-20260823-recovery-stable-control-plane.md`.

## Not yet claimed complete

- Public Gateway live-confirm-on-fingerprint-disagreement (#108 second defense).
- Stable user-level Controller Home migration / removal of cwd-dependent authority split (#129).
- Recovery consumption of stalled-session `recoveryRecommended` (#130).
- Per-Work stale ownership reconciliation (#134).
- Complete active/request-id durable indexes for large history (#133/#140).
- Secure Tunnel alias+tunnel+target identity binding (#136).
- Operational `check:stable-baseline` receipt (#141).
- Live installation/activation and independent Recovery Connector registration/verification on the user's machine.

Source commits are not deployment evidence. These items close only after focused CI plus installed failure-injection acceptance through Standalone Recovery.
