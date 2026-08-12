# Peer SuperController Runtime

Status: active on `codex/supercontroller-refactor`

## Boundary

- External SuperController chooses models, planning, and Agent launches.
- Kernel owns repository truth, Work/Plan/Handoff contracts, Process Runtime,
  Direct Edit, deterministic maintenance, and plugin receipts.
- Kernel does **not** select models, create Agent Runs, create ExecutionJobs, or
  create Local Bridge Jobs for ordinary work.

## Deterministic Kernel paths

- `work_submit` / `rh_work` → WorkContract + ControllerSession ownership
- `repository_command_execute` short path → Process Runtime
- `plugin_action_execute` → validate → confirm → adapter → receipt
- `runtime_maintenance_apply` schedules → preview → apply → occurrence receipt

## Semantic / external paths

- Non-deterministic schedules record occurrence + Handoff only
- Long-lived work persists as Work + Handoff and can be resumed by an external SuperController
- Legacy Agent dispatch tools return structured retirement responses

## Failure policy

- No automatic retry/replay of ordinary writes
- Temporary deterministic schedule failures account consecutiveFailures and write
  one Handoff; permanent config errors pause the schedule
- After rollout 502s, inspect by request ID / Process / WorkContract; do not
  auto-replay writes
