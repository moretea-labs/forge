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

## Retired Work identity

Work / WorkHandle / WorkContract are fully retired. They do not supply Process
execution identities, authorize branch selection, determine Writer ownership,
or block an otherwise valid repository operation. Historical Work diagnostics
such as `WORK_HANDLE_BRANCH_CHANGED` / `WORK_HANDLE_HEAD_CHANGED` are not
current pre-spawn prerequisites. There is no live
`resolveLegacyWorkContractIdentity` path.
