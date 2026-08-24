# Plan: Browser and Desktop Capability Convergence

> **Status**: Executing
> **Created**: 20260824-1445
> **Slug**: browser-desktop-capability-convergence
> **Planning Source**: forge-plan
> **Orchestration Kind**: direct-controller
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md`
> **Task Review**: `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`
> **Implementation Notes**: `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`

## Agentic Routing
- Selected route: /direct
- Routing reason: Captured from forge-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260824-1445-browser-desktop-capability-convergence.md`
- Sprint contract: `tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md`
- Sprint review: `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`
- Implementation notes: `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260824-1445-browser-desktop-capability-convergence.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260824-1445-browser-desktop-capability-convergence.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md`
- Review file: `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`
- Implementation notes file: `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session continuation: `.ai/harness/session/continuation.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260824-1445-browser-desktop-capability-convergence.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md`, `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`, and `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Impact review**: after direct checks, reassess user intent, affected domains, downstream consumers, state transitions, and residual risks
- **Stop condition**: all task breakdown items are complete and sprint verification reports direct checks plus declared scope passing
- **Rollback surface**: before execution remove `plans/plan-20260824-1445-browser-desktop-capability-convergence.md`; after execution revert branch `codex/browser-desktop-capability-convergence` or the generated task artifacts

## Captured Planning Output

## Objective

Make Forge browser automation reliably reuse the user's live authenticated browser without foreground theft or session loss, while preserving Desktop Operator as the independently buildable macOS execution broker rather than merging Browser and Desktop into one lifecycle owner.

## Architecture decisions

1. `browser` remains the only public browser semantic plugin and owns browser profile/tab/session policy.
2. `desktop_operator` remains a controller-scoped external provider. Its internal browser RPC exposes bounded macOS primitives only and never becomes a second browser session authority.
3. Browser session state moves from repo-local JSON mutation to one Controller Home SQLite namespace. Existing `.forge/browser/sessions/*.json` files are import-only legacy inputs; after import, SQLite is the only writer.
4. Native browser sessions are globally reconcilable by stable `{provider, browserProduct, windowId, tabId}` identity, while repository references remain recorded for bounded listing and audit. Managed Playwright profiles remain repository-owned resources and are not silently reused across repositories.
5. `attach_preferred` fails closed by default. A visible managed browser/profile fallback occurs only after explicit configuration.
6. Desktop semantic sessions remain provider-owned but become durable metadata that is reconciled to a live application identity after provider restart. AX refs and screenshot evidence never survive restart.
7. Provider handshake explicitly declares internal browser protocol/actions. Forge validates the required action before execution; version equality alone is insufficient.
8. The legacy ChatGPT browser profile binding is a compatibility input for browser configuration. ChatGPT consultation transcripts remain separate domain artifacts, not browser-tab sessions.
9. LaunchAgent startup uses a minimal environment and does not inherit Controller/API credentials.

## Scope

### Forge repository

- `src/runtime/plugins/browser-adapter.ts`
- a focused Browser session authority module under `src/runtime/plugins/`
- `src/runtime/plugins/macos-capability-broker.ts`
- `src/runtime/plugins/types.ts` / plugin store only if required to expose Controller Home during manifest construction
- focused Browser, external-provider, and broker tests
- Browser/Desktop architecture documentation and tracked task artifacts

### Desktop Operator repository

- `Sources/DesktopOperatorCore/SessionStore.swift`
- `Sources/DesktopOperatorCore/PluginRuntime.swift`
- `Sources/DesktopOperatorCore/Manifest.swift`
- `Sources/DesktopOperatorCore/PluginPaths.swift`
- `scripts/install.sh`
- focused Swift tests and protocol/architecture documentation

## Non-goals

- Do not merge the Desktop Operator executable into Forge Runtime.
- Do not make Desktop Operator a public browser semantic API.
- Do not add a second readiness authority, watchdog, daemon, or profile store.
- Do not migrate ChatGPT consultation transcripts into Browser interaction sessions.
- Do not publish a formal release; source build/install is sufficient for acceptance.

## Acceptance criteria

1. A source-installed Desktop Operator declares and supports `list_tabs`; Forge rejects a broker lacking that declared action before attempting it.
2. Restarting Desktop Operator preserves a reusable desktop interaction ID when the same application identity is still live, while AX/screenshot evidence is reset.
3. Native Browser adoption deduplicates repeated records for the same live tab and can reuse it from another repository through the Controller authority.
4. Existing repo-local Browser session JSON is imported once and never rewritten after the SQLite authority exists.
5. Browser session listing is bounded and paginated; default output cannot grow without limit.
6. `attach_preferred` never launches a visible managed profile unless `managed_persistent` fallback was explicitly configured.
7. Source installation starts Desktop Operator without API-key-bearing environment variables.
8. Focused Forge tests, Swift tests, real source-installed Browser/Desktop probes, and the repository required checks pass.

## Verification

- `bun test` for added Browser/broker/external adapter tests.
- `swift test` in `repo-harness-desktop-operator`.
- Source install with `bash scripts/install.sh`, followed by handshake, health, `list_tabs`, restart/rebind, and Forge Browser session reconciliation probes.
- `bun run check:task`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-architecture-sync.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
- affected `bun run test` receipt and final `/review`-style inspection.

## Task Breakdown

- [ ] Add Desktop Operator durable/reconciled session metadata, broker capability declaration, and environment-isolated source installation.
- [ ] Add Controller Home SQLite Browser session authority with legacy import, native identity deduplication, repository references, tombstones, and bounded listing.
- [ ] Make Browser attach fail closed by default and validate Desktop Operator browser actions through the handshake.
- [ ] Adapt legacy ChatGPT browser profile binding without merging consultation artifacts into Browser sessions.
- [ ] Update architecture/protocol documentation and tracked Forge task state.
- [ ] Run focused tests, source install, real Browser/Desktop verification, required checks, and final review.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Add Desktop Operator durable/reconciled session metadata, broker capability declaration, and environment-isolated source installation.
- [ ] Add Controller Home SQLite Browser session authority with legacy import, native identity deduplication, repository references, tombstones, and bounded listing.
- [ ] Make Browser attach fail closed by default and validate Desktop Operator browser actions through the handshake.
- [ ] Adapt legacy ChatGPT browser profile binding without merging consultation artifacts into Browser sessions.
- [ ] Update architecture/protocol documentation and tracked Forge task state.
- [ ] Run focused tests, source install, real Browser/Desktop verification, required checks, and final review.
