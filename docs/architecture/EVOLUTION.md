# Forge Architecture Evolution

Status: **Historical Design — Not Runtime Authority**

Append-only summary of why the architecture changed. The current contract is always [`CURRENT.md`](CURRENT.md); detailed superseded implementations remain available through Git history instead of parallel maintained architecture documents.

## 2026-08-18 — Quality-first executable harness

- Reframed Forge as an executable harness for the semantic controller rather than a lifecycle-heavy coding control plane.
- Made repository context progressive and repeatable; exact known paths receive reserved budget and source materialization prefers complete symbols/small files.
- Kept CodeGraph as discovery evidence while current raw source remains authoritative.
- Added an internal zero-dependency TypeScript Language Service navigation prototype and benchmarked real Forge refactors; compiler references found useful caller structure while exact lexical search still found unrelated same-name/registration paths.
- Moved ordinary shell wrappers and inline interpreters onto Lightweight/direct execution when high-level effect classification permits it.
- Removed dirty workspace, protected path and review intent as automatic Work triggers; Work remains for continuity/orchestration/external-effect needs.
- Retired hundreds of lines of unreachable Local Bridge execution/submission code instead of relocating it.
- Detached the default 19-tool Controller schema from the historical legacy tool-definition set; `toolset=full` remains explicit compatibility only.
- Simplified test governance: affected tests for development, core regression for main candidates, full regression for release candidates; removed arbitrary global test-line/resource-count budgets.
- Consolidated current architecture documentation into a single `CURRENT.md`, a single roadmap, this evolution log and per-version snapshots.

## 2026-08 — Canonical Runtime and thin public surface

- Converged Runtime activation on immutable whole releases with standalone recovery and exact release identity.
- Reduced the normal ChatGPT Connector surface to a bounded 19-tool schema and separated public Gateway concerns from Canonical Runtime execution.
- Moved ordinary repository actions toward direct/lightweight paths while retaining durable paths for explicit lifecycle requirements.

## Earlier Controller generations

Earlier V4–V8 Controller, Local Bridge, Supervisor, Issue/Task/Job and recovery designs are retained in Git history and accepted ADRs where still useful. They are not maintained as parallel current architecture authorities.
