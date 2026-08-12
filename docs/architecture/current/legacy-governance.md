# Legacy Capability Governance

> Status: **Runtime Authority**

Forge is a direct descendant of RepoHarness. Provenance is historical fact, not a runtime compatibility requirement. Governance removes obsolete authorities and duplicate entrypoints while retaining implementations that still satisfy current invariants.

## Rule

A capability may survive from RepoHarness when it has one current owner, does not create a second lifecycle writer, and does not require an external Agent/skill for correctness. Code should be rewritten only when the old implementation violates those invariants; lineage alone is not a reason to rewrite working code.

## Capability disposition

| Capability | Disposition | Current authority |
|---|---|---|
| Plan/spec source artifacts | keep | Git source artifacts; Runtime Plan/Work owns migrated lifecycle state |
| Contract/check/review evidence | keep and bound | Git/evidence plane; completion policy evaluates evidence |
| Repository/process/worktree execution | replace legacy orchestration | Canonical Runtime, Process Runtime, Resource Claims/Leases |
| CodeGraph | internalize | `rh_context` + bundled structural backend; host MCP is optional |
| Hook adapters | keep thin | host event adapter only; never lifecycle owner |
| Session resume context | rename/demote | `.ai/harness/session/*` rebuildable cache only |
| Decision handoff | keep as Runtime object | `HandoffItem` surfaced through `rh_inbox` |
| Browser human-interaction handoff | keep separate | browser interaction policy; not Work/Plan handoff |
| Waza/gstack/gbrain/Mermaid | optional | external host enhancement only |
| Campaign | remove | no current authority |
| legacy Issue/Task/project writers | freeze/remove | migrated Requirement/Plan/Work state in SQLite |
| legacy helper/host commands | hide then delete when no managed callers remain | public CLI exposes product workflows only |

## Handoff terminology

Three historical concepts used the same word and must remain separated:

1. **Runtime HandoffItem** — a durable decision/attention item created for ambiguity, authorization, repeated infrastructure failure, or human review. This is the only generic Forge object called a handoff.
2. **Session continuation cache** — ignored Markdown under `.ai/harness/session/` used to rehydrate a fresh Codex/Claude session. It is derived, rebuildable, and cannot approve work or override Runtime state.
3. **Browser human-interaction handoff** — a bounded browser/UI interaction that needs a human (for example login/CAPTCHA). It is an interaction-plane event, not a repository lifecycle state.

Hooks may refresh (2). Hooks must never synthesize or resolve (1) by writing Markdown.

## CLI governance

Public top-level commands should describe user goals, not implementation layers.

Public: `install`, `update`, `adopt`, `uninstall`, `setup`, `status`, `doctor`, `repo`, `runtime`, `recovery`, `plugin`, `chatgpt`, `mcp`, `tools`, `security`, `docs`.

Hidden compatibility/host machinery may remain callable while generated workflows still use it: `hook`, `run`, legacy `controller`, `migrate`, `brain`, `capability-context`, and `prompt-guard-decide`.

`init` and `init-hook` are retired duplicate public entrypoints. Use `install` and `setup check` respectively.

## Removal policy

A hidden compatibility surface can be deleted when:

1. no current generated asset writes or documents it as a primary route;
2. no current Runtime/host adapter invokes it;
3. migration/readback coverage proves old persisted state has an explicit replacement or is intentionally abandoned;
4. focused tests and architecture checks prove the replacement path;
5. deletion does not recreate the capability under a new duplicate abstraction.

Historical Git commits, changelog entries, ADRs, and third-party notices are not rewritten merely to erase RepoHarness provenance.
