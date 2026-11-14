# Forge Client Zen Mode

## Goal

A requirement-first, low-noise UI inside the existing native macOS Forge Client. Zen focuses on projects, goals, Plan relationships and verified progress; Agent mode retains conversations, tool traces and advanced execution.

## Source of truth

- Repository and Checkout: Forge Registry.
- Requirement and Plan content: Forge's current semantic records.
- Process and Autopilot activity: existing receipt/status API, never synthetic progress.
- **Delivery progress authority remains GitHub Issues + GitHub Project until #648's full migration acceptance.** Forge Repository Registry owns projects/checkouts; Requirement/Plan own semantic requirement and plan content; Process/Autopilot own execution receipts. These are not a second task/progress ledger. The local Requirement board is a semantic workspace view only: never infer GitHub status from Requirement lifecycle, Plan existence or an Autopilot receipt.
- Zen view owns only presentation state (current screen and selected Requirement). Switching projects must not create ChatThread records.

## First implementation

- Native Zen / Agent toggle; Zen opens to the project's Requirement work board.
- macOS native icon rail and lightweight translucent project sidebar.
- Local Requirement board grouped from canonical Requirement lifecycle, linked Plan and active Autopilot receipt. It is a semantic view, not the delivery-progress board. Planned means a Plan exists; it never implies a running process. No synthetic percentage. Add local Git projects without creating an Agent conversation.
- Single-Requirement canvas: Requirement root with top-down linked Plan levels. The inspector shows canonical Requirement/Plan details and acceptance criteria.
- Create Requirement / Plan through the existing Bridge and record API. Direct editing uses the canonical `rh_work` Requirement/Plan revision actions with `expected_revision` CAS and verifies the exact successor revision before indicating success; no silent overwrite on stale versions. Agent-assisted optimization and Review open a prefilled, context-bound conversation for explicit user action; they are explicit user-controlled proposal and review workflows, not automatic background writers.
- Decision inbox reuses existing user-action requests, with a visible count on the board. Runtime execution logs remain hidden until entering Agent mode.
- “Describe goal” opens a project-bound, read-only API conversation. The user can drive multiple clarification turns; the model may return exactly one fenced `ACCEPT` proposal. Zen rejects malformed/incomplete suggestions and shows a review sheet against canonical Requirement/Plan data with a fresh revision check. User acknowledgement is required before writing; existing CAS APIs are the only writers. This is currently a **manual user-driven multi-turn flow**, not an automatic bounded refinement loop or background writer.
- Read-only analysis is enforced by the thread's read-only flag, an exact repository/checkout context check, and native API-turn `allowEffects=false`; read-only threads cannot switch to the Codex/local CLI provider. The prompt is guidance, not the security boundary. The same boundary must be preserved when providers or transports change.
- The Requirement inspector displays the existing Autopilot run state, latest summary, current Plan and stop reason. Authorized execution can start, pause or resume from Zen. First-time/renewed authorization opens the established planning approval UI (same Runtime owner and user-selected budgets).
- Requirement lifecycle operations reuse `rh_work requirement_revise` and optimistic semantic revision checks. Completion requires explicitly verified acceptance references and no remaining work; cancellation is explicitly confirmed; terminal Requirements cannot reopen. The existing controller remains the only writer.
- Staff/Product/Quality Review preferences persist locally. One or two distinct ready API/JoyCode profiles can run independent, effect-disabled Review turns within Zen through the existing native API-turn transport (allowEffects=false). Both receive the same canonical Requirement/Plan snapshot, which is checked for matching record ID, positive revision, valid JSON and bounded size. Zen explicitly discloses that the selected model services receive the snapshot, suppresses stale-project results and displays separate outcomes without consensus or auto-adoption. The same bounded native API-turn request enforces effect-disabled execution even if Repo Access grants broader permissions; tests cover that argument. Codex remains an explicit Agent handoff until its runtime offers verifiable read-only execution.
- GitHub Project view reads the actual Status from the existing GitHub plugin and remains the delivery-progress view while #648 is open. It must not silently fall back to Requirement lifecycle or Autopilot state as if those were GitHub statuses; unconfigured, loading and error states remain explicit.

## Follow-up acceptance (not yet implemented)

- Verify the GitHub Project reader on a Runtime that includes `list_project_items` without upgrading or replacing Runtime as part of the Client task; preserve it as the current delivery-progress view until #648 migration is accepted.
- Implement the still-missing **automatic bounded refinement loop**: model-owned continuation, explicit round/token/time budget, real stop reasons, structured `ACCEPT` bound to the exact final Requirement/Plan revision, and recovery/cancel behavior. The current manual multi-turn proposal flow does not satisfy this acceptance.
- Verify proposal analysis and Staff Review in Zen without revealing routine Agent output, using the enforced thread-scoped read-only API execution scope. Ensure proposal review uses the latest canonical revision and confirms the final CAS receipt before success.
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
