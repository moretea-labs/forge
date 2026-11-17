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

Repository SafePatch dispatch preserves the caller-selected Controller Home through edit-storage binding and edit execution. Native Agent and MCP calls use that same home for their EditSession storage and lease checks; an explicit home must not fall back to global state during storage initialization.

Anthropic streaming reassembles `thinking_delta` text and its opaque signature in the original content block for the next tool-result request, as required by the [provider thinking contract](https://platform.claude.com/docs/en/build-with-claude/thinking). This internal round context is passed back unchanged with tool use; it is never emitted as UI text or a reasoning summary. Thinking deltas without a matching thinking block fail closed.

Native Agent stream termination is protocol-specific: `[DONE]` belongs only to Chat Completions. An Anthropic preview terminated by that foreign sentinel fails with `FORGE_DESKTOP_API_STREAM_INCOMPLETE`; it cannot substitute for `message_stop`, dispatch tools, or become a completed answer. Visible text previews remain distinct from a completion receipt.

Chat Completions additionally requires an explicit supported model `finish_reason` (`stop` or `tool_calls`) before `[DONE]`. A transport sentinel alone, a null/missing reason, or an unsupported reason cannot authorize an answer or tool dispatch. Trailing empty-choice usage chunks retain the preceding finish evidence. See the [provider streaming contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events).

Anthropic likewise requires an explicit `message_delta.stop_reason` (`end_turn`, `stop_sequence`, or `tool_use`) before `message_stop` can complete the round. Missing/null reasons and unsupported states, including `pause_turn` and `refusal`, fail closed before tool dispatch or answer completion. A paused server-tool loop is not a completed native Agent turn; no automatic continuation or effect replay is introduced. Text previews remain visible. See the [provider stop-reason contract](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

Responses API tool continuation retains the original ordered `output` items (including reasoning/encrypted context and function-call IDs/status) in the existing assistant history. The next `input` reuses those items once, followed by the matching Forge tool results; normalized dispatch fields must not reconstruct or duplicate them. Requests include `reasoning.encrypted_content` for portable provider context. Existing whole-turn compaction retains or removes these assistant items together with their tool results; opaque context is not UI progress. See the [provider reasoning contract](https://developers.openai.com/api/docs/guides/reasoning).

Native Agent stream terminal receipts freeze their round. Frames or bytes after the protocol terminal cannot add or replace tool calls, emit progress, or turn completion into a late parse/provider error. The HTTP reader returns at the terminal event boundary, so authority does not depend on how the network coalesces SSE frames into chunks.

Native Agent validates tool-call identity across the complete provider round before dispatching any tool. Each OpenAI tool-call ID, Anthropic tool-use ID, or Responses `call_id` must be nonblank and unique within that round; distinct Responses item IDs cannot substitute for unique call IDs. Ambiguous rounds fail with `FORGE_DESKTOP_API_TOOL_CALL_ID_INVALID` and dispatch nothing. This validation introduces no execution cache, retry or replay path.

Native Agent also validates every tool name against the selected access-mode catalog and every argument payload as an object before dispatching any call in the round. A later unavailable tool or malformed argument payload rejects the entire batch with `FORGE_DESKTOP_API_TOOL_NOT_AUTHORIZED`; it cannot leave an earlier command partially executed. This admission check does not make otherwise valid tool batches transactional or replace canonical tool authorization.

Native Agent requires explicit JSON-string `arguments` in completed Chat Completions and Responses function calls. Missing/null or non-string payloads fail with `FORGE_DESKTOP_API_TOOL_ARGUMENTS_INVALID` before batch dispatch; the normalizer must not fabricate `{}` and admit earlier effects. An explicit `"{}"` remains valid for tools with no arguments.

Responses function calls require their explicit string `call_id`; the output item `id` never substitutes for it. Missing/null or non-string call identity rejects the complete round with `FORGE_DESKTOP_API_TOOL_CALL_ID_INVALID` before any dispatch. Continuation retains the original items and pairs tool results with that same `call_id`, as required by the [provider function-calling contract](https://developers.openai.com/api/docs/guides/function-calling).

Anthropic content-block indices identify one block throughout a streamed round. A repeated `content_block_start` at an existing index fails with `FORGE_DESKTOP_API_STREAM_EVENT_INVALID` before dispatch; it cannot overwrite tool identity or attach accumulated arguments to a replacement call. Distinct indices retain their existing ordering and continuation context. See the [provider streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming).

Anthropic `input_json_delta` must target an existing `tool_use` block at the same index. Orphan input and input directed at text/thinking blocks fail with `FORGE_DESKTOP_API_STREAM_EVENT_INVALID` before dispatch; arguments cannot be buffered for retroactive attachment to a later command. Valid tool-input fragments retain their existing reassembly and continuation path.

Native Agent Process attachment stops observing when a nonterminal `process_status` receipt reports `observationInterrupted: true`. It pauses with the original managed or lightweight Process ID rather than silently reattaching, cancelling or re-executing the command. A matching completed terminal receipt still takes precedence over the interruption marker, following the canonical Process continuation contract.

Native Agent `process_cancel` succeeds only with `completed: true` and a known definitive Process status (`succeeded`, `failed`, `timed_out`, or `cancelled`); an already finished command needs no further cancellation. Canonical `unknown`, `completed_unknown`, and `orphaned` statuses, missing/unrecognized statuses, and active statuses require reconciliation even if `completed` or `cancelled` is true. These receipts emit unknown effect progress and stop the Agent before provider continuation; they never authorize cancellation replay.
