# Forge Client Zen Mode

## Goal

A requirement-first, low-noise UI inside the existing native macOS Forge Client. Zen focuses on projects, goals, Plan relationships and verified progress; Agent mode retains conversations, tool traces and advanced execution.

## Source of truth

- Repository and Checkout: Forge Registry.
- Semantic Project Identity: the canonical `project_list` / `project_create` / `project_get` / `project_revise` / `project_attach_requirement` operations. A Project ID is not a Repository ID; a Project may have zero or multiple repository placements. The native `read_projects` operation continues to list Repository Registry entries only.
- Requirement and Plan content: Forge's current semantic records.
- Process and Autopilot activity: existing receipt/status API, never synthetic progress.
- **Current progress Authority:** GitHub Issues/Projects remain the delivery-progress Authority until #648's multi-project lifecycle, native Client acceptance, inventory, sample reconciliation, restart recovery and one-way cutover are accepted. Forge Project identity, Repository Registry, Requirement/Plan and Autopilot are canonical Forge data, but their existence does not mean GitHub Projects have been retired.
- **After cutover:** Forge becomes the only progress Writer; GitHub remains code collaboration and historical/evidence links. Do not dual-write or infer GitHub status from Requirement state.
- The Zen Requirement board is a projection of local Requirement task state. Before #648 cutover, it must not be presented as the official delivery-progress board. Official progress shown in Zen must come from the exact GitHub Project item Status; when unavailable, label local state clearly rather than implying synchronization.
- Zen view owns only presentation state (current screen and selected Requirement). Switching projects must not create ChatThread records.

## First implementation

- Native Zen / Agent toggle; Zen opens to the project's Requirement work board.
- macOS native icon rail and lightweight translucent project sidebar.
- Forge Requirement To do / Planned / In progress / Done / Cancelled task-state board from canonical Requirement status, linked Plan and active Autopilot receipt. Before #648 cutover these are local task states, not official GitHub delivery-progress statuses. Official progress must come from exact GitHub Project item Status; never infer it from Requirement, Plan or Autopilot. Planned means a Plan exists; it never implies a running process. No synthetic percentage. Add local Git projects without creating an Agent conversation.
- Single-Requirement canvas: Requirement root with top-down linked Plan levels. The inspector shows canonical Requirement/Plan details and acceptance criteria.
- Create Requirement / Plan through the existing Bridge and record API. Requirement create/read/revise accepts semantic `projectId` scope or `repoId` repository scope; standalone Projects do not need a Repository placement to own tasks. Project-scoped Plans require a Requirement in that Project and use its Project ID as the existing Plan `scopeKey`; standalone Projects need no Repository placement. For repository-backed Requirements, Plan creation resolves the canonical Repository placement, while Plan detail/revision retain that `repoId` alongside `projectId`. Never substitute Project ID for Repository ID. Direct editing uses the canonical `rh_work` Requirement/Plan revision actions with `expected_revision` CAS and verifies the exact successor revision before indicating success; no silent overwrite on stale versions. Agent-assisted optimization and Review open a prefilled, context-bound conversation for explicit user action; they are explicit user-controlled proposal and review workflows, not automatic background writers.
- Decision inbox reuses existing user-action requests, with a visible count on the board. Runtime execution logs remain hidden until entering Agent mode.
- “Describe goal” opens a project-bound Agent proposal with a strict single fenced JSON contract. Zen can extract exactly one proposal from the selected current-project Agent reply, reject malformed/incomplete suggestions and show a review sheet comparing canonical current Requirement/Plan fields, including a fresh revision check. User acknowledgement is required before writing; existing CAS APIs are the only writers. This is **not** a separate inference engine or an automated edit workflow.
- Important permission boundary: Zen's proposal approval controls only its own semantic writes. The existing Agent tools retain their Repository Access configuration; prompting “do not write” **does not enforce** read-only execution. Review/model analysis must use a verified read-only Agent execution scope before unattended execution is safe.
- The Requirement inspector displays the existing Autopilot run state, latest summary, current Plan and stop reason. Authorized execution can start, pause or resume from Zen. First-time/renewed authorization opens the established planning approval UI (same Runtime owner and user-selected budgets).
- Requirement lifecycle operations reuse `rh_work requirement_revise` and optimistic semantic revision checks. The native bridge accepts `dependencyRequirementIds` on create/revise; omitting it on revise preserves dependencies and `[]` clears them. The canonical Requirement store alone validates missing, cancelled, self-referential and cyclic dependencies. Completion sends `remainingWork: []` together with explicitly verified acceptance references; cancellation is explicitly confirmed; terminal Requirements cannot reopen. The existing controller remains the only writer.
- Staff/Product/Quality Review preferences persist locally. One or two distinct ready API/JoyCode profiles can run independent, effect-disabled Review turns within Zen through the existing native API-turn transport (allowEffects=false). Both receive the same canonical Requirement/Plan snapshot, which is checked for matching record ID, positive revision, valid JSON and bounded size. Zen explicitly discloses that the selected model services receive the snapshot, suppresses stale-project results and displays separate outcomes without consensus or auto-adoption. The same bounded native API-turn request enforces effect-disabled execution even if Repo Access grants broader permissions; tests cover that argument. Codex remains an explicit Agent handoff until its runtime offers verifiable read-only execution.
- Until #648 cutover, GitHub Project item Status is the official delivery-progress source. Zen may show it through the existing GitHub plugin when the read capability is available; if unavailable, state that official progress is unavailable rather than substituting Requirement status. Do not introduce a second status writer or claim the migration is complete.

## Follow-up acceptance (not yet implemented)

- Before #648 cutover, verify the GitHub Project reader on the current Runtime when `list_project_items` is available; until then, explicitly distinguish local Requirement state from official GitHub progress. Do not upgrade or replace Runtime as part of the Client task.
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

## Native interaction refinement (2026-11-12)

- The Forge board searches visible Requirement titles and canonical IDs with `⌘F`. Clearing search or switching projects does not mutate Forge records. Empty columns can be hidden or shown without changing requirement states.
- The Requirement canvas retains deep Plan relationships rather than silently stopping at ten levels. Zoom range is 35–165% with explicit fit-to-view. Plan nodes can add child Plans through the canonical Plan creator with a real `parentPlanId`.
- Inspectors show only the selected record's loaded canonical detail, expose an explicit Close action and prevent editing during incomplete selection loading.
- Mac-native route and press feedback uses brief fades/scale changes and honors Reduce Motion. No animations are triggered by status polling or background work. Project switches are disabled during active Agent execution.
- When a project is loading, show a loading state instead of falsely saying it has no Requirements.
- GUI/Accessibility acceptance must validate the newly installed binary, not merely a Swift test build. Scope one Forge.app instance and preserve Runtime independently.

## Node-first interaction refinement (2026-11-12)

- The Requirement and Plan canvas is the primary operation surface. On pointer hover (or keyboard-selected node), show **Add Plan / child Plan**, **Edit**, and an ellipsis menu. The menu contains Agent optimization, independent Review, and — only for an open Requirement — actual Autopilot start/pause/resume, approval/settings, acceptance completion and cancellation.
- The inspector on the right is deliberately **read-only preview**: goal, acceptance criteria, current execution summary, Plan items, remaining work and evidence. It has a Close control but no edit/create/approval/execution buttons. Clicking the node selects it and refreshes canonical preview data; selecting via the menu keeps node operations available for accessibility.
- Actions use the existing Forge writer / CAS, execution receipt and review owner. Edit/complete/cancel always re-read the selected canonical record and check project ID, selected node ID and revision before showing any write-capable sheet. Completed/cancelled Requirement nodes cannot mutate or spawn child Plans; Review remains available.
- Hover presentation uses brief opacity only and respects macOS Reduce Motion. No nested buttons or duplicate authority are introduced.

Manual UI acceptance: hover an unselected Requirement root, use `+` without needing the inspector, open the ellipsis and start/pause an authorized run, select a Plan and add a child Plan, edit via pencil, review a terminal node, leave the pointer and ensure the selected node still offers actions, and verify the right inspector has only preview content.
