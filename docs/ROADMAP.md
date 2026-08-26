# Forge Roadmap

This is the single maintained roadmap for Forge. It records only current priorities and near-term direction; completed design history belongs in [`architecture/EVOLUTION.md`](architecture/EVOLUTION.md), and release history belongs in [`../CHANGELOG.md`](../CHANGELOG.md).

## Now — converge the GPT execution harness

- Preserve the one-brain contract: the external GPT controller owns requirement interpretation, repository understanding, implementation decisions, semantic review, and whether to keep exploring. Forge stays deterministic and must not acquire a coding/semantic agent or a Codex/Claude/Grok dependency.
- Keep the default ChatGPT surface at the stable 19-tool contract. Improve information gained per call behind the existing facades instead of fragmenting the public MCP surface.
- Make `rh_context` a reliable high-density first-call fan-in: current raw source remains authoritative; lexical, compiler-semantic, structural, and guidance evidence are combined mechanically; source identity and bounded coverage gaps stay explicit; GPT alone decides whether context is sufficient.
- Optimize semantic checkpoints rather than individual operations. Forge may combine deterministic search/read fan-in, coherent multi-file patch transactions, selected validation, and deterministic failure-context collection, but every new semantic branch returns to GPT.
- Treat coherent implementation-slice controller↔Forge round trips as a first-class performance measure. Initial targets are <=3 turns for simple edits and <=6 for ordinary feature slices when no genuine semantic surprise occurs.
- Keep ordinary local coding on Ephemeral/Lightweight execution; reserve durable Work/Process state for continuity, scheduling, release, independent delivery, recovery, and external effects.
- Return revision-bound structured evidence for compile/test/runtime/provider outcomes so GPT does not need extra mechanical fetches just to locate a failure. Visual Browser/iOS/device evidence should be consumable by ChatGPT Vision rather than exposed only as opaque local paths.
- Use ChatGPT-native Web/Vision and suitable one-shot connectors as controller perception when they are the shorter path; keep Forge authoritative for repository/local-device/local-authenticated-browser, durable, scheduled, and effectful execution. ChatGPT sandbox is specialized compute only, never repository source/build authority.
- Finish the active repair/release portfolio before opening avoidable parallel work. Persistent workflows are intentional; stale/duplicate repair Work and pending semantic handoffs are not.
- Continue Browser Runtime V2 under its dedicated Plan authority: single controller-home session authority, capability-based routing, warm provider reuse, explicit foreground effects, postcondition verification, and measured p50/p95 live gates.

## Next — prove higher implementation throughput without a new control plane

- Stabilize Context Plane transport and warm semantic-navigation/session caches, then benchmark real refactors and feature implementation rather than isolated API latency only.
- Enrich existing edit/check facades with structured diagnostics and bounded deterministic failure-site context; never infer or apply a semantic repair inside Forge.
- Establish direct visual-evidence transport for at least one real Browser or iOS/device path and let GPT perform the visual judgement.
- Keep exact lexical search as the escape hatch for capability IDs, manifests, dynamic registration, and historical aliases.
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
