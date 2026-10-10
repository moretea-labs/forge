# Exact code-symbol discovery within bounded Context retrieval

`docs/architecture/CURRENT.md` remains the sole architecture authority. This note records a focused Context Plane implementation decision and test contract; it adds no store, cache, result state, or secondary search authority.

## Observed defect

A request containing two exact source symbols could split them into common word fragments or treat both as one literal query. Early broad matches then filled the candidate window and prevented later exact hits from entering. Separately, the Git inventory's alphabetic first-800-file cap made files beyond that prefix unsearchable by the lexical pass. Increasing the scan cap would add disk/CPU cost without fixing symbol priority.

## Existing-authority correction

- Parse explicit code-shaped tokens into independent bounded exact queries. Preserve caller-provided ordinary literal phrases (`return 42`) as search queries as well. Keep camel-case fragments as nonbinding discovery hints, not mandatory matches.
- Preserve later exact hits when broad candidate capacity is reached, and reserve the highest-ranked candidate for each matched exact symbol before ordinary ranked results.
- Use Git's read-only tracked-file grep only to **prioritize candidate paths** when the inventory exceeds the existing scan cap. The original policy-checked repository source matcher validates each file and enforces exact identifier boundaries. Git grep supplies no policy, semantic completion, persistence, or source identity authority.
- Apply equivalent search admission and cache identity in synchronous and asynchronous Context paths. Neither path increases the existing actual-file scan cap or accepts forbidden paths from Git hints.
- Context results remain bounded evidence, not completeness proof. Git hints may omit untracked files and max-files/snippet caps still apply; explicit known paths and progressively narrowed source requests remain the existing precise retrieval surfaces.

## Verification

Regression fixtures place two complete symbol declarations after more than 800 broad distractors, with multiple longer-prefix false positives. Both synchronous and asynchronous Context materialization must select the two exact target files and inspect fewer than 30 candidate source files. Process Runtime timeout observations independently release monitor waiters and abort listeners, with no post-timeout cancellation of a live command.
