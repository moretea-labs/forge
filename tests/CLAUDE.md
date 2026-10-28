# Functional Block Agent Context

Keep tests/AGENTS.md and tests/CLAUDE.md aligned.

## Test boundary — acceptance-first (2026-10-29)

The old temporary prohibition on new test files and test cases is withdrawn. New focused tests are explicitly allowed when they prove a current user-visible acceptance criterion, a reproduced regression, or a high-risk safety/liveness invariant. Prefer extending nearby tests; new files are fine when isolation is better. Maintain test-manifest governance; do not delete still-valid behavior tests merely to meet a size target.

For regression fixes: identify the previously working behavior and current failure; reproduce RED via deterministic fault injection or an actual failing receipt; implement the smallest GREEN fix; run existing adjacent safety/liveness tests and review the complete diff. A mock/ledger PASS does not prove real Chrome→ChatGPT→Supervisor delivery.

For unattended continuation use docs/architecture/CURRENT.md. Preserve no wrong-tab or duplicate external Send AND progress of legitimately blocked effects. Certify the live loaded Chrome extension, native-host broker, exact conversation, and causal assistant receipts before claiming restored automation.

Retire only obsolete architecture/implementation-shape assertions, not valid Process, Git/CAS, effect/idempotency, recovery or release contracts. Distinguish code, integration, deployed worker and live behavior as PASS, FAIL, NOT RUN or BLOCKED. Run targeted tests in the inner loop and proportionate E2E at a release boundary.
