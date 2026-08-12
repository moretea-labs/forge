# Session Continuation Protocol

This compatibility document describes **host-session recovery only**. It does not define Forge's Runtime `HandoffItem` lifecycle.

A session continuation snapshot lets a fresh Codex/Claude session recover bounded context without trusting chat history or auto-compact. It is ignored, rebuildable cache state under `.ai/harness/session/`.

## When A Session Snapshot Is Useful

- a host session is ending or approaching context limits;
- verification is incomplete and a fresh model session will continue the same bounded work;
- the active source plan/slice changes and a concise recovery snapshot is useful;
- the agent switches worktrees or host sessions.

A decision that actually requires ChatGPT/user judgement, authorization, or durable attention must be represented as a Runtime `HandoffItem` and surfaced through `rh_inbox`; writing Markdown does not create or resolve that handoff.

## Snapshot Sections

- Goal
- Decisions already evidenced by current source/runtime state
- Files touched
- Commands run
- Checks
- Blockers
- Exact next step
- Resume prompt
- Source artifacts

## Restore Flow

1. Read the current user message first.
2. Read Canonical Runtime state for the active Repository/Requirement/Plan/Work when available.
3. Read authoritative source artifacts and current Git/check evidence.
4. Read `.ai/harness/session/resume.md` and `.ai/harness/session/continuation.md` only as bounded recovery context.
5. Treat `tasks/current.md` and other generated ledgers as orientation projections only.
6. Resume from the verified next step; if state disagrees, Runtime/current user input/source/evidence wins over the session cache.

## Authority

- Migrated Requirement/Plan/Work lifecycle state is owned by the Canonical Runtime control plane as defined in `docs/architecture/current/control-plane-authority-inventory.md`.
- Git owns source code and accepted source artifacts; evidence records own their recorded observations.
- `.ai/harness/session/*` is non-authoritative and rebuildable.
- Runtime `HandoffItem`/`rh_inbox` is the durable decision/attention handoff surface.
- Browser login/CAPTCHA foreground handoff is a separate human-interaction-plane concept.
