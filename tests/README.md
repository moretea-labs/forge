# Test Directory Structure

Tests are risk-focused verification evidence for Forge. They protect observable behavior and architecture invariants; they are not a second implementation or an alternate architecture authority.

## Governance

`tests/test-manifest.v1.json` registers every test exactly once with a module and resource class. `scripts/test-governance.ts` uses that metadata to select affected tests and to keep conflicting resource classes from running unsafely in parallel.

Prefer extending an existing test when it protects the same obligation. Add a new file when it represents a distinct risk boundary. Retired implementation or compatibility behavior should not be preserved solely because an old test exists.

High-value coverage includes process ownership/termination, repository and worktree fencing, Runtime lifecycle/recovery, authorization and external effects, context-routing semantics, test/check scheduling, package/install behavior, and essential integration/E2E paths.

## Running tests

```bash
bun run test                 # affected tests selected from current changes
bun run test:core            # core smoke/pure coverage
bun run test:integration     # explicit integration diagnostic
bun run test:infrastructure  # process/port/worktree/singleton lanes
bun run test:fault           # destructive/adversarial lane
bun run test:full            # explicit broad non-destructive diagnostic
bun run test:coverage        # explicit exhaustive coverage
bun run check:task           # task candidate gate
bun run check:main           # main candidate gate
bun run check:release        # release candidate gate
bun run check:test-governance
```

Full testing is explicit rather than the default completion ritual. During development, run the smallest checks that can expose the current risk; at candidate boundaries, run the authoritative gate required by the changed surface.

Checkpoint reuse must be content/toolchain/capability-addressed and auditable. Infrastructure failures may retry only under the governed runner's policy; source assertion failures are not hidden by retries.
