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

## 2026-08-26 — Documentation lifecycle governance

- Folded the still-current Controller facade/Handoff, host-hook ownership, and iOS physical-device provider invariants into `CURRENT.md` from current source rather than preserving old implementation plans as parallel authority.
- Retired root-level phase/status design pages into the history archive; accepted ADRs and version snapshots remain rationale/snapshots while `CURRENT.md` remains the sole current architecture contract.
- Added deterministic task-gate protection so new root-level parallel architecture pages and stale current-status/personal-machine identity markers fail existing static architecture verification instead of relying on a daemon or manual cleanup pass.

## 2026-08-27 — Browser Runtime V3 becomes current authority

- Promoted the Browser provider/resource transaction model from V2 migration rationale to the current V3 runtime contract while retaining one public Browser action surface.
- Kept controller-home BrowserSession state as the only durable browser-session authority and made exact native `windowId` + `tabId` identity authoritative across warm-handle invalidation and cold rebind.
- Made provider-wide native tab inventory optional for compatibility with the stable Desktop Operator broker: absence of inventory may reduce cross-tab reuse, but must never permit guessing or adopting an unrelated user tab.
- Kept foreground/physical input explicit. Browser background actions never silently activate a tab; Desktop Operator foreground/physical actions remain a separate verified capability boundary.
- Added current-source live acceptance coverage for Chrome/Vivaldi native lifecycle, background foreground-preservation, URL drift/rebind, replacement postconditions, internal resources, cleanup, and attributable latency reporting. Environment-owned browser permission gaps remain typed external blockers rather than reasons to weaken the runtime contract.
