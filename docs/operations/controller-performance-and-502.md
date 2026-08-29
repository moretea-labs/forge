# Controller Performance and 502 Troubleshooting

This guide covers slow MCP calls, repeated reconnects, proxy `502` responses and Local Controller UI stalls.

## What a 502 Means

A `502` is normally emitted by the HTTPS tunnel or reverse proxy when it cannot obtain a valid response from the local MCP process. It is not proof that an accepted durable Job failed. Check the Job or Run record before retrying a write operation.

## Runtime Protections

The MCP HTTP runtime now uses:

- one shared Controller context across sessions;
- one global pool of at most 64 retained MCP sessions across all three HTTP paths;
- 15-minute idle expiry, a 30-minute SSE lease and a two-hour absolute session lifetime;
- DELETE cleanup and same-client reconnect supersession;
- oldest-safe stream-only eviction under capacity pressure, while active POST work remains protected;
- at most 8 simultaneous session initializations;
- at most 4 active POST requests per session and 32 globally;
- `429`/`503` overload responses with `Retry-After`;
- a 1 MB MCP request-body limit;
- 65-second keep-alive and 70-second header timeout;
- periodic transport cleanup during runtime and full cleanup on shutdown;
- one in-process Gateway/MCP transport owned by the canonical Forge Runtime, with no Stable Ingress child or component lifecycle supervisor.

These limits prevent reconnect storms and long-running clients from causing unbounded memory, file scanning or open-transport growth.

## Health Check

Call `GET /health` on the local MCP endpoint. The response includes:

- tool-surface identity and schema version;
- active and maximum session counts;
- initializing, active POST and active SSE stream counts;
- available capacity, utilization, evictable/protected counts and oldest stream/POST ages;
- close-reason counters for DELETE, supersession, lease/lifetime expiry and capacity eviction;
- overload rejection count;
- authentication configuration status.

A growing `rejectedOverload` value with no matching capacity-eviction or close activity means clients are submitting protected work faster than the Controller can accept it. A pool full of stream-only sessions should now self-recover. Retrying with backoff is preferable to increasing every limit.

## Runtime Activation Failure Looks Like a 502 (2026-08-23 incident)

When a new Runtime release activation fails, the public MCP path can return
HTTP `500` on `initialize`, which the tunnel surfaces as a `502`-style
connection failure. The chain observed on 2026-08-23:

1. A Runtime release activation started a new `mcp serve` process while the
   launchd gateway already owned `127.0.0.1:8767`. The new process failed to
   bind (`Failed to start server. Is port 8767 in use?`) but did **not exit**;
   it kept running as an orphan (`PPID 1`) spinning at ~98% CPU.
2. The canonical Runtime (port 8765) failed to start for the new release
   (`RUNTIME_RELEASE_AUTHORITY_MISMATCH` in
   `runtime/service/logs/stderr.log`), so the gateway could not complete MCP
   `initialize` and returned HTTP 500.
3. `tunnel-client` posted the upstream error to the control plane
   (`dispatcher received MCP upstream error`, `upstream_status=500`,
   `rpc_method=initialize`), which the remote client saw as a failed
   connection / 502.

Diagnostic fingerprint:

- `gateway.stderr.log` contains `Failed to start server. Is port 8767 in use?`
- `runtime/service/logs/stderr.log` contains repeated
  `RUNTIME_RELEASE_AUTHORITY_MISMATCH`
- recovery watchdog log shows `restart_primary_runtime` attempts followed by
  `action":"rollback"` restoring the previous release
- a stray `bun ... mcp serve` process with `PPID 1` and high `%CPU`

Remediation:

- The standalone Recovery watchdog automatically rolls back after the bounded
  restart budget is exhausted; wait for `action":"healthy"` in
  `recovery/audit/watchdog.log` before doing anything else.
- Kill the orphaned `mcp serve` child of the failed release (verify it holds no
  listening sockets first); it only burns CPU after a failed port bind.
- Verify the canonical Runtime answers `initialize` on its own port and that
  the tunnel log shows no new `upstream_status=500` entries.

Known code defect to fix: `mcp serve` should exit with a non-zero status when
the requested port is already in use instead of staying alive in a hot loop.

## Connector/Activation Recovery Gaps Behind Intermittent 502 (2026-08-27)

A second class of intermittent `502` was traced to release/Connector coherence rather
than to a permanently dead Recovery service.

Observed evidence:

- a live Forge MCP request returned `502` while independent Recovery observed the
  Canonical Runtime briefly as `RUNTIME_NOT_RUNNING`; the Runtime became ready again
  a few seconds later after release authority reverted to the prior package release;
- separate MCP connection failures also occurred while independent Recovery still
  observed the Canonical Runtime as ready, proving that not every `502` is a whole-
  Runtime failure;
- the persistent package Connector health probe accepted any received HTTP status,
  so `500`/`502` could be classified as healthy and the broken service reused;
- detached macOS package activation scheduled the Runtime switch and then rebound the
  Connector to the candidate release before the activation helper committed the
  Runtime service. If helper activation failed, Runtime authority/service rolled back
  while Connector authority/plist could remain on the candidate generation;
- standalone Recovery's Connector action previously restarted the already-installed
  launchd service. A stale/mutable launch spec therefore remained stale after restart.

Corrected invariants:

1. Connector reuse accepts only the expected MCP/OAuth endpoint semantics (`200` or
   the unauthenticated `401` Bearer challenge); `5xx` is always unhealthy.
2. Detached activation does not switch the Connector in the installer. The activation
   helper installs the Runtime service first and only then commits the Connector to the
   same immutable package release. A Runtime activation failure therefore leaves the
   prior Connector generation untouched.
3. Connector-only Recovery first reconciles the canonical package Connector against
   the active immutable Runtime release, then verifies local ownership/public MCP, and
   only then decides whether a launchd/tunnel restart is still required.
4. Whole-Runtime rollback remains deliberately stricter than Connector recovery. A
   known-good Runtime is not rolled back merely because its Connector or external
   tunnel drifted; those hops must be repaired independently.
5. Recovery `runtime_status` reports bounded Watchdog decision evidence (last action,
   reason and restart/failure counters) so incident review can distinguish "Recovery
   never fired" from "Recovery fired and the client observed the bounded outage".

## Recurring Connection Failure Ledger

Keep these failure signatures distinct. A public `502` identifies the failed
hop; it does not identify the failed owner or authorize a whole-Runtime
rollback.

| Signature | Verified evidence | Correct recovery owner |
| --- | --- | --- |
| Runtime activation/port conflict | `RUNTIME_RELEASE_AUTHORITY_MISMATCH`, port `8767` already in use, or orphaned `mcp serve` | Whole-Runtime Recovery transaction; see the 2026-08-23 incident above. |
| Connector/release binding drift | Runtime `ready=true`, but Connector loopback/public MCP fails or returns `5xx` | Connector Recovery reconciles the active immutable release, then verifies local ownership and the public endpoint. |
| Connector launched with a Recovery-role binary | Connector plist starts `forge-recovery-gateway` or `forge-recovery-watchdog`; stderr repeats `RECOVERY_*_ROLE_ONLY` | Repair the Connector with the absolute interpreter recorded by Runtime activation. A Connector launch spec must reject a Recovery-role binary. |
| Connector outage misclassified as a Runtime outage | Runtime status and local active Gateway are healthy while the Watchdog records `restart_primary_runtime` for a Connector probe failure | Count and restart the Connector under its own bounded budget; do not consume the Runtime restart/rollback budget. |

The launch interpreter is part of the Connector's immutable release binding:
detached activation passes its recorded absolute `nodeExecutable` to candidate
and rollback Connector installs, and Recovery services retain the same explicit
interpreter for later binding repair. Regression coverage must exercise a
failed Connector while the Canonical Runtime remains healthy.

## Session Continuation Fails With 404 MCP_TOOL_SURFACE_CHANGED (2026-08-23)

Second incident on the same day, different failure mode. After a session is
created, every follow-up (`notifications/initialized`, `tools/call`) returned
HTTP 404 with:

```json
{"error":"session_not_found","code":"MCP_TOOL_SURFACE_CHANGED",
 "message":"MCP Runtime tool surface changed; initialize a new session so tools/list is refreshed.",
 "recoverable":true,"action":"reinitialize",
 "previousFingerprint":"<session>","currentFingerprint":"<published>"}
```

Root cause: the Gateway session fence compares the **live** Runtime schema
fingerprint captured at `initialize` (`readCanonicalRuntimeToolSchema` ->
`proxy.listTools()`) against the **published** fingerprint in
`runtime/status.json`. The Runtime publishes `status.json` once at startup and
does not republish when its live tool surface changes at runtime (e.g. a
plugin registers or code edits change the tool set). Once the two values
diverge, every session continuation is rejected as a tool-surface change, so
the tunnel/connector appears broken even though `/health` shows both
fingerprints matching the published value.

Diagnostic fingerprint:

- Gateway `/health` shows `toolSurfaceFingerprint` equal to
  `runtimeToolSurfaceFingerprint` (both read the published value), but a real
  `initialize` session stores a different fingerprint.
- Follow-up requests get the `MCP_TOOL_SURFACE_CHANGED` 404 with
  `previousFingerprint != currentFingerprint`.

Remediation:

- Restart the canonical Runtime service
  (`launchctl kickstart -k gui/$UID/com.moretea.forge.runtime.<suffix>`) so it
  republishes `status.json` from its current surface, then verify
  `initialize` -> `notifications/initialized` (202) -> `tools/call` (200) with
  a valid OAuth token.
- Known code defect to fix: the Runtime should republish `status.json`
  whenever its live tool surface changes (tool list changed), and/or the
  Gateway fence should prefer the live fingerprint for the current-schema
  comparison instead of trusting a stale publication.

Call `GET /ready` separately. A 503 from `/ready` with `/health` still returning 200 means the Runtime is live but cannot safely admit another initialize. `sessionCapacity.recoveryRecommended=false` preserves active work and waits; `true` is evidence for standalone Recovery's bounded whole-Runtime restart policy after the configured stall limit.

## Diagnostic Order

1. Confirm the local process answers `/health` directly on `127.0.0.1`.
2. Confirm the public tunnel points to the current local port and protocol.
3. Compare tool-surface headers with the expected Controller profile.
4. Inspect active Jobs and Runs instead of repeating a potentially accepted mutation.
5. Check whether a heavy named check or repository command is already running.
6. Compare `sessions.active`, `capacityAvailable`, `evictable`, `protected`, `oldestStreamAgeMs` and close counters. A full stream-only pool without eviction indicates a regression.
7. Restart only after `/ready` recommends bounded recovery or liveness fails, and only after durable state has been inspected; do not delete `.ai/harness` to recover from a connection problem.

## Slow Local UI

The dashboard uses one shared state poller regardless of browser-tab count. Snapshot requests are reused for a short window, and historical Agent Jobs/Edit Sessions are limited before their JSON files are parsed. If the UI remains slow, inspect exceptionally large Issue files or unbounded event logs rather than deleting workflow state.

## Compact Status and Fast-Path Responses

Default MCP tool responses stay compact so clients avoid nested
controller / repository / runtime dumps:

| Surface | Default budget | Detail |
| --- | --- | --- |
| `repository_command_execute` `process_direct` success | &lt; 8 KB | one `stdout`/`stderr` pair; no nested `process` dump |
| `process_direct` failure | &lt; 16 KB | error code, retryable, exitCode, bounded stderr, processId |
| `local_bridge_status` summary | &lt; 16 KB | mode, endpoint, health, job counts; no runtimeStorage/bindings |
| `get_job` summary | &lt; 16 KB | pass `detail_level=full` for full job |
| Artifact ref | &lt; 4 KB | use `get_artifact` for body |
| `rh_status` summary | &lt; 32 KB | pass `detail_level=detail` for expanded |

Pass `detail_level=detail` (or `detail=true`) when full routing, process
metadata, recentJobs, or owner evidence is required.

### Local Bridge endpoint

Do not infer a Local Bridge endpoint from retired slot conventions:

- Root template default Local Controller port is **8766**.
- Forge has no blue/green inactive slot or `+10` alternate Runtime port.
- The authoritative endpoint comes from Controller Home configuration and the current Runtime projection (`localController.endpoint` / `port`), not from hardcoding.

Status model fields:

- `mode`: `standalone` | `embedded` | `disabled` | `remote` | `unknown`
- `processRunning`, `endpointConfigured`, `endpointReachable`
- `expectedSurface`, `requiredForReadiness`

Rules:

- `mode=embedded` does not invent a legacy standalone `8766` probe target.
- `mode=disabled` with `requiredForReadiness=false` does not emit
  misleading `LOCAL_BRIDGE_ENDPOINT_UNAVAILABLE` as a readiness blocker.
- Standalone required endpoints still fail closed when unreachable.
- Historical `recentJobs` failures are operational stats, not current
  active readiness blockers.

### Completion target defaultBranch cache

`resolveCompletionTargetBranch` caches registry `defaultBranch` using:

1. **Registry mtime** — any change to `repositories.json` invalidates
   immediately.
2. **30 second TTL** — when mtime is unchanged, a change that is not
   reflected in the registry file may take up to 30 seconds to become
   visible.

Documented operator expectation:

> registry mtime 变化时立即失效；未检测到 mtime 变化时，defaultBranch 变更最多存在 30 秒可见延迟。

Different repository roots never share a cache entry. When the registry
is unavailable, Git discovery (`origin/HEAD`, `main`/`master`, current
branch) is used.

## Safe Cleanup

Safe source-distribution exclusions:

- `node_modules/`;
- `.git/` when producing a portable source archive;
- `.codegraph/`;
- `.ai/` runtime state in a clean distribution archive;
- `_ops/`, coverage, logs and temporary package files.

Do not remove source, tests, architecture documents, task history or workflow templates merely to reduce archive size.
