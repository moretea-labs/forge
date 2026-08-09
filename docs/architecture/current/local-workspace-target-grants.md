# Local Workspace Target Grants

## Authority

Repository-free local directory access uses one authority:

```text
controllerHome/system/local-system/targets.json
```

The `local_system` plugin created this authority. The reusable implementation now lives in `src/runtime/workspace-targets/`; the plugin is an adapter over that core. No second Ephemeral Workspace store, Repository Registry shadow record, or route decision store is permitted.

## Grant identity

A target grant authorizes one existing absolute directory for a bounded period. New grants record:

- canonical root path;
- read-only or read-write access;
- owner scope derived from the authenticated principal propagated by the execution entrypoint;
- optional Controller instance identity for audit;
- deterministic workspace identity and full identity fingerprint;
- read-only Git detection;
- creation, expiry, and reason.

The workspace identity derives from canonical root, owner scope, access mode, schema version, and authority name. It is stable across retries and Controller restarts but is not a `repoId`.

Historical schema-v1 records containing only `targetKey`, `rootPath`, timestamps, and reason remain readable. They are interpreted as `read_write` and `legacy:shared` until their original expiry. Historical audit data is not bulk rewritten.

The store and every record are validated before use. Unreadable JSON, malformed records, invalid timestamp ranges, or a persisted identity that no longer matches canonical root, owner scope, and access fail closed without rewriting the evidence. Git metadata is rediscovered on read rather than trusted as a permanent snapshot.

New owner isolation must use the authenticated MCP/controller principal, not a generic tool name or request id. The Gateway adapter is responsible for propagating that principal into the plugin execution origin. Until a trusted principal is available, generic Controller actors are normalized to the explicit `controller:shared` scope; they never claim per-user isolation.

## Filesystem boundary

All plugin file paths and future command working directories must use the same core resolver. It rejects:

- absolute child paths;
- lexical traversal outside the grant root;
- existing symlinks that escape the root;
- non-existing destinations whose nearest existing ancestor escapes the root;
- missing or non-directory command working directories;
- writes through read-only grants.

The resolver re-canonicalizes the root at use time. A moved, deleted, or replaced root fails closed. Grant-store mutations use the existing global Controller Lock and fail with retryable contention instead of silently losing concurrent updates.

Explicit revocation uses the same owner-scoped authority and Controller Lock. It removes only the caller-owned active grant; the next read, write, or command fails closed as unavailable. Revocation is recorded through the normal plugin action receipt and local-effect Work lineage rather than a second audit store.

## Git behavior

Git discovery is read-only and recognizes:

- a repository root with a `.git` directory;
- a linked worktree root with a `.git` file;
- a directory nested inside an existing repository;
- a non-Git directory.

Authorizing a target never runs `git init`, registers a repository, adopts a dirty workspace, or creates a Work.

## Execution integration

A Target Grant supplies workspace facts and path authorization only. It does not decide execution mode and does not authorize arbitrary commands.

- Route Policy remains the only direct-versus-durable and executor authority.
- Mutations still require Work lineage, current owner identity, policy/route evidence, base workspace fingerprint, verification, and a final receipt.
- The existing repository command classifier and approval policy must be reused when command execution is wired to Target Grants.
- Repository-wide Git refs, Issue ownership, release operations, and long-lived repository defaults still require explicit Repository Registry promotion.
- Single-file deletion is a dedicated root-bounded action with strong confirmation and a durable receipt. Recursive/directory deletion and arbitrary `rm` execution remain unavailable.

This boundary enables repository-free local work without weakening command policy or introducing a parallel lifecycle owner.
