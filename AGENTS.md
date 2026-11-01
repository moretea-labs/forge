# Forge AGENTS.md

## Development workflow (2026-10-31; current policy)

This root file is the sole repository-wide instruction authority. This policy replaces legacy Work/WorkHandle/Plan-driven execution instructions in prior versions of this file.

- **GitHub Issues and GitHub Project are the ONLY development progress ledger.** For every task, reuse the existing open Issue, record objective, priority, acceptance checklist, PR/commit/CI/review evidence, blockers and remaining steps there. Keep Issues **OPEN** for user/independent completion audit; do not auto-close, including when implementation is fully verified. Use `Refs #123` in PR/commit text, never auto-close keywords. Do not create a second issue, Requirement, Plan, Work, local TODO/progress database or parallel task record for the same goal.
- **NO semantic Work, WorkHandle, Plan or Work-linked lifecycle for new or continued development.** Do not call Work start/get/revise/complete/prepare/recover/finalize or use Work identity as permission, task binding, owner, scheduler key or status source. Old records can be inspected read-only only to recover unique prior source/effects and may be retained as history; migrate existing users to the single GitHub path and retire old gates. Forge's Process/Git leases and Supervisor's Task/Effect/Receipt remain execution-safety owners, never duplicate progress authorities.
- **Direct Edit and terminal first.** Use existing Forge Direct Edit or authorized terminal `rg`, `git`, build/test commands for the shortest code-to-result path. Prefer current checkout; isolate only for real concurrent write/resource conflicts. Do not create orchestration for ordinary edits. Stage/commit precisely owned files and push/review only validated diff. Never overwrite unrelated dirty/untracked content.
- **Repeatable issue queue:** inspect the repository's OPEN Issues and GitHub Project; take the highest priority *actionable* item within the user's current scope; read actual source and latest PR/CI; execute a meaningful change/check/review/integration; update its Issue/Project with evidence, blockers and next action; immediately proceed to the next actionable item. Revisit blocked items only when material evidence or dependency changes. Do not equate a repeated status report/CONTINUE with throughput; do not poll without new evidence.
- **One existing continuation authority:** Supervisor owns Task/Effect/Receipt, Schedule wakes, Launcher delivers. Do not add a second loop, duplicate active Writer or automatic Reviewer polling. Review one fixed HEAD once; on REVISE wait for a changed HEAD, then review once again. WAIT when only a genuine external dependency remains; resume on GitHub/CI/review/provider event or bounded scheduler wake. Existing Work-bound effects must be reconciled/settled without replay before moving to Issue-bound continuation; never start two competing paths.
- **Safety contracts persist:** scoped authorization and strong confirmation, Git SHA/CAS/checkout/path/ref leases, secret isolation, exactly-once external writes, non-overlapping source ownership, release/recovery approvals and rollback evidence. Unknown/applied external Sends cannot be blindly resent. A legacy gate that still enforces Work is a defect for #483 to fix, not permission to bypass the real authorization/Git/effect authority through another tool.
- **Mac canonical Forge source:** no competing WSL Writer. Release/source switch, restart, rollback or cutover is separate from code development and is not authorized by changing instructions.

## Execution / acceptance

1. Read current Issue goal, real code and constraints; identify the smallest coherent change.
2. Edit via Direct Edit or terminal; for regressions reproduce the defect, implement the minimum fix and use focused tests with actual behavior evidence.
3. Review exact cumulative diff. For material architecture/security/external-effect changes obtain independent fixed-HEAD review and CI when required; don't repeatedly run the same checks without new inputs.
4. Deliver through Git with exact SHA and legal integration; record receipts, acceptance gaps and next steps on the SAME GitHub Issue/Project. Leave Issue OPEN.
5. Continue the next actionable Issue. When blocked by user authorization, unavailable provider or external CI, record a precise blocker and stop spinning until the real trigger.

## Architecture

- Thin, decoupled, single authority/owner/writer/path for every durable fact. Fix the violated invariant and migrate all callers; delete obsolete fallback, compatibility layers, redundant state, legacy lifecycle gates, and tests in the same coherent change where safe.
- Forge is one whole Runtime with one lifecycle/recovery authority; Gateway, Scheduler, Controller and transports are modules, not competing deployable processes. Do not introduce another daemon, watchdog, retry loop, Provider, status state machine, or control plane without a real independent boundary.
- Keep Kernel/domain public port/API boundaries and repository module/import rules: `docs/architecture/CURRENT.md`. For migrations inspect all direct/indirect callers and relevant docs/tests before claiming old-path retirement.
- Browser/ChatGPT generation state from DOM/Stop/stable text is not a provider completion receipt. Require exact Task/Effect/Turn identity, trusted completion/failure evidence and durable no-replay fences. Respect cooldown and Retry-After; repeated unknown observations are not productive progress.
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
