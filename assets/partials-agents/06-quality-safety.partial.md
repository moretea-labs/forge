## Quality & Safety

### Verification Gate
- Never mark work done without current verification evidence for the exact candidate.
- Run impact-based type/tests/lint/build checks through Forge Process Runtime.
- High-risk or architecture-changing work requires the current Engineering Design contract and independent implementation review evidence.
- If a Plan is involved, verify its declared acceptance criteria and predecessor-obligation continuity; do not infer semantic acceptance from passing commands alone.

### Safety Rules
- Do not silently expand scope beyond the user/Work/Plan authority.
- Preserve single-writer, authorization, resource fencing, replay/idempotency, and lifecycle cleanup boundaries.
- Unexpected unrelated dirty work is placement/ownership evidence: isolate or reconcile it rather than absorbing it.
- Prefer strengthening an existing general capability over adding incident-specific helpers or parallel lifecycle owners.

### Final Response Contract
1. What changed
2. Verification actually run
3. Residual blockers/risks
