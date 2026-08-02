# Reliability release fix

## Scope

Fix Process Runtime lease recovery after terminal completion and make Stable Supervisor rollout source selection explicit and auditable.

## Decisions

- Startup recovery scans bounded durable process records because terminal records are removed from `active-index.json` before lease cleanup is guaranteed.
- Lease cleanup matches repository, fencing token, lease id, resource key, and available checkout/work scope; `leasesReleased` is persisted only after the expected lease set is absent.
- Managed process records capture the writer epoch, generation, and runtime instance when available. A live PID with a mismatched identity is left untouched for the owning runtime.
- Explicit rollout paths stage from the selected checkout and persist `repoRoot` plus source identity (`repoId`, `checkoutId`, source path, expected HEAD, and release revision). Source HEAD and runtime dirtiness are rechecked before activation.

## Verification

- Added regression coverage for the terminal/index gap, multi-checkout selection, generation/instance mismatch, source identity persistence, and source HEAD/dirty drift.
