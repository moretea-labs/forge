# Forge Client Zen Mode

## Goal

A requirement-first, low-noise UI inside the existing native macOS Forge Client. Zen focuses on projects, goals, Plan relationships and verified progress; Agent mode retains conversations, tool traces and advanced execution.

## Source of truth

- Repository and Checkout: Forge Registry.
- Requirement and Plan content: Forge's current semantic records.
- Process and Autopilot activity: existing receipt/status API, never synthetic progress.
- GitHub Issue / Project: delivery statuses and completion ledger. The initial board groups Requirements by *their own* completion and runtime activity; this is not yet a GitHub Project status board.
- Zen view owns only presentation state (current screen and selected Requirement). Switching projects must not create ChatThread records.

## First implementation

- Native Zen / Agent toggle; Zen opens to the project's Requirement work board.
- macOS native icon rail and lightweight translucent project sidebar.
- Three Requirement columns: completed; active Autopilot receipt; other. No inferred percentage.
- Single-Requirement canvas: Requirement root with top-down linked Plan levels. The inspector shows canonical Requirement/Plan details and acceptance criteria.
- Create Requirement / Plan through the existing Bridge and record API. Direct editing uses the canonical `rh_work` Requirement/Plan revision actions with `expected_revision` CAS and verifies the exact successor revision before indicating success; no silent overwrite on stale versions. Agent-assisted optimization and Review open a prefilled, context-bound conversation for explicit user action; they are **not** yet automatic semantic revisions or independent reviewers.
- Decision inbox reuses existing user-action requests, with a visible count on the board. Runtime execution logs remain hidden until entering Agent mode.
- “Describe goal” opens an explicitly user-controlled, project-bound Agent proposal that first distinguishes revising an existing Requirement/Plan from creating a new one and requests confirmation before semantic or source writes; it is an Agent handoff, not an automatic Zen-local model result.
- The Requirement inspector displays the existing Autopilot run state, latest summary, current Plan and stop reason. Authorized execution can start, pause or resume from Zen. First-time/renewed authorization opens the established planning approval UI (same Runtime owner and user-selected budgets).
- Staff/Product/Quality Review role and the available Provider/Model are selectable; last preference is remembered locally. Review is an explicit read-only Agent request, not parallel multi-model orchestration.

## Follow-up acceptance (not yet implemented)

- Real GitHub Project kanban status adapter, kept distinct from Requirement state.
- Revision-bound AI proposal/diff/approval and minimal writes to Requirement or Plan (model chooses revise vs new).
- Optional Staff Agent multi-provider read-only Review; no mandatory review gate or second tool/execution dispatcher.
- GUI/Accessibility verification on the installed app once static build and unit checks are green.

## Manual checks

1. Launch: Zen default; switch Zen ↔ Agent without data loss.
2. Projects: change projects; verify no new chat thread was created; return to previous project.
3. Board: inspect real Requirement counts; in-progress only with an active Autopilot receipt; done only with completed state.
4. Canvas: select Requirement then Plan, confirm canonical details and parent links.
5. Authoring: create Requirement and Plan; edit both, verify canonical revision increment and refreshed fields; attempt a stale revision and verify the edit fails without clobbering newer content.
6. Agent: choose Optimize or Review, select an available review Provider / Model and role; inspect the bound Requirement/Plan in the new draft. No implicit provider tool execution.
7. Error states and keyboard navigation. Verify only one installed app when publishing is separately authorized.
