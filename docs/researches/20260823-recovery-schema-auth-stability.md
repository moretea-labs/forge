# Recovery / schema / auth stability review — 2026-08-23

## Incident class

A live Forge OAuth MCP session can initialize successfully and then immediately fail continuation with `MCP_TOOL_SURFACE_CHANGED` when the Canonical Runtime's executable tool surface changes while the Runtime remains alive but the fingerprint persisted in Runtime `status.json` has not been republished.

This is distinct from an initialize-time overload/500 failure. It is a schema-authority split:

- initialization obtains Canonical Runtime schema live;
- subsequent public Gateway session fencing historically preferred the published Runtime status fingerprint;
- a stale status projection can therefore contradict the same Runtime's live schema and reset a brand-new session.

Restarting the Runtime repairs the projection because startup republishes the fingerprint, but restart is compensation, not the desired convergence mechanism.

## Architectural conclusion

`runtime/status.json` is a read-only observation projection. Canonical Runtime `tools/list` is executable schema truth. A projection disagreement must not be sufficient evidence to reject a session without a live confirmation.

The repair uses two layers:

1. Canonical Runtime republishes its status fingerprint when a schema-observing request detects live tool-surface change.
2. Public Gateway should live-confirm any published/session disagreement before returning a tool-surface reset.

Longer term, the plugin/tool registry should emit one typed in-process tool-surface-change signal to the Canonical Runtime so status convergence is immediate and does not require polling or a second watcher authority.

## Recovery conclusion

The existing Standalone Recovery family already provides the correct independent boundary: immutable Recovery release, dedicated Gateway + Watchdog, dedicated public tunnel, OAuth/PKCE MCP connector, and bounded whole-Runtime lifecycle operations. The correct reliability work is to make this connector a required independently verified recovery entry point rather than adding another Runtime/supervisor.

See `plans/plan-20260823-recovery-stable-control-plane.md` for the execution and failure-injection contract.
