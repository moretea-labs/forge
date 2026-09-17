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

The normal Controller hot path receives one compact `ActivationPack`; it does not simulate association with repeated MCP `memory.search` calls. Legacy Experience is admitted as transient candidates and de-duplicated by id. Model-facing projection stays semantic typed JSON/text because ChatGPT consumes semantics, while machine-native binary/index encodings remain internal.

## Consolidation and compression

Consolidation compresses **representation**, not provenance. Repeated memories may produce a warm pattern/concept candidate plus `derived_from` edges, but source memories remain addressable. Original evidence or CAS payload can be expanded when a summary is disputed, stale or insufficient.

Hot/warm/cold are retrieval/retention hints, not three durable authorities. Working memory is intentionally small; long-term storage is not capped to an arbitrary `1000` learned facts. Capacity pressure is handled by compact indexes, CAS de-duplication, consolidation and bounded activation rather than deleting knowledge merely to imitate human forgetting.

## Transport and encoding

Internal representation may use SQLite native columns, BLOBs, compact graph structures, vector encodings, bitmaps, varints or other machine-oriented formats when benchmarks justify them. The ChatGPT/MCP boundary remains compact semantic structured data. Base64-wrapped bytecode or machine code is not a model-facing optimization.

The performance target is the complete path: large long-term memory -> bounded local association -> small high-relevance working-memory pack -> one Controller context injection. Serialization micro-optimizations are subordinate to recall quality, round-trip count, latency and context bytes.

## Evolution boundary

This foundation supplies memory and learning primitives, not uncontrolled self-modification. Future strategy evolution follows evidence-backed candidate -> shadow/canary/A-B -> promotion receipt. Architecture-level recurring patterns create normal Requirement/Plan/Work changes and pass existing review/verification authority before integration.
