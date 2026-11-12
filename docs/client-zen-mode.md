# Forge Client Zen Mode

## Goal

A requirement-first, low-noise UI inside the existing native macOS Forge Client. Zen focuses on projects, goals, Plan relationships and verified progress; Agent mode retains conversations, tool traces and advanced execution.

## Source of truth

- Repository and Checkout: Forge Registry.
- Requirement and Plan content: Forge's current semantic records.
- Process and Autopilot activity: existing receipt/status API, never synthetic progress.
- **Primary project management is fully GitHub-independent.** Forge Repository Registry owns projects/checkouts; Forge Requirement/Plan and Autopilot records own local board facts. Status columns are read-only projections, not a second editable state table. GitHub Issues/Project are optional external collaboration and evidence.
- Zen view owns only presentation state (current screen and selected Requirement). Switching projects must not create ChatThread records.

## First implementation

- Native Zen / Agent toggle; Zen opens to the project's Requirement work board.
- macOS native icon rail and lightweight translucent project sidebar.
- Forge-local To do / Planned / In progress / Done / Cancelled board from the canonical Requirement status, linked Plan and active Autopilot receipt. Planned means a Plan exists; it never implies a running process. No synthetic percentage. Add local Git projects without creating an Agent conversation.
- Single-Requirement canvas: Requirement root with top-down linked Plan levels. The inspector shows canonical Requirement/Plan details and acceptance criteria.
- Create Requirement / Plan through the existing Bridge and record API. Direct editing uses the canonical `rh_work` Requirement/Plan revision actions with `expected_revision` CAS and verifies the exact successor revision before indicating success; no silent overwrite on stale versions. Agent-assisted optimization and Review open a prefilled, context-bound conversation for explicit user action; they are **not** yet automatic semantic revisions or independent reviewers.
- Decision inbox reuses existing user-action requests, with a visible count on the board. Runtime execution logs remain hidden until entering Agent mode.
- “Describe goal” opens an explicitly user-controlled, project-bound Agent proposal that first distinguishes revising an existing Requirement/Plan from creating a new one and requests confirmation before semantic or source writes; it is an Agent handoff, not an automatic Zen-local model result.
- The Requirement inspector displays the existing Autopilot run state, latest summary, current Plan and stop reason. Authorized execution can start, pause or resume from Zen. First-time/renewed authorization opens the established planning approval UI (same Runtime owner and user-selected budgets).
- Requirement lifecycle operations reuse `rh_work requirement_revise` and optimistic semantic revision checks. Completion requires explicitly verified acceptance references and no remaining work; cancellation is explicitly confirmed; terminal Requirements cannot reopen. The existing controller remains the only writer.
- Staff/Product/Quality Review role and Provider/Model choices persist locally. Review is an explicit read-only Agent request, not yet independent multi-model orchestration.
- Optional GitHub Project status viewer reads exact Status from the existing GitHub plugin; it is never loaded by default and reports if the running Runtime lacks the new read capability.

## Follow-up acceptance (not yet implemented)

- Verify optional GitHub Project reader on a Runtime that includes `list_project_items` without upgrading or replacing Runtime as part of the Client task.
- Revision-bound AI proposal/diff/approval and minimal writes to Requirement or Plan (model chooses revise vs new).
- Optional Staff Agent multi-provider read-only Review; no mandatory review gate or second tool/execution dispatcher.
- GUI/Accessibility verification on the installed app once static build and unit checks are green.

## Manual checks

1. Launch: Zen default; switch Zen ↔ Agent without data loss.
2. Projects: change projects; verify no new chat thread was created; return to previous project.
3. Add an existing local Git directory from Zen, ensure it appears in Forge Registry without creating a chat. Verify local To do, Planned, In progress, Done, Cancelled buckets without GitHub access.
4. Canvas: select Requirement then Plan, confirm canonical details and parent links.
5. Create/edit Requirement and Plan, verify CAS revision increments and stale revision rejection. Explicit completion must include real acceptance references and no remaining work; cancellation requires confirmation and cannot be undone.
6. Agent: choose Optimize or Review, select an available review Provider / Model and role; inspect the bound Requirement/Plan in the new draft. No implicit provider tool execution.
7. Error states and keyboard navigation. Verify only one installed app when publishing is separately authorized.
