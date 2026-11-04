# Forge AGENTS.md

## Development workflow (2026-11-04; current policy)

This root file is the sole repository-wide instruction authority. This policy replaces legacy Work/WorkHandle/Plan-driven execution instructions in prior versions of this file.

- **GitHub Issues and GitHub Project are the ONLY development progress ledger.** For every task, reuse the existing open Issue, record objective, priority, acceptance checklist, PR/commit/CI/test evidence, blockers and remaining steps there. Keep Issues **OPEN** until the user-authorized acceptance criteria have real, verifiable requirement-to-implementation evidence; close only after verifying those criteria, never automatically on code/PR merge. An independent reviewer is not a prerequisite. Use `Refs #123` in PR/commit text, never auto-close keywords. Do not create a second Issue, Requirement/Plan progress store, local TODO/progress database or parallel task record for the same goal. An explicitly requested optional Work is an execution resource, never a second task/progress ledger.
- **Work is explicit opt-in, never mandatory.** Normal development must not create, recover, or require Work/WorkHandle/Plan/Requirement, even when legacy Work exists. If the user explicitly selects Work, its existing isolated checkout, bounded verification, and resource cleanup may be used with Work-scoped identity and permissions; it must not become GitHub progress authority, own an extra Scheduler/liveness path, or veto ordinary Work-free repository operations. Do not auto-create Work from an Issue or resume historical Work without explicit ownership and effect reconciliation. Forge Process/Git leases and operation receipts remain the execution-safety owners; retired Supervisor Task/Effect history is read-only, never a live continuation owner. GitHub Issue + Project remains the only outcome/progress authority.
- **Direct Edit and terminal first.** Use existing Forge Direct Edit or authorized terminal `rg`, `git`, build/test commands for the shortest code-to-result path. Prefer current checkout; isolate only for real concurrent write/resource conflicts. Do not create orchestration for ordinary edits. Stage/commit precisely owned files and push/review only validated diff. Never overwrite unrelated dirty/untracked content.
- **Repeatable issue queue:** inspect the repository's OPEN Issues and GitHub Project; take the highest priority *actionable* item within the user's current scope; read actual source and latest PR/CI; execute a meaningful change/check/review/integration; update its Issue/Project with evidence, blockers and next action; immediately proceed to the next actionable item. Revisit blocked items only when material evidence or dependency changes. Do not equate a repeated status report/CONTINUE with throughput; do not poll without new evidence.
- **Non-blocking long-running work:** a started CI run, managed Process, build/test, remote merge, provider job, or other long operation is **not** a reason to block the conversation when its result is not yet a dependency. Record its stable identity/receipt, continue other independent actionable work, and join/read it only when its result is required for the next effect, integration decision, or final acceptance—or when no independent work remains. Do not loop on `process_wait`, status reads, sleeps, or equivalent polling. A single bounded join/read is the default; after outcome-unknown external effects, reconcile once with authoritative read-only state before deciding whether a retry is safe.
- **Retired autonomous continuation (#313):** Launch Session is a one-shot, Work-free open/bind operation and never sends a model prompt or `CONTINUE`. Independent Schedule executes one explicitly authorized action per occurrence with its own receipt; legacy `external_controller_wake` / `controller_progression` actions remain disabled and fail closed. Do not restore Supervisor Task/Effect/Turn, watcher-triggered model wake, automatic retry/recover, or a parallel native host. Keep historical audit read-only and never replay unknown/applied external effects. Continue development from GitHub Issue/Project and current Git evidence through an explicitly launched session, without duplicate Writers or mandatory independent Review.
- **Safety contracts persist:** scoped authorization and strong confirmation, Git SHA/CAS/checkout/path/ref leases, secret isolation, exactly-once external writes, non-overlapping source ownership, release/recovery approvals and rollback evidence. Unknown/applied external Sends cannot be blindly resent. A legacy gate that still enforces Work is a defect for #483 to fix, not permission to bypass the real authorization/Git/effect authority through another tool.
- **Mac canonical Forge source:** no competing WSL Writer. Release/source switch, restart, rollback or cutover is separate from code development and is not authorized by changing instructions.

## Execution / acceptance

1. Read current Issue goal, real code and constraints; identify the smallest coherent change.
2. Edit via Direct Edit or terminal; for regressions reproduce the defect, implement the minimum fix and use focused tests with actual behavior evidence.
3. Review the exact cumulative diff as the current executor, select the minimum sufficient behavior tests and CI for the change risk, and resolve known defects. Independent model/human review is optional and does not block commit, PR integration or Issue completion unless the user expressly requests it or an existing repository branch-protection rule enforces it. Never weaken actual tests, authorization or release safety checks to remove a review dependency.
4. Deliver through Git with exact SHA and legal integration; record receipts, acceptance gaps and next steps on the SAME GitHub Issue/Project. Leave Issue OPEN.
5. Continue the next actionable Issue. When blocked by user authorization, unavailable provider or external CI, record a precise blocker and stop spinning until the real trigger.

## Architecture

- Thin, decoupled, single authority/owner/writer/path for every durable fact. Fix the violated invariant and migrate all callers; delete obsolete fallback, compatibility layers, redundant state, legacy lifecycle gates, and tests in the same coherent change where safe.
- Forge is one whole Runtime with one lifecycle/recovery authority; Gateway, Scheduler, Controller and transports are modules, not competing deployable processes. Do not introduce another daemon, watchdog, retry loop, Provider, status state machine, or control plane without a real independent boundary.
- Keep Kernel/domain public port/API boundaries and repository module/import rules: `docs/architecture/CURRENT.md`. For migrations inspect all direct/indirect callers and relevant docs/tests before claiming old-path retirement.
- Browser/ChatGPT generation state from DOM/Stop/stable text is not a provider completion receipt. Require exact operation identity and trusted completion/failure evidence for authorized external actions. Legacy Supervisor Task/Effect/Turn receipts remain historical; unknown/applied effects are never replayed. Respect Retry-After; repeated unknown observations are not productive progress.
- Preserve staged/unstaged/untracked data and unique Git commits. No silent clean/reset/stash/force rebase, shared file overwrite, credentials in code, unauthorised production release or false DONE.
- UI changes require rendered interaction review; backend/Runtime changes require relevant real behavior evidence. Old failing tests can be removed only after their contracts are genuinely retired; run a focused RED→GREEN regression for current defects.
- Historical Forge Work/Plan/Requirement data may exist but is not a current progress ledger or ordinary operation prerequisite.

## Minimum sufficient checks

Use only checks relevant to the changed boundary:
```bash
bun run check:type
bun run check:repository-hygiene
bun run check:runtime-architecture
bun run check:architecture-sync
bun run check:bootstrap-files
```
Focused behavior tests before broad suites. `bun run check:main` is for an integration candidate; `bun run test:full` is explicit. Neither tests nor PR merge alone prove live acceptance.

## Architecture ownership

`.ai/hooks` is the `runtime-harness-hook-adapters` functional block. Follow `docs/architecture/modules/runtime-harness/hook-adapters.md`, the nearest directory rules and `docs/architecture/CURRENT.md`. Local architecture guidance may add technical constraints, but cannot restore Work-based task progress or auto-closure.
