# Forge Code Search — Post-Release Acceptance Ledger (2026-10-15)

Status: **PARTIAL — not a known-good or release acceptance.** This record describes observed evidence, not a deployment decision.

## Identities and scope

- Mac source checkout: `/Users/greyson/DevProjects/forge`, source HEAD at this measurement: `765804d762544a87e3d750287a423fad64d86ddb`.
- Active immutable Runtime remains `1792022338979-696cc9d5f3aea62e550309206b73f7357c545d70`, authority revision 868, using source `696cc9d5f`. **Unreleased** source commits: `5a0f8d839` (model-selected lexical hints), `9a7e26f63` (retire obsolete editor rule), `765804d76` (exported-definition ranking and snippet fairness).
- Preserve four pre-existing dirty files outside code search. No Runtime cutover, restart, promotion, external delivery, or CodeGraph process termination was performed.
- Existing independent acceptance task: `supervisor:9089c98263b23e1bd329813b`. Enrollment remains blocked by unattributed `composer_not_empty` draft; do not treat the bootstrap URL as a delivered independent conversation.

## Repository retrieval correctness: real deployed MCP vs direct rg

Real `search_repository` MCP on currently deployed Runtime, with `max_results=500,max_files=20000`, compared with direct `rg -l -i --fixed-strings --no-ignore --hidden` using the same default exclusion globs:

| Query | MCP distinct files | Direct rg files | Truncated | Conclusion |
| --- | ---: | ---: | --- | --- |
| `runProcess` | 28 | 28 | false | File-set equality; MCP trace `c71e6967-1069-4f8f-b998-8a22a64c6634` |
| `rollbackPrevious` | 5 | 5 | false | File-set equality; MCP trace `c0031532-d2b4-47d2-a559-d5d005d572b0` |
| `ReleaseSession` (whole repo) | 20 | 25 | true, `max_results` | Expected incomplete bounded response; MCP trace `c72f4662-aba0-416a-bc48-ebed69822982` |
| `ReleaseSession` `src/**` | 11 | 11 | false | Exact matching subset |
| `ReleaseSession` `tests/runtime/**` | 5 | 5 | false | Exact matching subset |
| `ReleaseSession` `docs/**,scripts/**` | 9 | 9 | false | Exact matching subset |

The three explicit scopes recover 25/25 paths, without claiming that a single bounded whole-repo search is complete. These checks concern **matching file paths**, not every returned line or all authorized filesystem states. The broad MCP count alone must not be used as full coverage.

## Latency attribution: current deployed Runtime

### Direct local authenticated HTTP MCP (unchanged active Runtime)

Used existing `scripts/benchmark-mcp-transport.ts` via `http://127.0.0.1:8765/mcp`, `--local-service-auth`, one steady-state MCP session, 3 warmups, 20 measured calls per tool. No secret values were written to artifacts or command line.

| Tool | Local MCP p50 / p95 | Server p50 / p95 | Local transport residual p50 / p95 |
| --- | ---: | ---: | ---: |
| `rh_status` | 20.62 / 23.25 ms | 17.01 / 20.84 ms | 2.98 / 5.02 ms |
| `rh_context`, exact known source path | 199.78 / 215.20 ms | 196.25 / 207.57 ms | 3.40 / 4.14 ms |

Reproduction examples (read-only, using the local Runtime's existing auth):
```sh
bun scripts/benchmark-mcp-transport.ts --endpoint http://127.0.0.1:8765/mcp --local-service-auth --tool rh_status --iterations 20 --warmup 3 --repo-id repo_123b7cf58b6b17b5cbe46a56
bun scripts/benchmark-mcp-transport.ts --endpoint http://127.0.0.1:8765/mcp --local-service-auth --tool rh_context --iterations 20 --warmup 3 --repo-id repo_123b7cf58b6b17b5cbe46a56 --arguments '{"operation":"search","query":"runProcess","known_paths":["src/effects/process-runner.ts"],"max_files":3,"max_snippets":4,"structural_context":"off","include_learning_recall":false}'
```

### ChatGPT-connected tool invocation (separate path; not controlled A/B)

Six sequential `rh_status` calls: observed invocation p50/p95 **1526/2270 ms**, Forge server p50/p95 **52.47/81.25 ms**.

Six sequential `rh_context` known-path calls: observed invocation p50/p95 **2144/4338 ms**, Forge server p50/p95 **235.03/497.95 ms**.

Earlier 3 samples per query gave: symbol invocation **2044–3367 ms**, known path **1395–3095 ms**, original Chinese rollback **2211–2562 ms**. The Chinese query did not find the rollback core on this older Runtime.

**Inference and limit:** Direct authenticated local HTTP MCP has only a few milliseconds of transport residual; the substantial extra delay appears somewhere on the ChatGPT-to-tool calling path outside that local HTTP baseline. It has **not** been subdivided into host, tunnel, platform scheduling, or client-rendering contributions. These are separate workloads, loads, and observation windows; do not infer a specific network provider or claim a controlled causal improvement. Avoid rewriting ripgrep to solve latency not observed in local ripgrep/MCP execution.

## Current source candidate correctness (NOT deployed)

With code revision `765804d76` and 20 alternating local source invocations per version for `runProcess`, default `max_files=4,max_snippets=8`:
- Before: canonical `src/effects/process-runner.ts:151` returned **0/20**, local p50/p95 **236.48/273.14 ms**.
- After: canonical owner returned **20/20**, ranked first **20/20**, local p50/p95 **238.42/406.28 ms**.
- Both versions reported bounded truncation **20/20**. Ranking quality improved; performance improvement is **unproven**. Focused checks on candidate: 49 pass/0 fail, type/architecture/repository/governance checks passed.
- `search_terms` with model-provided `rollbackPrevious,cutover,recovery` locates `src/runtime/standalone-recovery/core.ts` in isolated source verification, but no new Runtime / live MCP certification has occurred.

## LSP coordinate verification

Live `rh_context` raw semantic-navigation call for `runProcess` references returned `totalLocations=135`, `returnedLocations=135`, `truncated=false`, `policyDeniedLocations=0`, but every location element was replaced by `[bounded-depth]` in the client-visible projection (trace `af7515e0-0fe7-43ee-8f09-b2cbf54e7700`).

Independent local TypeScript Language Service inspection at `src/effects/process-runner.ts:151:19` returned **135 references in 26 files**. Each of 135 positions was checked against its current source file: **zero missing files, zero invalid line/column starts, zero out-of-repository paths**; 126 reference sites start with `runProcess`, nine use imported aliases. Direct local Language Service runtime was approximately 1608 ms for a cold query. This validates coordinates for the current source revision, not all possible dynamic call edges or complete MCP serialization fidelity.

## Outstanding acceptance gates

1. Repeat correctness, snippet fairness, complete scope behavior, and multilingual hints against the **future authorized deployed release**, preserving immutable source/release identity; independent new-conversation acceptance.
2. Full LSP result coordinate inspection, fail-closed policy/readable-scope edges, changed-file behavior, and resource variability (not just success-count proxies).
3. Live autonomous continuation proof and ReleaseSession `known_good` remain blocked; never bypass the unattributed composer draft or mark a `soaking` release known-good.
4. The other four dirty checkout modifications remain separately owned. Some pre-existing WorkKind tests fail even on `696cc9d5f`; do not repair them as part of code search without a direct dependency.

**Current decision:** Preserve ripgrep + explicit LSP as the single Forge search architecture. A bounded default context result is useful for implementation but is not complete evidence; use explicit scopes/limits to prove completeness. Optimize ChatGPT call overhead only with evidence of its real owner. Runtime switch requires new user authorization.
