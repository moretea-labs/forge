# Agentic Development Flow

Forge owns the workflow contract. External host skills may improve reasoning quality, but they are never required for correctness or lifecycle progress.

## Primary Modes

| Work type | Forge route | Optional enhancement |
|---|---|---|
| Understood bounded edit | `/direct` | none required |
| Plan-only or architecture decision | `/plan` | gstack `plan-eng-review` / `plan-design-review`, Waza `/think` |
| Bug, regression, failing test, tooling failure | `/debug` | Waza `/hunt` |
| Diff, acceptance, pre-merge review | `/review` | Waza `/check`, peer `codex-review` / `claude-review` |
| Release readiness and publication | `/release` | provider-specific release tooling |
| Concurrency, load, performance, scale verification | `/scale` | benchmark-specific tooling |
| Product discovery | `/plan` | gstack `office-hours` |

Missing external skills must degrade only the named enhancement. Hooks may suggest Forge modes, but must not route correctness through a third-party skill.

## Architecture Migration Delivery Transaction

### Current-Task Lineage Fence

Every controller round has one semantic task lineage. Resolve it from the user's current objective and the exact Work/Requirement/Plan relation before consulting repository-wide status. Global active Work is conflict metadata, not a work queue.

The controller may inspect unrelated active Work only to answer four bounded questions: does it own an overlapping write path, does it hold an authority/resource needed by the current lineage, does it create a merge/release admission blocker, or does it prove the current lineage was superseded by an explicit typed transition? If none apply, the unrelated Work is ignored for the rest of the round.

Never pivot into another Work's implementation, verification, review, release, cleanup, or progress accounting without explicit user intent or an explicit typed lineage transition. This prevents autonomous continuation from turning repository activity into accidental scope expansion.

For Kernel/V2 migrations and similarly cross-cutting work, the primary unit of execution is a coherent delivery slice, not an issue, file, failing check, or incidental symptom.

1. **Batch discovery**: gather the relevant architecture, ownership, runtime, persistence, and evidence facts in one bounded pass.
2. **Root-cause decision**: identify the owning invariant/module and decide whether new observations are same-root scope or an independent delivery boundary.
3. **Freeze the slice**: establish one candidate scope and acceptance contract. Same-root discoveries extend this candidate; they do not create sibling Works by default.
4. **Coherent implementation**: implement the whole slice before broad validation. Use edit-session/savepoint state rather than per-file Git commits.
5. **Whole-candidate review**: review authority, dependency, migration, lifecycle, recovery, and diff coherence once the implementation is source-complete.
6. **Validation wave**: run focused behavior checks first, then canonical gates once. After repair, rerun only affected checks unless evidence invalidates the architecture.
7. **Delivery boundary**: commit/merge once for the coherent candidate, then perform Candidate/canary/release once. Release must not begin while same-delivery source-changing Works remain active.
8. **Terminal cleanup**: retire superseded Work/Plan/check/release state so the Controller's active inventory represents only real remaining work.

Do not turn concrete incidents into an issue-by-issue patch campaign. Cluster symptoms by architecture owner and invariant before implementation. One-file commits are acceptable only when that file is itself the complete coherent delivery; file count is not the boundary.

If execution exposes a defect in Forge lifecycle machinery, decide whether it is required for the current version to converge safely. If not, record a bounded post-version Plan with the violated invariant, evidence, intended owner, and acceptance criteria, then continue the current release without implementing that machinery refactor.

## Public CLI Boundary

The user-facing CLI is intentionally smaller than the implementation surface:

- install/configure: `forge install`, `forge update`, `forge setup`, `forge uninstall`;
- repository/runtime: `forge adopt`, `forge repo`, `forge runtime`, `forge recovery`;
- integrations: `forge plugin`, `forge chatgpt`, `forge mcp`, `forge tools`;
- diagnostics/docs: `forge status`, `forge doctor`, `forge security`, `forge docs`.

Host-dispatch and compatibility machinery such as `hook`, `run`, legacy `controller`, migration helpers, brain sync, and capability-context internals may remain callable for managed workflows but are not normal top-level product entrypoints.

## Due Diligence

P1/P2/P3 remains the shared reasoning protocol:

- `P1_GLOBAL_ARCHITECTURE`: identify real boundaries, entrypoints, owners, authoritative state, dependencies, and out-of-scope areas.
- `P2_DATA_FLOW_TRACE`: walk one concrete request/event/job/config/data path to the final output.
- `P3_DESIGN_DECISION`: state the invariant, why the current shape exists, and why the proposed change is the smallest coherent one.

For small work keep this internal. For architecture, debugging, risky refactors, deployment, auth/payment/data, or shared contracts, persist the relevant evidence.

## Daily Flow

1. Read the current user request and current Canonical Runtime state first.
2. Use `/direct`, `/plan`, `/debug`, `/review`, `/release`, or `/scale` according to intent.
3. Use `rh_context`; request CodeGraph structural context when callers, dependencies, or impact matter.
4. If a decision-complete plan is useful, capture it into `plans/` as a durable business/engineering artifact. It is not a second Runtime lifecycle authority.
5. Execute bounded work through Forge repository/Process/Work primitives and collect verification evidence.
6. Use `/review` plus focused checks before closeout. Optional peer or Waza reviews may add evidence but may not become the only pass condition.
7. `.ai/harness/session/continuation.md` and `.ai/harness/session/resume.md` are ignored, rebuildable host-session caches only. They never override SQLite/Runtime state, Git source, current user input, or recorded evidence.
8. A decision that actually requires ChatGPT/user judgement is a Runtime `HandoffItem` surfaced through `rh_inbox`; do not encode it as a session-cache file.

## Boundaries

- Do not create a new workflow entity because an old RepoHarness skill once had a command for it.
- Do not auto-install Waza, gstack, gbrain, or other unrelated third-party skills during ordinary execution.
- Do not treat session continuation files, `tasks/current.md`, or generated projections as mutable lifecycle authorities.
- Do not make an Agent process, browser session, hook, or external skill the owner of long-running work. Forge owns durable state; external models provide reasoning and implementation work.
- Keep compatibility readers isolated and read-only. New writes target the current Forge authority only.
