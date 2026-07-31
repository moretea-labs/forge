# Checkout route integrity (P0)

## Fail-closed pre-spawn guard

Before Process Runtime spawns any managed process, an immutable `ResolvedExecutionIdentity`
must match:

- requested `repoId` / `checkoutId`
- registered checkout lifecycle and realpath root
- process `cwd` realpath inside the expected root
- Git top-level equal to expected root
- Git common-dir ownership of the registered repository
- optional branch / expected HEAD from WorkHandle

Mismatch codes include `EXECUTION_IDENTITY_MISMATCH`, `CHECKOUT_ROUTE_MISMATCH`,
`GIT_TOPLEVEL_MISMATCH`, `GIT_COMMON_DIR_MISMATCH`, `WORK_HANDLE_BRANCH_CHANGED`,
and `WORK_HANDLE_HEAD_CHANGED`. There is no silent fallback to main or another checkout.

## Legacy WorkContract migration

Legacy contracts may bind only through a unique exact WorkHandle match
(`resolveLegacyWorkContractIdentity`). Ambiguous or incomplete identity is rejected.
