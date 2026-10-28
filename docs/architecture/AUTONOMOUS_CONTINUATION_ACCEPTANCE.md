# Forge automatic continuation — acceptance contract

Repository-local guidance for Forge #313, not a new Control Plane or Work authority. The original Supervisor effect ledger owns external sends. Never re-key/replay an outcome-unknown Send.

## Historical baseline, real regression and provenance

- 2026-10-20 real Supervisor task supervisor:5cdb4c333a9be1a3ca0d6c45 completed CONTINUE→CONTINUE→DONE in an actual ChatGPT conversation. Official supervisor_task.proof returned three distinct effects with dispatch-started, applied, assistant-completed, terminal-done and two different Runtime instance IDs. Source: https://github.com/moretea-labs/forge/issues/313#issuecomment-6290568373 . This was an independent canary, not evidence for the current source Writer.
- 2026-10-28 original source Writer supervisor:8003ead2a035a22aefcffe40 successfully applied an initial bootstrap Send, then provider output stream failed. Its exact recovery effect fx_1fa661210e551ad566362f595aa073a2 remained pre-send deliverable. Source: https://github.com/moretea-labs/forge/issues/313#issuecomment-6467791637 .
- The projected PR #494 extension file was current, while actual Chrome's unpacked extension still used an older background.js in the source tree until an exact checkout update and extension Reload. Projected files do not prove the *loaded* worker. Source: https://github.com/moretea-labs/forge/issues/313#issuecomment-6471068427 .
- Computer Browser session inventory and Supervisor Chrome extension broker heartbeat are distinct observations: do not equate liveNativeSessionCount=0 with proof that the Supervisor broker is down.

## Owned source and test seams

| Contract | Code and focused test |
| --- | --- |
| Effect ledger, causal receipt, successors | supervisor/control-plane.ts; supervisor/store.ts; tests/runtime/workflow-supervisor-automation-receipt.test.ts; tests/runtime/workflow-supervisor-duplicate-failure.test.ts |
| Exact pinned browser target, pre-send and dispatch | supervisor/native-browser-adapter.ts; adapters/computer/chatgpt-extension-target.ts; src/runtime/root/workflow-supervisor-runtime.ts; tests/runtime/computer-chatgpt-extension-preflight.test.ts |
| Native heartbeat, claim, complete, timeout | adapters/computer/chrome-extension/background.js; content.js; core.js; supervisor/native-messaging/host.ts; tests/runtime/computer-native-port-recovery.test.ts |
| Installed vs running extension and host | src/runtime/plugins/computer-chatgpt-browser-adapter-installer.ts; tests/runtime/workflow-supervisor-browser-adapter-installer.test.ts; real Chrome loaded-worker inspection |
| Other scheduler/launcher entrypoints | src/runtime/control-plane/global-scheduler/autonomous-continuation.ts; src/runtime/workflow/schedules/work-continuation.ts; adapters/chatgpt/provider-delivery.ts |

## Acceptance-test-driven development (ATDD)

1. Before editing, state observable user goal, prior *actual* success receipt, current failing counterexample, exact source/Release/loaded worker, original effect/task owner, affected paths, side-effect budget and rollback identity. Document behavior that must not change.
2. Reproduce RED. Prefer focused deterministic fault injection for native timeout with no onDisconnect, stale response, simultaneous RPC, postMessage throw, extension reload/source-path mismatch, wrong-tab owner, foreign draft, stream interruption, and unknown Send. Label mocks separately from real results. Do not make a second real external Send to generate RED.
3. Minimal GREEN: verify targeted and pre-existing adjacent tests, especially safety (no wrong-tab or repeated Send) **and** liveness (legitimate pending effects eventually recover); review exact complete diff.
4. Fixed candidate: verify CI, ownership, test manifest and relevant gates; avoid broad refactoring during a narrow repair.
5. Real user-behavior acceptance for an automation fix: verify immutable release, **loaded** Chrome extension path/hash (not just projection), Native Host live heartbeat/claim, original pinned conversation ownership, pre-send prepare, dispatch_started→effect_applied, assistant receipt→next successor, and restart/reconnect behavior including a locked macOS console if claimed. Prove zero duplicated external side effects.
6. An independent real CONTINUE→CONTINUE→DONE canary tests the terminal protocol; original production Writer must independently demonstrate safe forward progress. DONE only for genuinely accepted delivery.

Report separate CODE, INTEGRATION, LOADED WORKER, and LIVE AUTONOMOUS LOOP verdicts: PASS, FAIL, NOT RUN, or BLOCKED, with exact evidence refs and remaining blockers. For documentation-only work a live ChatGPT Send is not needed; for a claim of restored automatic delivery, the real loop cannot be skipped.
