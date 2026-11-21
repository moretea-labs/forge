# Checkout route integrity (P0)

## Fail-closed process identity

Before a scoped Process action, Forge verifies an immutable `ResolvedExecutionIdentity` against concrete execution resources:

- the requested `repoId` / `checkoutId` and registered checkout lifecycle
- the checkout realpath and Process `cwd` realpath
- Git top-level and common-dir ownership of the selected repository
- explicit Git branch / revision constraints when the operation requests them

Current mismatch diagnostics include `EXECUTION_IDENTITY_MISMATCH`,
`CHECKOUT_ROUTE_MISMATCH`, `GIT_TOPLEVEL_MISMATCH`, and
`GIT_COMMON_DIR_MISMATCH`. There is no silent fallback to another checkout.

## Retired WorkHandle compatibility

Historical `WorkContract` / `WorkHandle` records are audit-only. They do not
supply new Process execution identities, authorize branch selection, determine
Writer ownership, or block an otherwise valid repository operation.
`WORK_HANDLE_BRANCH_CHANGED` / `WORK_HANDLE_HEAD_CHANGED` identify historical
diagnostics; they are not current pre-spawn prerequisites. Legacy
`resolveLegacyWorkContractIdentity` lookups, where still supported, must remain
read-only and fail closed on ambiguous historical identity.
