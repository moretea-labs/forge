# Workflow Architecture

Forge Workflow is a **first-class executable feature**, not an Event submodule and not a model tool loop. A Workflow is a versioned, recoverable, auditable multi-step execution asset that composes existing Forge capabilities under the existing authorization, Process, Lease, Receipt, and WorkflowRun authorities.

GitHub issues #718, #719, and #721 carry current engineering requirements and acceptance evidence. This page explains the intended stable boundaries.

## Product boundaries

| Feature | Owns | Does not own |
| --- | --- | --- |
| Plugin | Capability/provider integration, transport, provider-specific actions | Multi-step orchestration, Workflow lifecycle |
| Skill | Reusable model guidance, knowledge, operating instructions | Durable execution state or external-effect authority |
| Workflow | Versioned execution asset, catalog, package, lifecycle, invocation, recovery, receipts | Event matching, model-specific reasoning policy |
| Event Rule | Event trigger, deterministic condition, routing to registered actions | Workflow graph execution or durable effect recovery |
| Scheduler | Time/recurrence trigger, admission, dispatch occurrence | Workflow execution state after dispatch ownership transfers |
| Model | Optional caller, Action provider, or authoring source | Workflow activation, authorization, arbitrary effect authority |

The intended composition is:

```text
Event Rule ---------+
Scheduler -----------+
User / Client -------+
Model ---------------+----> Workflow Invocation ----> Workflow Feature Runtime
Plugin / Skill ------+                |                         |
Child Workflow ------+                |                         +--> sequence_v1
System --------------+                |                         +--> graph_v2
                                       v
                              Catalog + lifecycle
                                       |
                                       v
                           Capability / Plugin owners
                                       |
                                       v
                         Process / Receipt / Reconcile
```

## First-class Workflow surface

Workflow exposes one domain independent of its callers:

- Catalog: list, get, discovery/search, engine and dependency metadata.
- Authoring: deterministic preflight for human, UI, model, plugin, or import drafts.
- Package: manifest, bundle, import/export, update, compatibility and dependency checks.
- Lifecycle: installed, active, inactive. Authoring/import does not imply activation.
- Invocation: one caller-neutral `WorkflowInvocationIntentV1`.
- Runtime: engine routing for `sequence_v1` and `graph_v2`.
- Recovery: WorkflowRun/checkpoint/receipt state; callers do not duplicate it.

Adapters such as MCP, CLI, Client UI, Event, and Scheduler should be thin. They must call this public Workflow boundary rather than read Workflow Registry internals or branch on engine type.

## Invocation contract

All callers converge on a stable invocation identity:

```text
workflowId
registryScope: controller | project
origin: user | event | schedule | model | plugin | skill | workflow | system
inputs
binding.scopeId
binding.runId
```

The origin is provenance, not authority. A model-origin or plugin-origin invocation receives no extra permission from its origin kind.

A caller may prepare an invocation without executing it. Preparation validates Workflow existence, lifecycle, exact content identity, inputs, capability bindings, and child-Workflow readiness. The result remains `not_authorized` / `not_executed` until the existing execution and authorization owners act.

## Workflow packages

A distributable Workflow consists of a validated executable asset plus `WorkflowPackageManifestV1`.

The manifest binds:

- `workflowId`, Workflow version, and executable `contentDigest`;
- engine (`sequence_v1` or `graph_v2`);
- input-contract digest;
- required capability IDs;
- child Workflow dependencies pinned by version and/or content digest;
- runtime compatibility range;
- risk and approval requirement;
- publisher/origin metadata;
- package digest.

The manifest never contains credentials, grants, lifecycle state, or authorization. Publisher metadata is provenance only.

A package bundle is self-validating. Asset or manifest tampering fails closed. Unknown top-level bundle fields are rejected so an import cannot smuggle `active`, authorization, credentials, or other lifecycle authority.

## Package lifecycle

Package operations preserve a strict separation between content and authority.

### Install

Install requires explicit Workflow-install authority. A package may be installed even when local capability bindings or child activation are not yet ready, but it remains `installed`. Install does not:

- activate the Workflow;
- bind capabilities;
- grant permissions;
- approve sensitive actions;
- execute the Workflow.

Same-Workflow package writers are serialized with the existing Controller Lock. Registry optimistic revision remains the authoritative concurrency check.

### Durable package installation identity

Package membership is not inferred only from the presence of `package.json`. Each installed package version also records immutable Package Installation metadata keyed by Registry scope + workflowId + version. The record binds contentDigest, packageDigest, executable path, and package path, but **does not duplicate Workflow lifecycle state**.

This prevents a damaged or deleted `package.json` from silently downgrading a packaged Workflow into the legacy lifecycle path. A missing/corrupt package remains `packaged-invalid`: activation fails closed, while explicit deactivation remains available as a recovery action.

### Activate

Packaged Workflow activation rechecks:

- package/content identity;
- runtime compatibility;
- exact child Workflow dependencies;
- local capability bindings;
- lifecycle authority;
- sensitive risk approval.

For a sensitive package, approval is bound to the exact `packageDigest`; approval for one package revision cannot activate another. The package layer does **not** trust a caller-supplied boolean or digest as approval. It consumes an opaque proof produced only after Forge Authorization resolves an exact approval request whose command binds `scope + workflowId + packageDigest + activate`. A proof for another Workflow, scope, or digest is invalid.

### Update

A Workflow version is an immutable content identity. Reusing the same workflow version with a different content digest is rejected; package update must point at a different version (or the exact same immutable identity, which is a re-import rather than an update).

A new package identity is written to its new versioned content path. Registry identity changes only after validation. Updating an active Workflow does not hot-replace execution semantics: the new identity becomes `installed`, old capability bindings are reset, and explicit reactivation is required.

An active packaged parent also protects the exact child Workflow identity it declares. A child package cannot be updated or deactivated while an active parent is pinned to that child version/content digest. The parent must first be deactivated or upgraded to a compatible dependency.

Old versioned content is not overwritten by the update. **Current safety boundary:** while WorkflowRun still depends on the current Registry for executable content and local capability bindings, any nonterminal run of the installed identity blocks package update. Only terminal runs (`succeeded`, `failed`, `cancelled`, or `compensated`) permit the identity switch.

A future relaxation may allow old and new versions to run concurrently only after each run durably snapshots or otherwise resolves its exact executable asset and local capability-binding identity without relying on the current Registry pointer.

### Uninstall

Package uninstall is explicit and conservative. A Workflow must not be active, must not have active packaged parents pinned to its exact identity, and must not have any nonterminal WorkflowRun for that identity.

Uninstall removes only the current Workflow Registry installation entry. Versioned executable content, `package.json`, and immutable Package Installation metadata are retained for audit, exact reinstall, and old-run/history safety. Physical content garbage collection is a separate reference-proven operation and must not assume that “not currently installed” means “safe to delete”.

## Discovery

Package discovery is a Workflow product surface, not an Event feature. Packaged and legacy unpacked Workflows remain visible in one Catalog. Discovery may filter/search by:

- Workflow ID, title, description;
- engine and lifecycle;
- capability dependencies;
- child Workflow dependencies;
- package tags;
- publisher provenance;
- packaged versus legacy-unpacked state.

This enables the Client, CLI, model, Skill, Plugin, and Event authoring UI to discover Workflows through the same source of truth.

## Event integration

Event Rule owns only:

```text
Event Envelope -> Trigger -> deterministic Condition -> Route -> Action reference
```

A Workflow route resolves through the public Workflow Catalog/invocation preflight. Event code must not inspect Workflow steps, Graph nodes, registry storage details, or execution checkpoints.

A model can be an Event Action (`model.request`) or can propose an Event Rule. It is not a required Event Rule stage.

## Scheduler integration

Scheduler owns **when** and Workflow owns **how**.

A `workflow.invoke` schedule creates a stable Workflow invocation from the Schedule occurrence. The same occurrence produces the same Workflow run ID. At dispatch time the adapter resolves the current registered repository/checkout and delegates to the Workflow Feature Runtime.

Once Workflow Runtime accepts the run identity, Scheduler records the occurrence as `dispatched`. Subsequent Workflow states such as `running`, `waiting`, `reconcile_required`, or `succeeded` remain solely in Workflow state. Scheduler must not duplicate them into a second execution state machine.

Failure before ownership transfer is a Schedule dispatch failure and may use Scheduler failure/backoff policy.

## Graph Runtime v2

Graph Runtime extends the existing Workflow Runtime rather than creating a second engine authority. The graph contract supports:

- deterministic branch/switch;
- parallel fan-out and join (`all`, `any`, quorum);
- durable `wait_event`;
- approval waits;
- bounded retry/backoff;
- child Workflow invocation;
- non-idempotent effect reconciliation;
- crash/restart recovery.

Unknown external-effect outcome is never a normal retry class. A non-idempotent effect must reconcile before retrying after an uncertain outcome.

Graph execution continues to use the existing `workflow_run` ledger, Capability owners, Process Runtime, resource/Lease authority, and receipts.

## Model authoring

Models may generate Workflow or Rule drafts through the same authoring proposal path used by human/UI/import sources. Model provenance grants no install, update, activation, approval, or execution authority.

The first-class authoring apply path is **Proposal → Package Bundle → Package install/update**. New model/UI/human/import authoring must not persist a bare `workflow.json` and Registry entry, because that would create a `legacy_unpacked` Workflow and bypass package dependency, lifecycle, risk, and distribution invariants. Bare authoring remains only a compatibility path until all public adapters migrate.

A generated Workflow must pass deterministic schema, reference, dependency, risk, input-contract, and package validation before it can be installed. Installation still does not activate it. Graph child Workflow references require exact package dependency pins; a floating child `workflowId` is not sufficient for packaged authoring.

## Security invariants

1. Caller provenance is not permission.
2. Package metadata is not authorization.
3. Workflow activation is a lifecycle action owned by Workflow, not Event/Model/Scheduler.
4. External/destructive effects remain governed by their existing capability/approval owner.
5. Runs bind exact Workflow content identity.
6. Unknown external-effect outcome reconciles before retry.
7. Event and Scheduler do not duplicate Workflow execution state.
8. Workflow packages contain no secrets.
9. Package updates do not hot-swap already-running Workflow semantics.
10. Runtime release/switch/restart is outside Workflow package lifecycle.

## Non-goals

- Building a second Plugin Runtime inside Workflow.
- Making models mandatory for Workflow execution.
- Encoding complex Workflow graphs inside Event Rule DSL.
- Treating Scheduler as the owner of long-lived Workflow state.
- Using package install as implicit activation.
- Allowing package import/export metadata to grant permissions.
- Replacing existing Process, Lease, Receipt, Capability, or authorization authorities.
