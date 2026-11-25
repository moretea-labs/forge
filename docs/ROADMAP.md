# Forge Roadmap

This is the single maintained roadmap for Forge. It records only current priorities and near-term direction; completed design history belongs in [`architecture/EVOLUTION.md`](architecture/EVOLUTION.md), and release history belongs in [`../CHANGELOG.md`](../CHANGELOG.md).

## Now — converge the GPT execution harness

- **P0: extend proven automatic round progression into long-horizon scheduled autonomy.** V2 release certification has already proven bounded A → B → C `continue_immediately` progression without user `继续`, including same-principal transport/session recovery and duplicate-handoff suppression. The remaining post-V2 target is Persistent Autonomous Continuation across repeated Work-bound Schedule wakes: the same durable Work and ChatGPT conversation must survive multi-hour/multi-day unattended operation, settle each round explicitly, clean only Forge-owned ephemeral automation tabs, and re-arm after transient provider/runtime outages without user restatement. Dispatch/claim/disposition/finalize/tab-cleanup/next-eligibility must remain independently observable.
- Preserve the one-brain contract: the external GPT controller owns requirement interpretation, repository understanding, implementation decisions, semantic review, and whether to keep exploring. Forge stays deterministic and must not acquire a coding/semantic agent or a Codex/Claude/Grok dependency.
- Keep the default ChatGPT surface at the stable 19-tool contract. Improve information gained per call behind the existing facades instead of fragmenting the public MCP surface.
- **Agent-first source discovery**: the model searches current source directly with `execute_command` (`rg`, `find`, `sed`, `git`) and reads exact files with `read_repository_file`. `rh_context` is not a source-search or Context Pack service; keep it for repository status, capability discovery, optional Cognitive recall, and explicit LSP navigation.
- Optimize semantic checkpoints rather than individual operations. Forge may combine coherent multi-file patch transactions, selected validation, and deterministic failure-context collection, but source discovery itself remains model-directed Shell/Read work; every new semantic branch returns to GPT.
- Treat coherent implementation-slice controller↔Forge round trips as a first-class performance measure. Initial targets are <=3 turns for simple edits and <=6 for ordinary feature slices when no genuine semantic surprise occurs.
- Keep ordinary local coding on Ephemeral/Lightweight execution; reserve durable Work/Process state for continuity, scheduling, release, independent delivery, recovery, and external effects.
- Return revision-bound structured evidence for compile/test/runtime/provider outcomes so GPT does not need extra mechanical fetches just to locate a failure. Visual Browser/iOS/device evidence should be consumable by ChatGPT Vision rather than exposed only as opaque local paths.
- Use ChatGPT-native Web/Vision and suitable one-shot connectors as controller perception when they are the shorter path; keep Forge authoritative for repository/local-device/local-authenticated-browser, durable, scheduled, and effectful execution. ChatGPT sandbox is specialized compute only, never repository source/build authority.
- Finish the active repair/release portfolio before opening avoidable parallel work. The Roadmap owns current priority direction; durable Plan/Work state owns live execution and blockers. Persistent workflows are intentional; stale/duplicate repair Work and pending semantic handoffs are not.
- Keep current Browser compatibility stable while Browser implementation evolution proceeds only under the dedicated Browser Runtime V3 Plan: unified transaction/provider routing and background-native convergence are delivered; physical/visual evidence and then measured live-gate/retirement closure remain under that single Plan authority.

## Next — prove higher implementation throughput without a new control plane

- Benchmark end-to-end Agent-native Shell/Read discovery and coherent implementation slices. Keep compiler/LSP navigation lazy and explicit; do not warm or precompute symbol/context indexes for ordinary work.
- Enrich existing edit/check facades with structured diagnostics and bounded deterministic failure-site context; never infer or apply a semantic repair inside Forge.
- Establish direct visual-evidence transport for at least one real Browser or iOS/device path and let GPT perform the visual judgement.
- Use direct Shell lexical search (`rg`/`git grep`) as the normal discovery mechanism for dynamic registrations, manifests, capability IDs, persisted aliases, and same-name implementations.
- Retire additional legacy implementation paths only when current callers are proven to delegate to current authority or no longer exist.
- Decompose remaining God files only along real responsibility/authority boundaries; do not split by line count alone.

## Later — compatibility retirement

- Version and retire the explicit `toolset=full` compatibility surface after consumers have migrated to the stable surface.
- Continue reducing legacy Work/Task/Job projections as their compatibility obligations expire.
- Promote stable external providers through the Forge Plugin Protocol and keep product/release boundaries independent.

## Not planned

- No Change Closure database, Authority Registry lifecycle, certificate store, new daemon, SCIP/Glean/Kythe stack, or other repository-wide completeness control plane.
- No requirement that every code change create Work or Plan state.
- No growth of scenario tests merely to preserve historical implementation shapes.
