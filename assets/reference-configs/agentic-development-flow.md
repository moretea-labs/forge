# Agentic Development Flow

Forge owns the workflow contract. External host skills may improve reasoning quality, but they are never required for correctness or lifecycle progress.

**Current default:** GitHub Issue/Project progress + Direct Edit / terminal first. Work lifecycle and ControllerRound are retired. Requirement/Plan are optional semantic context and never gate ordinary edits or commits.

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

## Default Light Path (ordinary source work)

For understood small fixes and bounded slices, use the shortest valid path:

1. **Read once**: current Issue latest decision (body + newest comments) and the exact 1–2 source/test files needed.
2. **Edit directly**: IDE Direct Edit or one `capability_execute` call targeting `repository.direct_edit`. Do not open multi-step EditSession begin/apply/finalize rituals for ordinary work.
3. **Validate narrowly**: focused tests for the changed contract; omit broad suites until delivery or high-risk boundaries.
4. **Deliver once**: one coherent commit on the repository's source policy (Forge uses protected `main`), then one Issue progress note with SHA, check evidence, and remaining gaps.
5. **Stop**: do not chain `rh_status` → plan_list → context/list → Writer/dirty preflights unless the next mutation depends on them or a real failure points there.

Forbidden by default for small fixes: creating Work/ControllerRound, Requirement/Plan progress prose as a second ledger, cognition settlement on every tool call, and repository-wide status inventory as a work queue.

## Architecture Migration Delivery Transaction

For Kernel/V2 migrations and similarly cross-cutting work, the primary unit of execution is a coherent delivery slice, not an issue, file, failing check, or incidental symptom.

Resolve the current objective from the user's intent and the live GitHub Issue (optional Requirement/Plan only when already present or explicitly requested). Do not invent a Work lineage. Unrelated repository activity is conflict/ownership evidence only—inspect it solely for overlapping write paths, needed authority/resources, merge/release blockers, or an explicit superseding decision.

1. **Batch discovery**: gather the relevant architecture, ownership, runtime, persistence, and evidence facts in one bounded pass.
2. **Root-cause decision**: identify the owning invariant/module and decide whether new observations are same-root scope or an independent delivery boundary.
3. **Freeze the slice**: establish one candidate scope and acceptance contract on the Issue. Same-root discoveries extend this candidate; they do not create sibling lifecycle records by default.
4. **Coherent implementation**: implement the whole slice before broad validation. Prefer Direct Edit or one bounded safe-patch batch; keep intermediate Git commits out of the inner loop.
5. **Whole-candidate review**: review authority, dependency, migration, lifecycle, recovery, and diff coherence once the implementation is source-complete.
6. **Validation wave**: run focused behavior checks first, then canonical gates once. After repair, rerun only affected checks unless evidence invalidates the architecture.
7. **Delivery boundary**: commit/merge once for the coherent candidate, then perform Candidate/canary/release once. Release must not begin while same-delivery source-changing work remains active.
8. **Close the loop on the Issue**: record evidence and remaining work on the existing GitHub Issue. Optional Requirement revise is at most one short post-delivery semantic snapshot, never mid-slice progress theater.

Do not turn concrete incidents into an issue-by-issue patch campaign. Cluster symptoms by architecture owner and invariant before implementation. One-file commits are acceptable only when that file is itself the complete coherent delivery; file count is not the boundary.

If execution exposes a defect in Forge lifecycle machinery, decide whether it is required for the current version to converge safely. If not, record a bounded follow-up on the Issue (optional Plan only when explicitly useful) with the violated invariant, evidence, intended owner, and acceptance criteria, then continue the current release without implementing that machinery refactor.

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

1. Read the current user request and current Issue decision first; use Canonical Runtime state only when the next operation depends on it.
2. Use `/direct`, `/plan`, `/debug`, `/review`, `/release`, or `/scale` according to intent. Prefer `/direct` for understood bounded edits.
3. Reuse the current conversation working set. Read necessary Issue/optional Requirement/Plan decisions and source once, then fetch only changed or missing evidence. New conversations recover minimal current durable facts. Use exact reads for known files; use bounded rh_context discovery or explicit semantic_navigation only for new dependencies or insufficient context. Verify relevant HEAD, dirty paths, Writer/leases, permissions and effect outcomes live before the operation that depends on them—not as a mandatory preflight stack.
4. If a decision-complete plan is useful, capture it into `plans/` as a durable business/engineering artifact. It is not a second Runtime lifecycle authority.
5. Execute bounded work through Direct Edit / repository / Process primitives and collect verification evidence. Do not create Work for ordinary delivery.
6. Use `/review` plus focused checks before closeout. Optional peer or Waza reviews may add evidence but may not become the only pass condition.
7. `.ai/harness/session/continuation.md` and `.ai/harness/session/resume.md` are ignored, rebuildable host-session caches only. They never override SQLite/Runtime state, Git source, current user input, or recorded evidence.
8. A decision that actually requires ChatGPT/user judgement is a Runtime `HandoffItem` surfaced through `rh_inbox`; do not encode it as a session-cache file.

## Boundaries

- Do not create a new workflow entity because an old RepoHarness skill once had a command for it.
- Do not auto-install Waza, gstack, gbrain, or other unrelated third-party skills during ordinary execution.
- Do not treat session continuation files, `tasks/current.md`, or generated projections as mutable lifecycle authorities.
- Do not make an Agent process, browser session, hook, or external skill the owner of long-running work. Forge owns durable state; external models provide reasoning and implementation work.
- Keep compatibility readers isolated and read-only. New writes target the current Forge authority only.
- Do not revive Work, ControllerRound, Supervisor auto-continue, or multi-step EditSession rituals as the default coding loop.
