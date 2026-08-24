# Recovery-Stable Control Plane Plan

> Status: Approved / executing
> Date: 2026-08-23
> Scope: Canonical Runtime, public OAuth Gateway, Standalone Recovery, Secure Tunnel, durable startup recovery, self-host stable-baseline acceptance
> Primary incidents: MCP session loss / unrecoverable controller path; 2026-08-23 live-vs-published tool-surface fingerprint drift

## Objective

Forge must remain recoverable when its primary MCP connection, public Gateway session, Canonical Runtime, tool surface, OAuth store, public tunnel, or repository runtime projection fails independently. A primary failure must not remove the only path able to inspect and recover that failure.

This plan closes the current reliability issues without adding a second Runtime authority, a blue/green Runtime, another supervisor, or a repository-specific recovery owner.

## Architecture invariants

1. **One Runtime authority.** There is one Canonical Forge Runtime for one Controller Home. Gateway, MCP transport, Controller and Scheduler remain modules of that complete Runtime release.
2. **Live schema is authoritative.** The Canonical Runtime `tools/list` result is the executable MCP schema truth. `status.json` is a read-only projection and must never reject a session when it disagrees with verified live Runtime schema.
3. **Published schema converges.** Whenever the live Runtime observes a changed tool surface, its status projection is republished. Plugin/tool mutation should eventually emit a typed in-process schema-change event so publication does not depend only on the next discovery request.
4. **Session fences fail recoverably.** A published/live fingerprint disagreement is verified against the live Canonical Runtime before `MCP_TOOL_SURFACE_CHANGED` is returned. A stale client may be reset only when live truth proves its session schema is stale.
5. **Recovery is independent.** Standalone Recovery has its own immutable release, Gateway, Watchdog, launchd ownership, OAuth/MCP endpoint and dedicated tunnel. It cannot depend on the primary Runtime transport or primary MCP session namespace to remain callable.
6. **Recovery is not a second Runtime.** Recovery may inspect release/status/health authority and perform bounded whole-Runtime lifecycle operations. It does not execute repository work, become a scheduler, or mutate source as a fallback.
7. **Stable Controller Home.** User-level Forge defaults to `~/.forge/controller` (or `XDG_STATE_HOME/forge/controller`). Repo-local `_ops/controller-home` compatibility must not silently become a different user-level authority based on cwd.
8. **Durable work outlives transport.** Accepted Work/Process identity, leases, receipts and idempotency survive MCP session loss, Gateway restart and whole-Runtime replacement.
9. **Auth state is crash-safe.** OAuth clients/access/refresh state commits atomically and corruption is explicit/fail-closed or repaired from verified fallback; corruption is never interpreted as an intentionally empty store.
10. **No arbitrary history window may weaken correctness.** UI/history listing may be bounded; active membership and request-id idempotency require their own complete durable authority.
11. **Recovery evidence is explicit.** Every automatic restart/rollback has a bounded reason, release identity, observation evidence, cooldown and retry budget.
12. **Stable baseline is executable.** Package release readiness and self-host operational stability are separate gates. Autonomous work may declare a baseline only after the operational gate passes.

## Recovery Connector target

Forge already contains the required independent Recovery architecture; this plan standardizes it instead of creating another path.

### Required service family

- Canonical Runtime: primary whole-runtime launchd service.
- Primary OAuth/Connector: explicitly configured service managed/restartable by Standalone Recovery when required.
- Forge Recovery Gateway: immutable Recovery release, loopback gateway (default port 8787).
- Forge Recovery Watchdog: independent launchd service on the same Recovery release.
- Dedicated Recovery tunnel: separate launchd service with `RunAtLoad=true` and unconditional `KeepAlive=true`.

### Required public Recovery connector

`forge recovery connector --controller-home <canonical-home>` must report:

- `name = Forge Recovery`;
- streamable HTTP endpoint at the configured `recoveryPublicUrl`;
- HTTPS public endpoint;
- current immutable Recovery release identity;
- Gateway + Watchdog current-release PIDs alive;
- dedicated tunnel installed, restart-safe and alive;
- OAuth passphrase configured;
- `readyForChatGPT=true`.

`forge recovery verify-connector --controller-home <canonical-home>` is the authoritative end-to-end acceptance. It must pass public health, OAuth metadata, protected-resource metadata, unauthenticated Bearer challenge, dynamic registration/PKCE token exchange, MCP `initialize`, `notifications/initialized`, `tools/list`, `runtime_status`, and `list_releases`.

This connector is the recovery entry point when the primary Forge MCP namespace/session is unavailable.

## Failure matrix

| Failure | Primary behavior | Recovery behavior | Required proof |
| --- | --- | --- | --- |
| Public MCP session expires | reinitialize without duplicating durable work | remains independently callable | same request/work identity resolves after reconnect |
| Published tool fingerprint stale | verify/serve live schema and republish projection | no restart required | initialize -> initialized -> tools/call succeeds while Runtime stays up |
| Live tool surface actually changes | list_changed / hot refresh or recoverable reset | observe only | same-session tools/list converges; new sessions never self-reset from stale status |
| Active POST session capacity stalls | `/ready` reports bounded recovery evidence | Watchdog consumes `recoveryRecommended` and applies existing restart budget | durable accepted work remains queryable after restart |
| Canonical Runtime dies | primary unavailable | Recovery restarts complete Runtime release and verifies it | recovery connector stayed reachable throughout |
| OAuth primary state is corrupt | primary auth fails closed with diagnostic | Recovery remains reachable; operator can repair/restart without losing previous valid auth | no silent empty token store |
| Primary Secure Tunnel stale/misbound | primary public connector unavailable | dedicated Recovery tunnel remains available | Recovery E2E probe succeeds independently |
| Recovery tunnel/service dead | primary can remain healthy | stable-baseline gate fails; explicit repair required | no false `readyForChatGPT` |
| Repository projection stale with lost dirty marker | startup rebuilds/validates from durable truth | no lifecycle intervention unless Runtime readiness fails | restart produces current projection |
| One process-recovery phase fails | repo/runtime reports explicit degraded evidence; later safe phases continue | restart budget is not confused with successful recovery | phase-specific error visible |

## Execution phases

### Phase 0 — stop unrecoverable connection failures

- [x] #137: atomic/fail-closed OAuth persistence first implementation on `fix/recovery-schema-auth-stability`.
- [x] #138: direct refresh-token revocation + atomic token-pair rotation first implementation.
- [x] #108 incident defense 1: Canonical Runtime re-observes the live tool surface on `initialize`/`tools/list` and republishes `status.json` when the fingerprint changes.
- [ ] #108 incident defense 2: public Gateway must live-confirm a published/session fingerprint disagreement before returning `MCP_TOOL_SURFACE_CHANGED`.
- [ ] Add plugin/tool registry in-process `tool_surface_changed` event; Runtime republishes immediately without introducing another watcher authority.
- [ ] #129: remove cwd-driven user-level Controller Home authority split; preserve repo-local layout only as explicit compatibility/migration state.
- [x] Establish and verify the dedicated Recovery connector on the canonical user Controller Home.

### Phase 1 — make Recovery capable of closing failures

- [x] #130: consume `/ready.sessionCapacity.recoveryRecommended` in Standalone Recovery under the existing release-scoped restart budget/cooldown.
- [ ] #131: startup projection reconstruction is unconditional or equivalently validated before readiness, even when dirty marker is lost.
- [ ] #132: Managed Process recovery becomes an explicit per-repository phase; errors are recorded and mark recovery degraded instead of being swallowed.
- [ ] #134: stale Work reconciliation correlates ownership to the candidate Work instead of repository-wide activity.

### Phase 2 — preserve idempotency under long history

- [x] #133: replace arbitrary ExecutionJob first-5000 recovery with complete active/request-id authority or paginated durable reconciliation.
- [x] #140: closed as obsolete after Local Bridge launch request creation was retired; no second durable binding authority is introduced.
- [ ] Prove all mutation admission paths reject conflicting reuse of one request ID.

### Phase 3 — harden public connectivity

- [x] #136: Secure Tunnel readiness binds alias + tunnel ID + current local MCP target; missing identity becomes unknown/not-ready, never false ready.
- [ ] Primary and Recovery public paths expose distinct health/identity evidence.
- [ ] Restart primary connector/tunnel while Recovery connector stays usable.

### Phase 4 — baseline and governance

- [x] #141: add `check:stable-baseline` separate from package `check:release`.
- [x] #135: enforce/label `tasks/current.md` `stale_after`; expired current status cannot silently enter agent context as current truth.
- [ ] #139: authorization-code TTL, one-time use, global/per-client bounds and bounded cleanup.

## Required failure-injection acceptance

The stabilization work is not complete until these tests pass against an installed immutable Runtime/Recovery pair:

1. **Live plugin schema drift without Runtime restart**
   - initialize session on schema A;
   - mutate plugin/tool registry to schema B while Runtime remains alive;
   - new OAuth session: `initialize=200`, `notifications/initialized=202`, `tools/list=200`, real `tools/call=200`;
   - no request is rejected only because `status.json` was stale;
   - status publication converges to schema B.
2. **Existing-session hot refresh**
   - receive `notifications/tools/list_changed`;
   - same session lists schema B and can call B;
   - client skipping re-list gets a bounded recoverable reset only when live schema proves it stale.
3. **Crash during OAuth persistence**
   - inject failure before rename;
   - restart; prior valid OAuth snapshot remains usable;
   - truncated primary with valid fallback repairs; without fallback produces `MCP_OAUTH_STORE_CORRUPT`.
4. **Primary MCP completely unavailable**
   - terminate public Gateway/primary Runtime session namespace;
   - `Forge Recovery` connector remains discoverable and callable;
   - invoke read-only Recovery status, then bounded whole-Runtime restart/recover;
   - verify primary OAuth initialize/list/call after recovery.
5. **MCP protected POST stall**
   - fill capacity with active POSTs below threshold: no restart;
   - cross stall threshold: Recovery records exact capacity evidence and performs at most the configured bounded restart;
   - accepted durable Work/Process survives.
6. **Projection dirty marker loss**
   - mutate durable authority without dirty marker;
   - restart; published projection matches durable truth before ready.
7. **Process recovery error isolation**
   - fail repository A process recovery;
   - A records `phase=processes` degraded evidence; later safe phases run; repository B recovers normally.
8. **Cross-Work ownership**
   - healthy Work A remains running while unrelated stale Work B converges; A's lease cannot protect B repository-wide.
9. **Large history idempotency**
   - >5000 ExecutionJobs and >500 Local Bridge jobs;
   - original active/request-id entities outside presentation windows still resolve exactly.
10. **Primary tunnel misbinding**
    - correct process but wrong tunnel ID or old local target is not ready;
    - Recovery tunnel remains reachable.
11. **Recovery failure**
    - stop Recovery Gateway/tunnel;
    - primary may remain available, but operational stable-baseline gate fails explicitly.

## Operational Stable Baseline receipt

`check:stable-baseline` must emit one immutable receipt including:

- canonical Controller Home identity;
- active Runtime release ID, manifest digest and tool-surface fingerprint;
- installed Recovery release revision/manifest digest;
- primary and Recovery connector endpoint identities (no secrets);
- Recovery `verify` + `verify-connector` results;
- zero actionable stale Work/handoff debt (protected unknown-owned legacy debt reported separately);
- crash/restart durability smoke evidence;
- primary OAuth MCP end-to-end probe;
- source revision/dirty-state evidence used to produce the immutable release.

Changing Controller Home, active Runtime release, Recovery release, endpoint identity or required gate definition invalidates the receipt.

## Cutover / rollout rule

1. Land focused source changes and tests on an isolated branch.
2. Reconcile with the local self-host checkout, which may contain unpublished operational commits; never overwrite unrelated local work.
3. Run affected tests + `check:main`.
4. Stage a new immutable Runtime release.
5. Activate only through Standalone Recovery; no self-restart fallback from the running Runtime.
6. Run `forge recovery verify` and `forge recovery verify-connector`.
7. Run the live schema-drift and primary-loss failure injections.
8. Run `check:stable-baseline`; only a passing receipt may be declared the next autonomous-development baseline.

## Closure rule

An issue is not closed merely because source code exists or a restart temporarily restores service. Closure requires the relevant failure injection and, for connection/recovery issues, a real OAuth MCP end-to-end verification on the installed release.
