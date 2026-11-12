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
- “Describe goal” opens a project-bound Agent proposal with a strict single fenced JSON contract. Zen can extract exactly one proposal from the selected current-project Agent reply, reject malformed/incomplete suggestions and show a review sheet comparing canonical current Requirement/Plan fields, including a fresh revision check. User acknowledgement is required before writing; existing CAS APIs are the only writers. This is **not** a separate inference engine or an automated edit workflow.
- Important permission boundary: Zen's proposal approval controls only its own semantic writes. The existing Agent tools retain their Repository Access configuration; prompting “do not write” **does not enforce** read-only execution. Review/model analysis must use a verified read-only Agent execution scope before unattended execution is safe.
- The Requirement inspector displays the existing Autopilot run state, latest summary, current Plan and stop reason. Authorized execution can start, pause or resume from Zen. First-time/renewed authorization opens the established planning approval UI (same Runtime owner and user-selected budgets).
- Requirement lifecycle operations reuse `rh_work requirement_revise` and optimistic semantic revision checks. Completion requires explicitly verified acceptance references and no remaining work; cancellation is explicitly confirmed; terminal Requirements cannot reopen. The existing controller remains the only writer.
- Staff/Product/Quality Review preferences persist locally. One or two distinct ready API/JoyCode profiles can run independent, effect-disabled Review turns within Zen through the existing native API-turn transport (allowEffects=false). Both receive the same canonical Requirement/Plan snapshot, which is checked for matching record ID, positive revision, valid JSON and bounded size. Zen explicitly discloses that the selected model services receive the snapshot, suppresses stale-project results and displays separate outcomes without consensus or auto-adoption. The same bounded native API-turn request enforces effect-disabled execution even if Repo Access grants broader permissions; tests cover that argument. Codex remains an explicit Agent handoff until its runtime offers verifiable read-only execution.
- Optional GitHub Project status viewer reads exact Status from the existing GitHub plugin; it is never loaded by default and reports if the running Runtime lacks the new read capability.

## Follow-up acceptance (not yet implemented)

- Verify optional GitHub Project reader on a Runtime that includes `list_project_items` without upgrading or replacing Runtime as part of the Client task.
- Execute proposal analysis and Staff Review in Zen without revealing routine Agent output, but only after the actual provider runtime can enforce an immutable read-only execution scope. Ensure proposal review uses the latest canonical revision and confirms the final CAS receipt before success.
- Verify two independent API/JoyCode Review results and cancellation in the installed app, with real configured providers. A successful Swift test cannot establish successful external model calls. Codex review requires an enforced read-only runtime contract. No mandatory review gate, duplicate dispatcher or fabricated acceptance.
- GUI/Accessibility verification on the installed app once static build and unit checks are green.

## Manual checks

1. Launch: Zen default; switch Zen ↔ Agent without data loss.
2. Projects: change projects; verify no new chat thread was created; return to previous project.
3. Add an existing local Git directory from Zen, ensure it appears in Forge Registry without creating a chat. Verify local To do, Planned, In progress, Done, Cancelled buckets without GitHub access.
4. Canvas: select Requirement then Plan, confirm canonical details and parent links.
5. Create/edit Requirement and Plan, verify CAS revision increments and stale revision rejection. Explicit completion must include real acceptance references and no remaining work; cancellation requires confirmation and cannot be undone.
6. Agent: generate one fenced forge-proposal JSON block from an Agent linked to the current project; return to Zen and choose “审阅提案”; verify a single valid proposal, canonical before/after diff, stale revision rejection, explicit acknowledgement and CAS receipt. Select Review role/provider separately; no implicit multi-provider execution or unsupported read-only claims.
7. Error states and keyboard navigation. Verify only one installed app when publishing is separately authorized.
