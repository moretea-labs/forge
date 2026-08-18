# Forge Roadmap

This is the single maintained roadmap for Forge. It records only current priorities and near-term direction; completed design history belongs in [`architecture/EVOLUTION.md`](architecture/EVOLUTION.md), and release history belongs in [`../CHANGELOG.md`](../CHANGELOG.md).

## Now — simplify and verify

- Keep the default ChatGPT surface at the stable 19-tool contract.
- Keep ordinary local coding on Ephemeral/Lightweight execution; reserve durable Work/Process state for continuity, scheduling, release, and external effects.
- Finish test-governance cleanup: development uses affected tests, main candidates use core regression, release candidates use full regression.
- Keep architecture documentation canonical and small; remove parallel current-authority documents.
- Use the internal TypeScript Language Service prototype to validate compiler-backed navigation on real refactors before exposing any new public API.

## Next — improve implementation accuracy without a new control plane

- If the TypeScript navigation benchmark continues to find material missed references, integrate `definition/references/implementations` into `rh_context` as a thin optional navigation operation.
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
