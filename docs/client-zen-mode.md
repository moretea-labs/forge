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
- Create Requirement / Plan through the existing Bridge and record API. Agent-assisted optimization and Review open a prefilled, context-bound conversation for explicit user action; these are **not** yet automatic semantic revisions or independent reviewers.
- Decision inbox reuses the existing user-action request list. Runtime execution logs remain hidden until entering Agent mode.

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
5. Authoring: create Requirement, create a Plan on it; verify through canonical records after refresh.
6. Agent: choose Optimize or Review; inspect the bound Requirement/Plan in the new draft. No implicit provider tool execution.
7. Error states and keyboard navigation. Verify only one installed app when publishing is separately authorized.
