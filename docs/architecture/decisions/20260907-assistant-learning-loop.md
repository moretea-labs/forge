# Assistant learning loop

Status: Accepted implementation decision; live promotion certification remains required after focused implementation validation.

Implementation note: Xiaohongshu platform-specific publishing choreography is migrated into versioned Workflow assets; Core retains only generic Workflow execution, reconciliation, evidence, and learning authorities; this decision document is not an operational state store.

2026-09-17 evolution: this loop is now a compatibility producer/consumer of the generic Cognitive Plane. `ExperienceRecord` remains canonical during migration and is transiently adapted at recall; it is not copied into a second durable memory authority. General cognition is defined by `20260917-cognitive-memory-foundation.md` and is not limited to publication outcomes or failures.

Forge self-defect observed during this delivery: an accidentally isolated Work was terminalized before its active controller lease was released, so cleanup was blocked until a separate controller_release; a subsequent maintenance diagnosis also reported accumulated terminal edit-session/temp ownership records. Treat this as one lifecycle-cleanup root-cause family rather than adding per-call workarounds. Maintenance diagnosis for this state took 25-35 seconds despite no source investigation, so cleanup ownership cardinality is also a performance concern. Track under the existing lifecycle-cleanup/maintenance root-cause issue if present; otherwise create one before this delivery closes. Do not create a duplicate authority for the same defect family.

The accepted user outcome is two consecutive, evidence-linked assistant rounds for one explicitly bound project/account. The first-party Xiaohongshu workflow is the concrete certification case for this implementation; production execution must enter through rh_work rather than direct platform choreography, with Workflow Runtime as the sole external-effect owner and canonical receipt producer. Operational priors remain mechanical only. Controller reasoning produces observations, hypotheses and lessons; no autonomous compiler, scheduler, authorization owner or database is introduced.

## Ownership and persistence

Kernel Memory owns the experience contract and application service. Its Controller Home adapter is the sole writer of `assistant_experience` records, scoped by portable project identity, with version 1 payloads, transactional revision CAS and bounded provenance. The active Controller claim authorizes writes; source Work/round and retained evidence must match the requested lineage. Observations default to 30 days and hypotheses to 90 days. Lessons require expiry or explicit durable applicability rationale. Supersession and retraction are terminal for recall; audit history remains in the existing SQLite audit authority. Central maintenance invokes bounded retirement after expiry/retraction grace. No chat-history reconstruction is allowed.

Outcome observations are typed evidence linked to an existing Work and retained receipt, not a campaign lifecycle. Missing metrics are explicit null values with reasons; cumulative snapshots are never summed automatically. Source removal invalidates dependent recall. Payloads are metadata-only and exclude credentials, cookies, binaries and raw logs. Schema rollback is whole Runtime plus its paired Controller Home backup.

## Context and trust

Project contracts register exact knowledge sources. Repository mirrors remain projections of their repository originals; independent Brain documents retain their own authority. Context reads only registered sources within explicit roots, with realpath containment, bounded bytes/time/candidate counts, content digests and visible gaps. Chinese lexical retrieval is supported. Retrieved text and experience are advisory data, never instructions granting authority or weakening current task constraints. No persistent search index is required in v1.

Provider-neutral round preparation composes bounded context; host adapters only render it. Current Work and project identity must be revalidated after claim. Knowledge failure cannot silently permit a publish that needs missing product constraints. Account/channel applicability is exact; omission never widens access to account-specific experience.

## Workflow and recovery

Preserve Workflow migration B/C/D/E obligations. The interpreter remains subordinate to Work, Process, provider effects and existing resource fencing. Outputs referenced by later steps must be retained with checkpoint identity. An effect dispatched before checkpoint failure is reconciled through the existing receipt authority before replay. Assets pin version/digest and inputs; changing them cannot reuse a run. Site choreography stays versioned asset data.

## Concurrency, time and capacity

All experience mutations run in one SQLite transaction with expected revisions and bounded rows per project. Explicit timestamps drive expiry and tests; invalid/future observations fail validation. Reads filter scope before ranking and share existing Context item/byte/token ceilings. Read failures are visible gaps. Central lifecycle maintenance owns physical cleanup; retrieval does not become another persistent writer. No new process, cross-node replication or provider identity is introduced.

## Delivery and retirement

Execution-quality observations reuse ControllerRound semantic fingerprints and exact check evidence. They are bounded advisory signals, not a `normal/degraded` persistent state or a second Supervisor. Legitimate wait/investigation is not failure; same-source pass/fail indicates possible flakiness, not proven code regression. Controller diagnosis and accepted design return-to-design gates retain semantic authority. Cross-task strategy A/B remains the existing benchmark's responsibility; differing task difficulty cannot establish policy superiority.

Keep existing operational-memory semantics and Workflow acceptance obligations. Replace modern Brain promotion's deleted-file inference with terminal Work evidence; retain old Git import only behind an explicit legacy flag until consumers migrate. No partial Runtime activation is part of this change. Focused fault tests and whole-candidate gates precede delivery; actual two-round publication and metrics evidence precede the claim that live assistant capability is complete.
