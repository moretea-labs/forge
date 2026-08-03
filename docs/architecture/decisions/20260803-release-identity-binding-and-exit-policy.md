# ADR: Release Identity Binding and Supervisor Exit Policy

- **Status:** Accepted amendment (implements transition gap; does not replace single-owner target)
- **Date:** 2026-08-03
- **Scope:** Immutable release identity for managed Supervisor children; cold-start availability; launchd vs Supervisor failure domains
- **Authority:** [`../current/runtime-architecture-simplification.md`](../current/runtime-architecture-simplification.md) §5–§6
- **Related:** [`20260802-single-owner-runtime-lifecycle.md`](20260802-single-owner-runtime-lifecycle.md), [`../current/stable-external-runtime-supervisor.md`](../current/stable-external-runtime-supervisor.md)
- **Trigger evidence:** Supervisor launchd death loop when ambient repo HEAD advanced past active release; Daemon ready while readiness compared walk-up `git rev-parse HEAD`; Gateway never started; stable ingress 503

## Context

Installed Supervisor releases are immutable directory closures without their own Git checkout. Managed children historically re-derived “source identity” via `git -C <runtime-source-root> rev-parse HEAD`, which walks up to the developer checkout and follows ambient `main`. Supervisor readiness then compared that live HEAD to the managed `releaseRevision`, permanently failing, throwing from cold `start()`, exiting non-zero, and turning launchd KeepAlive into a thrash against a permanent identity bug.

Rollback correctly refused non-known-good previous releases. Reinstall temporarily aligned identities until the next commit on `main`. Incident patches (manifest pin, soft-fail) stop one loop instance but do not define the ownership and exit rules that prevent the class.

## Decision

### 1. Single release identity binding

Every Supervisor-managed child (Daemon, Gateway Host) runs under a **captured release identity binding** fixed at spawn:

```text
ReleaseIdentityBinding {
  releasePath
  releaseRevision
  sourceCommit
  manifestHash?   // digest of release manifest / artifact set when available
}
```

Authority order for child source identity:

1. **Injected binding** from Supervisor env/args (`REPO_HARNESS_RELEASE_*`) — preferred for all managed children.
2. **Immutable release `manifest.json`** when the runtime root is not its own Git checkout.
3. **Own Git checkout** only for developer/script launches that are not Supervisor children.
4. **Never** inherit branch/HEAD/dirty state from an ambient parent repository.

Projections (`runtime-generation.json`, daemon state `source`, readiness comparisons) may **mirror** the binding. They must not invent a newer commit by consulting ambient Git while under Supervisor management.

### 2. Failure-domain separation (exit policy)

| Failure class | Owner | Response | Forbidden |
| --- | --- | --- | --- |
| Child not ready / incomplete managed pair | Supervisor monitor / `ensureRuntime` | `observedState=degraded`; retry under component budgets; rebuild pair | Supervisor process exit; launchd thrash |
| Child process dead (identity-proven) | Supervisor | Restart that component only | Full stack restart by default |
| Identity / authority mismatch | Supervisor | Degraded or quarantine; durable op; honest incident | Kill unproven PID; rewrite authority from projections alone |
| Supervisor panic / OOM / unexpected crash | OS service manager | Restart Supervisor | Using launchd to heal child readiness |
| Explicit authorized stop / handoff | Supervisor + service policy | Stay down or hand off cleanly | Auto restart after successful exit |

Cold start is staged:

1. Lock, control plane, Rescue MCP  
2. Stable ingress (last-known-good routing)  
3. Rebuild managed pair (soft failure allowed)  
4. Mark healthy only when pair + release coherence pass  

After stage 1, Rescue MCP must remain reachable for the life of the Supervisor PID even if stage 3 never succeeds.

### 3. Incomplete pair is rebuildable, not an operator authority crisis

After Supervisor restart, missing Gateway (or cleared projection of the pair) is the **normal rebuild path**. It is not “authority recovery is required” unless slot/release/generation CAS evidence actually conflicts. Language and recovery routing must keep these classes distinct.

### 4. Known-good is earned

- Publish ≠ known-good; successful activation ≠ known-good.
- Known-good requires sustained health + release coherence (and may add operator ack later).
- Standalone Recovery rollback may target only registered known-good previous releases. The `previous` pointer alone is never sufficient authorization.

### 5. No ambient source on the live service path

launchd → fixed bootstrap → immutable release. Managed `REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT` is the **release path** (or equivalent self-contained closure), not a mutable developer checkout, once cutover for a home is complete.

## Rationale

The single-owner lifecycle ADR already forbids nested lifecycle owners and requires exact identity. This ADR names the **missing binding plane** and the **wrong recovery layer** that produced death loops: ambient Git as a second identity authority, and process death as the healer for child readiness. Without both rules encoded, each new commit on `main` can recreate P0 outages against frozen releases.

## Consequences

### Must implement

- A shared binding module used by Supervisor spawn, Daemon/Gateway source identity, and readiness comparison.
- Spawn always injects binding for managed children; children prefer binding over Git.
- Cold start soft-fails managed pair recovery after control/ingress are up (availability plane).
- Class regression tests: ambient parent HEAD advances under a nested release root → child identity stays on manifest/binding; readiness timeout does not require Supervisor exit.
- Documentation links from `runtime-architecture-simplification.md` and the architecture index.

### Explicitly deferred (still target)

- Full single `bootstrap/runtime-authority.json` cutover (G3/G5).
- Automatic known-good receipt writer and Recovery list filter productization (G6).
- Deletion of Gateway KeepAlive / slot authority (G4/G7).

Those remain on the simplification track; this ADR is the **identity and exit-policy floor** so transition code cannot recreate death loops.

## Alternatives rejected

1. **Keep reinstalling from current HEAD whenever identity drifts** — treats symptom; ambient HEAD keeps moving.  
2. **Blind rollback to `previous` without known-good** — violates last-known-good continuity.  
3. **Weaken readiness to ignore releaseRevision** — hides dual-authority; allows incoherent “healthy” states.  
4. **Faster launchd restarts** — amplifies thrash; wrong layer.

## Verification

- Unit/integration: immutable release nested under advanced parent Git never reports parent HEAD as `source.commit` / `releaseRevision` when binding or manifest is present.
- Unit: cold `start()` with forced `ensureRuntime` failure remains process-alive and `degraded` with control plane state written.
- Live: advancing checkout HEAD while active release is frozen does not produce `CONTROLLERDAEMON_READINESS_TIMEOUT` launchd loops.

## Status notes

Identity pin via immutable manifest (`collectRuntimeSourceIdentity` when root is not own-git) and cold soft-fail are the first executable steps of this ADR. Binding env injection and child preference for `REPO_HARNESS_RELEASE_*` close the remaining ambient path for Supervisor-managed processes.
