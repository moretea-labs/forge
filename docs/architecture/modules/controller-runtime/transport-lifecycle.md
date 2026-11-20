# MCP HTTP Transport Lifecycle

> Capability: `mcp-http-transport-lifecycle`
> Runtime Authority: [Current Architecture](../../CURRENT.md)

## Responsibility

`adapters/mcp/transports/` owns HTTP authentication handoff and protocol-era serving. MCP 2026-07-28 is the canonical public boundary and is served per request without protocol-level sessions. The session registry, global admission capacity, transport leases, and DELETE cleanup exist only for the explicit 2025-era compatibility path. The transport does not own durable Work/Process/ControllerRound authority or Gateway process recovery.

## Invariants

- Modern `server/discover` and subsequent 2026-07-28 requests are handled by the SDK v2 per-request handler and do not require or emit `Mcp-Session-Id`.
- Durable Work, Process, and ControllerRound identity is independent from both modern request bindings and legacy transport sessions.
- A newly created Work may receive an opaque Work-bound controller capability for Runtime recovery and replay fencing. That capability is internal to normal model-facing Work execution: the Runtime/Supervisor establishes, rotates, and recovers it. Legacy owner records without a capability digest may use the explicit `controller_claim` compatibility upgrade; ordinary model-facing Work operations never require it.
- Legacy 2025-era traffic is classified mechanically by the SDK and routed to one bounded stateful compatibility registry shared by all public MCP HTTP routes.
- On the legacy path, route and authenticated principal must match the stored session on GET, POST, and DELETE; active POST work is protected from capacity eviction.
- Legacy stream-only sessions are reclaimable through client DELETE, explicit prior-session replacement, lease expiry, absolute lifetime, or oldest-safe capacity eviction.
- Legacy initialize admission is an atomic registry reservation. Shared static-bearer clients use the global pool; per-principal fairness applies only where authentication provides a meaningful distinct principal.
- Legacy capacity readiness distinguishes `immediate`, `eviction`, and `blocked` admission. Capacity eviction releases registry routing/ownership synchronously before old transport cleanup; peer cleanup is best-effort and must never hold the serialized initialize admission lane after the old session is fenced out.
- Health session metrics describe only legacy compatibility state; modern request serving has no long-lived session capacity authority.
- Closing or replacing transport state never implies that a durably accepted Work or Process is cancelled.
- The Gateway-to-Canonical-Runtime client classifies structured SDK HTTP 404 as an expired inner session, reconnects once, and replays only an operation already proven replay-safe by its idempotency contract.
- The public Gateway may burst-scale a bounded shared pool of inner Canonical Runtime MCP lanes. A released lane remains hot only for a bounded idle lease; reuse cancels retirement, while expiry explicitly terminates the Streamable HTTP session before closing the local client so the Runtime does not retain an orphaned Server/transport graph. Durable Work, Process, and Controller authority is never coupled to that transport retention window.

## Gateway shutdown

SIGTERM/SIGINT fences new MCP arrivals before transport teardown. The existing
response-owned POST registry drains admitted observations for at most 30 seconds,
then reports `MCP_GATEWAY_SHUTDOWN_OUTCOME_UNKNOWN` (or closes an already streaming
response). A final error flush is bounded to one second for detached Bun responses.
This ends observation only: callers must reconcile the original request/Process
identity, never replay an unknown non-idempotent operation. Legacy sessions, modern
handlers and shared proxy lanes close after POST drain; stream-only GET channels
close with their transport. Release cutover's marker-based admission fence remains
separate and does not cover arbitrary signals or forced process termination.

Canonical Runtime teardown retains the listener's actual sockets until admitted
requests and sessions drain, then destroys those sockets explicitly. Bun's
`http.Server.close()` clears its internal listener reference, so invoking
`closeAllConnections()` afterwards alone cannot retire pooled connections. A
retired socket must never initialize a Session against the previous Runtime
while subsequent calls route to its same-endpoint replacement. Normal live
connection reuse remains enabled; reconnect does not replay unknown mutations.

Proxy timing in the existing `mcp-timings.jsonl` ledger separates
`gatewayProxyHandoffWaitMs` (release handoff and old-lane retirement) from
`gatewayProxyLaneWaitMs` (bounded scheduler admission), connection establishment,
canonical call, and return tail. These local spans cannot establish caller-to-
Tunnel/Gateway ingress waiting without matching upstream per-request evidence.

An admitted POST's observation deadline or generic transport exception cannot
prove execution failure or authorize replay. Existing error codes/statuses are
retained, but these responses carry `retryable: false`, `action: reconcile` and
`executionOutcome: unknown`. Explicit pre-admission overload/drain refusal remains
retryable. Neither response processing nor session replacement changes the
original durable request identity.

The macOS Connector LaunchAgent explicitly reserves 45 seconds between SIGTERM
and forced termination, covering the Gateway's 30-second admitted-response drain
and one-second final observation-error flush before transport cleanup. This is
service stop grace, not a longer request/execution timeout. Source rendering does
not update an installed LaunchAgent or authorize a Runtime release/restart.

The HTTP acceptance fixture replaces a real Gateway child at the same endpoint
while the original Runtime-owned Process remains running. Both graceful shutdown
after a submission receipt and forced disconnect before that receipt are covered.
The latter injects a caller observation deadline, then recovers by the original
request key through a fresh Gateway; running and terminal Process identities must
match and the external-effect marker must contain exactly one execution. This
isolated fixture does not certify a public Tunnel or installed Runtime release.

Runtime context semantic queries retain fresh before/after Git source fences,
but await the existing bounded child-process executor for their Git status samples.
The synchronous inspector API remains for synchronous consumers; both paths share
one porcelain-v2/content-fingerprint parser. A slow repository fsmonitor must not
freeze unrelated Runtime observations while a semantic source fence is sampled.
This mitigates a reproduced local blocking path, not a proven attribution of a
historical production latency spike.

Gateway timing records retain `gatewayProxyCanonicalTraceId` from the Runtime's
existing response metadata. Join that opaque UUID to a `canonical_runtime`
record's `traceId` in the same audit ledger, keeping both spans' own IDs intact.
This avoids timestamp/tool-name guessing for callers without an explicit durable
request key. The link remains diagnostic and never grants retry/idempotency
or execution authority; malformed arbitrary metadata is not copied into it.

## Verification

```text
bun test tests/unit/fix-mcp-session-lifecycle.test.ts tests/cli/mcp-http.test.ts
```

## MCP Runtime adapter decomposition boundary

The public MCP Tool Contract is frozen independently from implementation placement. `check:mcp-compatibility` records both the stable tool-name fingerprint and the canonical schema fingerprint, so moving a handler between adapters cannot silently change the connector ABI.

`runtime-tools.ts` and `router.ts` are currently migration debt, not architecture authorities. Runtime Architecture keeps shrinking inventories for their direct imports into Kernel/Context/Control Plane/Execution/Recovery/Plugin/Workflow/Repository domains and for the `callRuntimeTool` switch cases. A stage may remove an inventory entry only when ownership moves behind the correct domain adapter/application API; adding a new entry fails the architecture gate. This deliberately avoids source-line-count rules while making mega-adapter regrowth mechanically impossible.

## Tool dispatch ownership (2026-11-11)

Repository and Process tool execution has one protocol-neutral authority below every transport: `src/runtime/control-plane/facade/repository-tool-dispatch.ts` (`callRepositoryTool`) and `src/runtime/execution/process-runtime/tool-dispatch.ts` (`callProcessTool`). Both return the SDK-independent `ToolDispatchResult` defined in `src/runtime/shared/tool-dispatch-result.ts`; the MCP response type remains at the transport boundary. The MCP tool-mapping surface keeps only schema definitions and depends one-way on those dispatchers; the desktop native Agent local harness (`apps/desktop/src-tauri/resources/forge-local-tool.mjs`) imports the same dispatchers directly and must never import from `adapters/mcp` or `packages/protocols/mcp` (enforced by `check:runtime-architecture`). Tool file-access policy (`getToolPolicy`/`ToolPolicy`) has one owner in the Runtime Control Plane at `src/runtime/control-plane/tool-policy.ts`; CLI, MCP and desktop transports depend on that shared policy.

Native Agent Process attachment accepts both durable `proc_*` and repository-scoped `lightweight:*` handles returned by the canonical Process Runtime. Lightweight repository handles retain their exact checkout in the existing Process handle-index target; the local adapter verifies repository/checkout placement before `callProcessTool`, which enforces the recorded principal. Missing or foreign handle identity fails closed. A running or interrupted command is reconciled by its original handle, never silently executed again; terminal status is determined only from the canonical Process receipt, not filesystem side effects.

The native Rust Agent recognizes `lightweight:<UUID>` running receipts as joinable, emits their original Process ID, and waits through the same `process_status` path as `proc_*`. An interrupted or unsuccessful observation pauses with that identity; it does not send the accepted command back for execution or infer a terminal result.

Native Agent live Process output is a display projection capped at 2,000 characters. Oversized `run_command`, `process_status`, and `process_cancel` receipts retain their Process identity and terminal diagnostics while stdout/stderr prefixes shrink before serialization, accounting for JSON escaping. The output remains valid JSON with `outputTruncated: true`; this projection neither changes the canonical receipt nor determines execution success or replay permission. Model-context result bounding remains separate.

Native Agent streaming rejects explicit provider truncation before dispatching any tool from that round: Chat Completions `finish_reason=length/content_filter` and Anthropic `message_delta.stop_reason=max_tokens/model_context_window_exceeded` return `FORGE_DESKTOP_API_STREAM_INCOMPLETE`, even if arguments parse as complete JSON. Transport end markers cannot promote those previews into successful answers or executable requests. Previously completed effect identity remains attached to the existing turn error; no automatic provider retry or command replay is introduced.

SafePatch retains the explicit caller Controller Home through repository tool dispatch and Console entrypoints. The patch owner resolves that home before binding edit-session storage, so storage placement and edit execution use the same authority. The fast executor already passes that same context; ambient defaults are used only when the caller omitted an explicit home.

Native Agent Process observation is evidence, not a retry: when a nonterminal `process_status` response reports `observationInterrupted`, the current turn pauses and preserves the Process ID for explicit recovery. A returned terminal receipt still wins over an interrupted observation. Cancellation is considered successful only for a completed `succeeded`, `failed`, `timed_out`, or `cancelled` terminal status; `unknown`, `completed_unknown`, `orphaned`, missing, and future statuses remain unresolved.

Native Agent terminal Process projection preserves the canonical `cancelled` flag. Explicit cancellation evidence prevents `run_command` success even when status/exit-code fields look successful, for both immediate receipts and subsequent managed/lightweight Process observations. Cancellation settlement remains distinct from command success; this projection never authorizes replay.
