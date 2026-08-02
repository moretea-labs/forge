# Test Directory Structure

Tests are a small, risk-focused safety net for a repository tool. They are not
an alternative implementation or a reason to preserve every historical path.

## Asset Hierarchy

## Growth budget

- The manifest budget is 80 test files and 40,000 test lines.
- A new test normally extends an existing file; adding a file requires deleting
  or merging an equivalent test and staying inside the manifest budget.
- Test one observable risk or contract per case. Do not test private helpers,
  source formatting, or historical version snapshots unless they protect a
  current compatibility boundary.
- Keep process termination, PID ownership, worktree fencing, Controller
  lifecycle, and package-install smoke coverage. These are the repository's
  highest-cost failure modes.
- `test:full` is an occasional manual diagnostic, never a merge requirement.
  Ordinary checks must remain affected and bounded.

## Rules

- Test code quantity ≥ Implementation code quantity
- Test failure = Delete module and rewrite
- Never modify tests to make buggy code pass

## Running Tests

```bash
bun run test                         # affected: smoke + changed modules' pure tests
bun run test:core                    # core smoke and pure state-machine tests
bun run test:integration             # explicit changed-module integration diagnostic
bun run test:infrastructure          # process/port/worktree/singleton lanes
bun run test:fault                   # destructive/adversarial lane only
bun run test:full                    # every non-destructive test
bun run test:coverage                # explicit exhaustive coverage
bun run check:task                   # type + architecture + affected
bun run check:main                   # focused candidate receipt; never full
bun run check:release                # main receipt + one packaged tarball smoke
```

`test:full` is a manual diagnostic. Task, main, CI, and release gates never
invoke it implicitly.

`tests/test-manifest.v1.json` assigns every test exactly one module and one
resource class. Safe `pure` tests run eight-wide, `temp-isolated` tests run
four-wide, and risky resources stay serial with one Bun process per file.
The selector reports changed paths, mapped modules, and the selected count;
unknown paths map conservatively and never trigger an implicit full suite.

Each file writes a content/toolchain/capability checkpoint. Only
infrastructure failures retry once in a fresh process. Source assertions and
fixture/flaky markers do not retry. The runner also rejects wall timeout,
residual process, non-convergence, and tracked-tree mutation as distinct
infrastructure failures.
