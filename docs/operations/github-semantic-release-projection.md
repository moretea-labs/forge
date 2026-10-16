# GitHub semantic release projection

## Purpose

Use one root **Thin Forge Work** for a release and existing explicitly related `semanticParentWorkId` children. Forge Requirement, Plan, Work, controller binding, evidence and scheduler remain authoritative. GitHub Issues are generated **read-only projections of those durable facts**, not a task state store or an approval system.

## Setup

1. Register the repository in Forge; enable its existing GitHub plugin (`repository` set to the corresponding `owner/repo`).
2. Optional: set `projectOwner` and `projectNumber` to attach the generated Issues to one GitHub Project. The local `gh` account then needs Project scopes (`read:project`, `project`). Plain Issue sync works without Project permissions.
3. Have the model create/reuse the release Requirement and Plan, then its single primary Work. Only link independently approved or explicitly selected feature Works with `rh_work.revise(semantic_parent_work_id=...)`; **linking does not mean approval**. Continue development through the original Work and controller binding.
4. Call the existing GitHub plugin action `plugin.github.sync_semantic_release` with `release_work_id` for the root. Re-call on meaningful progress/semantic revisions (for example, from the same ongoing controller continuation workflow). The action reads the current Forge facts each time; it never edits Forge semantics.

The action creates or updates an Issue for each linked primary Work and the root release Work, using the exact `<!-- forge-semantic-work:<id> -->` marker for identity. It finds existing Issues before mutation, refuses ambiguous duplicates, and skips unchanged bodies. It never imports GitHub Issue state as a Work status and never infers user approval, tests or release completion. Exactly-once remote-send uncertainty must be reconciled by a fresh Issue inventory; do not blindly replay unknown creates.

## Explicit limitations

The current action is an **on-demand projection**, not a new scheduler or background daemon. A controller must call it when a Work's semantic content changes; deploying this source to the active Runtime is a separate release decision. Continuation is governed by the existing Forge Scheduler/Controller, not by Issue sync.

Version release acceptance remains an explicit model/human decision based on required evidence and external App Store authority. Never merge 1.0.5 work into a frozen 1.0.4 candidate.
