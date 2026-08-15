# Loop Engine NL Decision Table

This document is the natural-language projection of the current prompt guard
`intent x workflow-state` behavior. It is an evaluation input for the loop
engine sprint; it is not the runtime authority until a later cutover task
explicitly switches the hook path.

## Runtime Boundary

- The edit-layer deterministic guards remain authoritative. `PreToolUse` guards
  decide implementation edits by path, active plan state, contract scope, and
  file-backed evidence.
- Prompt-layer rules are advisory except for completion claims. They should
  explain the next workflow action and preserve the current TypeScript verdict
  behavior during shadow/eval work.
- Completion is an artifact-backed state, not a successful "done" utterance.
  A completion claim must be backed by an active plan, a derived contract path,
  an existing contract, complete Evidence Contract fields, verification
  evidence, and a review/check surface.
- The state snapshot source is `forge-hook state-snapshot --json`.
  Runtime hooks must not call the full `forge` commander CLI for this
  hot-path snapshot.
  Prompt text supplies intent; file-backed workflow state supplies the guard
  facts. Do not infer plan state from the newest plan file.

## State Fields

- `states.spec`: `present` when `docs/spec.md` exists; otherwise `missing`.
- `states.plan`: `none`, `stale_marker`, `foreign_worktree`, `draft`,
  `annotating`, `approved`, `executing`, or `unknown`.
- `states.pending`: `fresh` only for a fresh pending orchestration file; `stale`
  for an old non-empty pending file; otherwise `none`.
- `states.worktree`: `foreign_marker` when the active-worktree marker belongs
  to a different checkout; otherwise `current` in the snapshot.
- `states.contract`: `present` when the derived active contract file exists.
- `states.contract_path`: `present` when a contract path can be derived from the
  active plan.
- `states.evidence`: `complete` only when the active plan has all required
  Evidence Contract fields; `incomplete` for a valid active plan with missing
  Evidence Contract data; `unchecked` when there is no valid active plan.

## Intent Classes

- `done`: the user claims the task is complete or invokes completion.
- `planning_start`: the user is asking for a new plan, `/think`, or a plan-like
  planning artifact without implementation approval.
- `planning_discussion`, `review_release`, `passive_worktree_status`,
  `passive_completion_report`, and `passive_next_slice_report`: informational
  or advisory intents; allow them through.
- `embedded_approved_plan`: the prompt contains an approved plan body or a
  plan-shaped markdown block plus implementation intent.
- `bug_fix_execution`: the prompt asks to fix/debug a bug.
- `plan_execution_projection`: the prompt asks to implement or project an
  existing plan.
- `general_execution`: any other implementation intent.

## Controlled Output Vocabulary

When this table is used for the `route-nl-vs-ts` eval, the output JSON must use
these exact string values. Do not invent shorter synonyms such as
`enter_done_gate`, `capture_pending_plan`, or `scaffold_contract`.

Allowed `intent` values:

- `done`
- `planning_start`
- `planning_discussion`
- `review_release`
- `passive_worktree_status`
- `passive_completion_report`
- `passive_next_slice_report`
- `none`
- `embedded_approved_plan`
- `bug_fix_execution`
- `plan_execution_projection`
- `general_execution`

Allowed `action` values (some historical `*_block` names remain wire-compatible but are not semantic authorization for ordinary execution):

- `allow`
- `spec_block`
- `stale_active_plan_advice`
- `plan_capture_pending_advice`
- `worktree_execution_advice`
- `plan_capture_missing_active_advice`
- `plan_status_no_active_block`
- `plan_capture_draft_advice`
- `plan_status_not_approved_block`
- `evidence_contract_block`
- `plan_execution_scaffold_advice`
- `contract_missing_block`
- `done_missing_active_plan`
- `done_contract_path_missing`
- `done_missing_contract`
- `done_evidence_contract_block`
- `done_gate`

## Decision Rules

1. If intent is `done`, run the completion gate:
   - no active plan, stale marker, or foreign marker -> require an active plan;
   - missing derived contract path -> require contract projection;
   - missing contract file -> require the active contract;
   - incomplete Evidence Contract -> require concrete evidence fields;
   - otherwise enter the done gate and verify artifacts.
2. If intent is not an execution intent, allow it. Planning and review prompts
   should not create or require a plan unless the agent explicitly captures one.
3. Product spec, active Plan, Plan status, contract presence, and Plan evidence are semantic Controller context. They do not authorize ordinary `general_execution` or `bug_fix_execution`; those intents are allowed independently of Plan state.
4. Only explicit Plan execution (`embedded_approved_plan` or `plan_execution_projection`) consumes Plan lifecycle guidance:
   - with no active Plan, advise capture/select of the intended Plan;
   - with fresh pending orchestration, advise capture rather than inventing a new execution path;
   - with Draft/Annotating Plan, advise capture/approval;
   - with Approved/Executing Plan but no projected contract, advise scaffold/projection;
   - otherwise allow.
5. A linked worktree may produce placement advice, but placement advice does not imply a semantic Plan/Work requirement.
6. `stale_marker`, `foreign_worktree`, and other legacy Plan states may be surfaced or self-healed for compatibility; they must not block ordinary implementation.
7. Hard path/private-surface, authorization, destructive-action, resource-claim, lease, and fencing boundaries remain independent enforcement points.
8. Completion (`done`) remains a separate compatibility gate until machine evidence and semantic goal acceptance are decoupled.

## Non-Rules

- Do not auto-approve plans.
- Do not invent a verifier rubric outside the contract exit criteria.
- Do not treat a natural-language completion phrase as evidence.
- Do not delete or weaken the file-backed plan, contract, checks, review, or
  handoff spine.
