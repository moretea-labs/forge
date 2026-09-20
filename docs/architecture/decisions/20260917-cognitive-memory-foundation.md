# Generic Cognitive Plane and associative memory foundation

Status: Accepted architecture foundation; candidate implementation requires post-rebase verification before V2 integration.

## Problem

The previous assistant learning loop persisted bounded `ExperienceRecord` and `OutcomeObservation` facts and reused them through lexical context injection. That is useful operational memory, but it is not a general learning substrate: it over-centers error/outcome feedback, stores most meaning as prose, has weak cross-memory association, and makes the model perform too much recall work through context/tool round trips.

Forge needs a domain-independent cognitive substrate that can learn from good examples, successful practice, explicit knowledge, novelty, corrections, contradictions, preferences, principles and procedures as well as failures. It must improve retrieval and information density without creating a second lifecycle/authority system.

## Authority boundary

The Cognitive Plane owns knowledge representation, association, consolidation and model projection. It does **not** own Requirement, Plan, Work, ControllerRound, Scheduler, safety, authorization, acceptance or repository lifecycle decisions. A cognitive record can advise a Controller; it cannot terminalize Work, bypass fencing or mutate hard policy.

Cognitive writes pass through an application `CognitiveWriteAuthorityPort` supplied by trusted composition. Controller-origin writes reuse the existing exact Work/Controller-round authority and evidence checks. Persistence helpers are not a transport-facing write authority. MCP does not receive a parallel `memory.*` lifecycle.

## Canonical storage

Canonical cognitive metadata stays in the existing Controller SQLite authority. Memory units, evidence references and graph edges use structured tables instead of duplicating whole records into generic JSON payloads. Large immutable content is content-addressed under a SHA-256 CAS and referenced by digest/size/media type.

There is one durable truth. Existing `ExperienceRecord` remains a compatibility authority during migration and is projected transiently into `MemoryUnit` at recall; it is not copied into a second durable cognition row. New generic memories use the cognition store directly through the authority-bearing application service.

Derived concept/term indexes are rebuildable projections. Future vector/ANN, compact adjacency, bitmap, Float16/BLOB or other machine-native indexes follow the same rule: they may accelerate recall but never become a second truth. Corrupt/missing derived indexes are rebuilt from canonical memory.

## Representation

`MemoryUnit` is the high-information-density knowledge atom. It carries stable identity, scope, open facets, concepts, concise canonical text, provenance/evidence, confidence, utility, temporal validity, counter-evidence and a hot/warm/cold tier hint. Facets are descriptive rather than a lifecycle enum, allowing one unit to be both a principle, procedure and successful pattern.

`MemoryEdge` represents explicit relations such as `supports`, `contradicts`, `causes`, `derived_from`, `supersedes` or `analogous_to`. Relation vocabulary is open but validated. `CognitiveIR` is the machine-readable semantic boundary between durable knowledge and model projection; it is not CPU bytecode and does not replace provenance.

`LearningSignal` makes learning trigger-neutral. Supported signals include knowledge, success, failure, novelty, correction, contradiction, pattern, preference, principle and procedure with positive/negative/neutral valence. Failure is one signal, not the definition of learning.

## Retrieval and working memory

One bounded associative activation path combines stable-id seeds, exact concepts, lexical candidates, optional semantic/vector candidates, graph spreading, recency and utility. Graph traversal is bounded by candidate, depth, item and byte budgets. Returned items include reasons and activation paths so recall is explainable.

The normal Controller hot path receives one compact `ActivationPack`; it does not simulate association with repeated MCP `memory.search` calls. Legacy Experience is admitted as transient candidates and de-duplicated by scope-qualified memory identity, never by bare id. Model-facing projection stays semantic typed JSON/text because ChatGPT consumes semantics, while machine-native binary/index encodings remain internal.

Scope-qualified identity survives the entire model-facing boundary: activation, AssistantContext item identity, ControllerRound snapshot and usage accounting all use the same scope-qualified memory address, so equal bare ids in different Work/Requirement/Plan/Project scopes cannot collide. Project knowledge is optional enrichment rather than a prerequisite for Cognitive recall; Work/Requirement/Plan memory remains available without a Project binding, while repository/project knowledge sources still require an explicit Project identity.

Temporal validity is part of candidate selection, not merely post-selection filtering. Canonical SQL reads exclude retracted, expired and not-yet-valid memories/edges before bounded `LIMIT` is applied, preventing inactive rows from starving live recall. If canonical memory exists while concept/term projections are missing or structurally corrupt, the cognition persistence owner rebuilds those derived indexes from canonical memory before normal activation proceeds and records the recovery in activation gaps.

## Consolidation and compression

Consolidation compresses **representation**, not provenance. Repeated memories may produce a warm pattern/concept candidate plus `derived_from` edges, but source memories remain addressable. Original evidence or CAS payload can be expanded when a summary is disputed, stale or insufficient.

Hot/warm/cold are retrieval/retention hints, not three durable authorities. Working memory is intentionally small; long-term storage is not capped to an arbitrary `1000` learned facts. Capacity pressure is handled by compact indexes, CAS de-duplication, consolidation and bounded activation rather than deleting knowledge merely to imitate human forgetting.

### Cross-project promotion

Raw Controller learning remains Work/Project-local. Portable `WorkspaceIdentity` is the existing cross-Project semantic boundary; no `global`/organization memory scope or second policy store is introduced. Project onboarding happens at normal Work admission rather than repository registration. An authored `.forge/project-engineering.json` `projectId` is preferred; a canonical Git remote contributes a portable source fingerprint and becomes the stable Project-id source only when no authored project id exists. The first portable Project defaults to `workspace-personal`; later admissions preserve an existing Project's Workspace and reject source aliases or conflicting ForgeInstance-local placements rather than rebinding. A Project memory may be promoted into Workspace memory only after consolidation has at least three evidence-bearing automatic-learning sources from at least three distinct Controller rounds, and only for Forge engineering concepts such as execution-quality or engineering-blocker patterns. Promotion preserves source evidence and project provenance, while sibling Projects in the same Workspace include the Workspace scope in cognitive activation.

Workspace memory is advisory learned guidance. This bounded scope promotion is only a memory projection and is not the strategy/policy promotion described by the evolution boundary below; it creates no promotion receipt and acquires no lifecycle or acceptance authority. When a promoted pattern represents repeated root cause, regression/correction, or an engineering blocker rather than positive learned guidance, Forge may also materialize one deterministic Workspace `requirement-candidate` memory. Candidate findings remain Cognitive data: they are surfaced to the closing Controller and can be recalled across sibling Projects, but they cannot call Requirement admission, mutate policy/source, or inherit approval authority. Project product/domain contracts, authored architecture, authorization and verification gates remain higher semantic authority and are never rewritten by learning. A single symptom, one Controller round, arbitrary project content or application-specific business knowledge cannot self-promote across Projects. Explicit human-authored engineering rules may be committed directly to repository authority; heuristic learning never impersonates that authority.

Automatic learning is part of Controller-round closure but is not Controller lifecycle authority. If post-disposition learning fails, the already-durable disposition remains authoritative and the failure must be surfaced explicitly for repair; it must not be hidden as an ordinary skipped lesson, and it must not roll back or replay the semantic disposition.

## Transport and encoding

Internal representation may use SQLite native columns, BLOBs, compact graph structures, vector encodings, bitmaps, varints or other machine-oriented formats when benchmarks justify them. The ChatGPT/MCP boundary remains compact semantic structured data. Base64-wrapped bytecode or machine code is not a model-facing optimization.

The performance target is the complete path: large long-term memory -> bounded local association -> small high-relevance working-memory pack -> one Controller context injection. Serialization micro-optimizations are subordinate to recall quality, round-trip count, latency and context bytes.

## Evolution boundary

This foundation supplies memory and learning primitives, not uncontrolled self-modification. Strategy evolution follows learned recurring pattern -> normal Requirement/Plan/Work -> isolated candidate -> shadow/canary/A-B -> promotion receipt -> implementation review/verification/finalization. The promotion receipt is a deterministic, immutable evaluation attestation, not lifecycle or mutation authority: it is minted only by re-evaluating the existing frozen paired A/B and operational-shadow evidence (and, when supplied for release-level changes, the existing V2 certification manifest), and any regressed/inconclusive blocking evidence prevents minting. The receipt has no clock-driven state, store, scheduler, policy writer, source writer, Requirement-creation authority, or approval authority. It is delivered only through the trusted evaluator channel and becomes an exact `WorkImplementationReviewRecord.architectureEvidence` identity for the same candidate revision; raw MCP review arguments cannot inject arbitrary architecture evidence. Finalization compares the already-reviewed immutable architecture evidence through the existing implementation-review stale gate. Requirement/Plan/Work, Controller review, verification and finalization remain the only change authorities.
