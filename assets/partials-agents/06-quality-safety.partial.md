## Quality & Safety

### Verification Gate
- Never mark work done without current verification evidence for the exact candidate.
- Run impact-based type/tests/lint/build checks through Forge Process Runtime.
- High-risk or architecture-changing work requires proportionate current source/test review and explicit handling of real safety or external-effect risks; no Engineering Design contract is required.
- If a Plan is involved, verify its declared acceptance criteria and predecessor-obligation continuity; do not infer semantic acceptance from passing commands alone.

### Safety Rules
- Do not silently expand scope beyond the user and the project's existing Requirement/Issue authority.
- Preserve authorization, precise resource fencing, Git/CAS conflict safety, replay/idempotency, external-effect reconciliation, and real lifecycle cleanup boundaries.
- Unexpected unrelated dirty work is placement/ownership evidence: isolate or reconcile it rather than absorbing it.
- Prefer strengthening an existing general capability over adding incident-specific helpers or parallel lifecycle owners.

### Final Response Contract
1. What changed
2. Verification actually run
3. Residual blockers/risks
