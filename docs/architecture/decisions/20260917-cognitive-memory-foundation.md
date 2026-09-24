# Generic Cognitive Plane and associative memory foundation

Status: Accepted and implemented Kernel V2 architecture foundation. Ongoing evolution must preserve the single Cognitive authority, bounded recall, and advisory-only policy boundary.

## Problem

The previous assistant learning loop persisted bounded `ExperienceRecord` and `OutcomeObservation` facts and reused them through lexical context injection. That is useful operational memory, but it is not a general learning substrate: it over-centers error/outcome feedback, stores most meaning as prose, has weak cross-memory association, and makes the model perform too much recall work through context/tool round trips.

Forge needs a domain-independent cognitive substrate that can learn from good examples, successful practice, explicit knowledge, novelty, corrections, contradictions, preferences, principles and procedures as well as failures. It must improve retrieval and information density without creating a second lifecycle/authority system.

## Learning admission is not authority promotion

Forge follows **learn early, trust gradually**. The model decides whether an observation would change future similar judgement/action and therefore deserves advisory memory. Repeated independent evidence may justify stronger confidence or a broader abstraction, but Forge never converts a repetition count, kind, keyword, score or failure frequency into semantic admission/generalization authority.

`LearningSignal.admissionSource` records provenance (`explicit_human`, `controller_observation`, `verified_outcome`, `execution_quality`, or `system_inference`); `kind` is open descriptive vocabulary; `portability` records semantic intent, not policy authority. Project-specific learning normally stays Project-local. When the model explicitly judges a distilled lesson genuinely cross-project, it may author Workspace advisory memory with portable intent regardless of admission-source category. Forge validates reachable scope/provenance/evidence and mechanical resource bounds only; it never auto-promotes a memory.

Confidence and utility are deliberately orthogonal. `confidence` measures evidentiary/semantic strength of the claim. `utility` is the initial retrieval-usefulness prior and may later be adjusted by context usage feedback without changing factual confidence. `salience` is only extraction-time importance. None of these scores grants policy authority.

Cognitive Memory remains advisory. Hard invariants continue to live in normal repository/project authority such as AGENTS, project contracts, architecture decisions, Requirements, Plans, Work acceptance, authorization, and verification gates. Learning never promotes itself into those authorities.


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

`LearningSignal` makes learning trigger-neutral. Kinds such as knowledge, success, failure, novelty, correction, contradiction, pattern, preference, principle and procedure are useful descriptive examples, not a closed taxonomy or admission list. Failure is one possible observation source, not the definition of learning.

## Retrieval and working memory

One bounded associative activation path combines stable-id seeds, exact concepts, lexical candidates, optional semantic/vector candidates, graph spreading, recency, confidence, utility and usage feedback. Automatic learning relates bounded candidate memories with `supports`, `contradicts`, `analogous_to` or directional `supersedes` edges while consolidated patterns retain `derived_from` provenance. Direct semantic cueing controls opportunistic eligibility; graph/confidence/utility rank or explain already-cued candidates. Candidate, depth, item and byte budgets are mechanical retrieval bounds, never semantic sufficiency thresholds.

The normal Controller hot path receives one compact initial `ActivationPack`; it does not simulate association with repeated MCP `memory.search` calls. The model decides whether that working set is enough. If not, the same `rh_context` surface supports progressive semantic expansion through a narrower query or explicit `knowledge_query`/`knowledge_limit`; routine micro-steps reuse the current set. Legacy Experience is admitted as transient candidates and de-duplicated by scope-qualified memory identity, never by bare id. Model-facing projection stays semantic typed JSON/text because ChatGPT consumes semantics, while machine-native binary/index encodings remain internal.

Scope-qualified identity survives the entire model-facing boundary: activation, AssistantContext item identity, ControllerRound snapshot and usage accounting all use the same scope-qualified memory address, so equal bare ids in different Work/Requirement/Plan/Project scopes cannot collide. Project knowledge is optional enrichment rather than a prerequisite for Cognitive recall; Work/Requirement/Plan memory remains available without a Project binding, while repository/project knowledge sources still require an explicit Project identity.

Temporal validity is part of candidate selection, not merely post-selection filtering. Canonical SQL reads exclude retracted, expired and not-yet-valid memories/edges before bounded `LIMIT` is applied, preventing inactive rows from starving live recall. If canonical memory exists while concept/term projections are missing or structurally corrupt, the cognition persistence owner rebuilds those derived indexes from canonical memory before normal activation proceeds and records the recovery in activation gaps.

## Consolidation and compression

Consolidation compresses **representation**, not semantics or provenance. Related traceable memories may form a warm consolidated representation plus `derived_from` edges, but Forge does not invent a higher-level abstraction or decide a broader scope. Independent repetition is evidence the model may use when distilling/generalizing; there is no fixed repeat threshold for local learning or Workspace generalization. Source memories stay addressable, and original evidence or CAS payload can be expanded when a summary is disputed, stale or insufficient.

Hot/warm/cold are retrieval/retention hints, not three durable authorities. Working memory is intentionally small; long-term storage is not capped to an arbitrary `1000` learned facts. Capacity pressure is handled by compact indexes, CAS de-duplication, consolidation and bounded activation rather than deleting knowledge merely to imitate human forgetting.

### Cross-project promotion

Portable `WorkspaceIdentity` is the existing cross-Project semantic boundary; no `global`/organization memory scope or second policy store is introduced. Project onboarding happens through the normal semantic placement path rather than repository registration. An authored `.forge/project-engineering.json` `projectId` is preferred; a canonical Git remote contributes a portable source fingerprint and becomes the stable Project-id source only when no authored project id exists. Later admissions preserve an existing Project's Workspace and reject source aliases or conflicting ForgeInstance-local placements rather than rebinding. Project-local observations should be distilled into Project lessons. Workspace advisory memory is written only when the model explicitly chooses Workspace scope plus portable intent because the abstraction is genuinely cross-project; this decision may be based on one strong source or many independent observations, but Forge has no automatic promotion formula.

Workspace memory remains advisory learned guidance and acquires no lifecycle, policy or acceptance authority. Forge never turns repeated failures, categories, scores or consolidated clusters into a Workspace lesson or Requirement candidate on its own. If learned knowledge implies a durable product/architecture change, the model/user explicitly enters the existing Requirement/Plan/Work authority. Project product/domain contracts, authored architecture, authorization and verification gates remain higher semantic authority and are never rewritten by learning.

Work-bound learning may be recorded at Controller-round closure but is not Controller lifecycle authority; lifecycle-free `learning_record` handles ordinary Project/Workspace learning. The active model emits typed semantic deltas, possibly in multiple transport-bounded batches; Forge derives source identity/time, validates scope/provenance/evidence and persists them without deciding their semantic meaning. If post-disposition learning fails, the already-durable disposition remains authoritative and the failure must be surfaced explicitly for repair; it must not be hidden as an ordinary skipped lesson, and it must not roll back or replay the semantic disposition.

## Usage feedback and audit

`assistant_context_usage` is canonical ControllerRound evidence about whether each exact claim-time context item was used or rejected. It does not mutate factual confidence merely because an item was useful or irrelevant. A bounded rebuildable projection feeds future activation: `used` raises retrieval applicability, ordinary rejection lowers applicability, and stale/contradicted rejection contributes an explainable conflict penalty. Confidence changes only through supporting/counter evidence. The projection is scope-qualified, Project-aware, deterministic and idempotent; no second usage truth table is introduced.

`rh_context operation=search` is the read-only Cognitive audit surface. Explicit `knowledge_*` filters can inspect memory by reachable scope, concept, facet, source, source Work or exact memory id and return canonical provenance/confidence/utility/evidence/counter-evidence, relations/supersession, recent usage and query-time activation reasons/path. Knowledge-only audit may run without source-code retrieval; mixed audit never contributes to `ContextClosureReceipt` or mutation readiness. Audit is advisory observation, not write/lifecycle authority.

## Transport and encoding

Internal representation may use SQLite native columns, BLOBs, compact graph structures, vector encodings, bitmaps, varints or other machine-oriented formats when benchmarks justify them. The ChatGPT/MCP boundary remains compact semantic structured data. Base64-wrapped bytecode or machine code is not a model-facing optimization.

The performance target is the complete path: large long-term memory -> bounded local association -> small high-relevance working-memory pack -> one Controller context injection. Serialization micro-optimizations are subordinate to recall quality, round-trip count, latency and context bytes.

## Evolution boundary

This foundation supplies memory and learning primitives, not uncontrolled self-modification. Strategy evolution follows learned recurring pattern -> normal Requirement/Plan/Work -> isolated candidate -> shadow/canary/A-B -> promotion receipt -> implementation review/verification/finalization. The promotion receipt is a deterministic, immutable evaluation attestation, not lifecycle or mutation authority: it is minted only by re-evaluating the existing frozen paired A/B and operational-shadow evidence (and, when supplied for release-level changes, the existing V2 certification manifest), and any regressed/inconclusive blocking evidence prevents minting. The receipt has no clock-driven state, store, scheduler, policy writer, source writer, Requirement-creation authority, or approval authority. It is delivered only through the trusted evaluator channel and becomes an exact `WorkImplementationReviewRecord.architectureEvidence` identity for the same candidate revision; raw MCP review arguments cannot inject arbitrary architecture evidence. Finalization compares the already-reviewed immutable architecture evidence through the existing implementation-review stale gate. Requirement/Plan/Work, Controller review, verification and finalization remain the only change authorities.
