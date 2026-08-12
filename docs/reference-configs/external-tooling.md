# External Tooling

Forge core correctness does not depend on third-party host skills. The default workflow is owned by Forge `/direct`, `/plan`, `/debug`, `/review`, `/release`, and `/scale`, plus Runtime repository/process/context primitives.

Optional enhancements:

- `gstack`: product discovery and deeper engineering/design-plan review;
- `Waza`: optional `/think`, `/hunt`, `/check`, `/health` host skills;
- `gbrain`: optional knowledge tooling;
- `Mermaid` host skill: optional rendered diagrams; Markdown Mermaid remains sufficient;
- Forge peer-review helpers (`codex-review`, `claude-review`): optional cross-model acceptance evidence;
- CodeGraph host MCP/CLI: optional direct host integration. Forge's own `rh_context` structural backend uses the bundled CodeGraph runtime when available.

`forge install` installs the Forge CLI/runtime and managed host adapters. It does **not** install Waza, Mermaid, or cross-review skills unless `--with-external-skills` is explicitly supplied. `forge setup` is the guided readiness workflow; `forge setup check` is the one-shot read-only report.

`forge uninstall` removes Forge-managed Codex/Claude hook adapters only. It does not remove unrelated third-party tooling or user-authored sibling configuration.

`forge update` refreshes Forge-owned user-level runtime by default. Third-party skill updates remain explicit opt-in work.

External tools are never lifecycle authorities. Missing or stale optional tooling may reduce the named enhancement, but must not block ordinary Forge planning, debugging, review, or execution.

## Detect Safely

Use `bash .ai/harness/scripts/check-agent-tooling.sh` for a read-only tooling report.
Init and migration reports run the detector without update checks by default;
set `FORGE_CHECK_TOOLING_UPDATES=1` when that advisory pass should
also compare upstream versions.

Supported flags:

- `--host claude|codex|both`
- `--json`
- `--check-updates`
- `--strict-readiness`

The detector intentionally avoids side-effecting commands. It does not run:

- `gstack setup`
- `npx skills check`
- `npx skills update`
- `gbrain serve`
- `gbrain sync`
- `codegraph init`
- `codegraph sync`
- `codegraph install`

With `--check-updates`, Waza update checks fetch upstream GitHub raw
`SKILL.md` and shared `rules/` files, then compare versions/hashes against each
host path. The detector also compares each host's Waza skill directories and
shared rules against the `~/.agents` staging cache so helper files under
`references/`, `scripts/`, `agents/`, and cross-skill `rules/` links cannot
silently drift. Network failures are reported as `unknown`; the detector never
updates skills.

## Install

### gstack

Claude Code:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup
```

Codex:

```bash
test -d ~/.claude/skills/gstack || git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --host codex
```

### Waza

Both hosts:

```bash
npx -y skills add tw93/Waza -g -a claude-code codex -s think hunt check health -y
```

Single host:

```bash
npx -y skills add tw93/Waza -g -a claude-code -s think hunt check health -y
```

Replace `claude-code` with `codex` when installing for Codex only.

After installing or updating through the skills CLI, verify Codex has its own
runtime copy:

```bash
for d in think hunt check health; do
  rsync -a --delete ~/.agents/skills/$d/ ~/.codex/skills/$d/
done
mkdir -p ~/.codex/rules
for f in anti-patterns.md chinese.md durable-context.md english.md; do
  cp ~/.agents/rules/$f ~/.codex/rules/$f
done
for d in think hunt check health; do
  diff -qr ~/.agents/skills/$d ~/.codex/skills/$d
done
for f in anti-patterns.md chinese.md durable-context.md english.md; do
  cmp -s ~/.agents/rules/$f ~/.codex/rules/$f
done
```

### gbrain

```bash
bun install -g github:garrytan/gbrain
```

Do not install npm registry `gbrain`; that package is unrelated to the GBrain
CLI and does not ship the forge advisory command.

`gbrain` is optional advisory tooling for knowledge sync and retrieval. `setup
check` may report its local state, but missing or stale `gbrain` must not
create Agent repair/update actions or change the setup readiness result.

### CodeGraph

`CodeGraph` has two integration levels. Forge-internal structural retrieval is provided through `rh_context` and the bundled CodeGraph runtime when available. A global `codegraph` CLI or host MCP entry is optional and exists only for direct Codex/Claude use. Neither replaces workflow checks, tests, architecture evidence, or raw source reads.

Forge packages a CodeGraph runtime for its own structural context provider and can ensure the repository index without requiring a user-global CLI. `forge tools configure codegraph` remains an explicit optional host integration.

### Runtime Ownership Boundary

`forge setup open --target <host>` starts or resumes one persistent setup session. Each `forge setup next` reruns the readiness model and exposes one next action; `forge setup close` succeeds only after the session is verified ready. `forge setup check --target <host> --check-updates --json` remains the stateless read-only report. All of these report the execution base as separate `runtime.*` checks. Keep the boundary explicit:

| Capability | Owner | Required for |
|---|---|---|
| `bun` | forge | forge-owned global installs, local dependency install, tests, and runtime execution |
| `bash` | forge | helper scripts, migration, setup checks, and contract verification wrappers |
| `npm` | npm registry | registry readbacks, publish gates, and opt-in update checks; not forge-owned global install repair |
| `npx` / `skills_cli` | external Skills CLI | Waza and Mermaid skill bootstrap/update commands |
| `rsync` | platform filesystem | Waza staging-to-Codex sync and installed-copy runtime mirroring |
| `symlink` | platform filesystem | link-mode aliases; copy mode is the fallback |

The policy is Bun-first, not Bun-only. Forge-owned install/repair commands
use `bun add -g` or `bun install`. Waza/Mermaid remain explicit external Skills
CLI dependencies until a separate plan replaces that integration. Missing
optional capabilities should degrade the named feature, not blur command
ownership.

Installed-copy sync has two explicit modes. `AGENTIC_DEV_LINK_INSTALLED_COPIES=1`
uses symlinks and does not require `rsync`; if symlink creation fails, the
script reports unsupported link-mode and tells the caller to use copy-mode.
`AGENTIC_DEV_LINK_INSTALLED_COPIES=0` uses copy-mode and requires `rsync`; if
`rsync` is missing, the script reports unsupported copy-mode instead of a
generic command failure.

Read-only check:

```bash
codegraph status .
```

Local index mutation:

```bash
codegraph init -i .
codegraph sync .
```

Do not ask users to copy MCP TOML or Claude JSON by hand. The user-facing path
is one terminal command, or explicit authorization for their agent to run the
same command:

```bash
bun add -g @colbymchenry/codegraph && forge tools configure codegraph --target codex --location global
```

This delegates host-specific MCP config to CodeGraph's target adapters for
Codex and Claude, so do not run CodeGraph setup automatically from
`forge install`, `forge adopt`, or explicit tooling configuration. Restart Codex after the installer
finishes so the MCP server is discovered; Claude Code should pick up its config
according to its own settings reload behavior. If a launch environment still
cannot find `codegraph`, an authorized agent should diagnose `PATH` and the
`~/.local/bin/codegraph` shim. Do not make the user hand-edit MCP config as the
fallback.

For troubleshooting only, inspect host config snippets without writing:

```bash
codegraph install --print-config codex
codegraph install --print-config claude
```

Project-local indexes are ignored runtime state:

```bash
codegraph init -i .
codegraph status .
```

Before non-trivial code work, agents should sync the local index and use it for
P1/P2 discovery:

```bash
codegraph sync .
codegraph context "<task>"
codegraph query <symbol> --json
codegraph callers <symbol> --json
codegraph callees <symbol> --json
codegraph impact <symbol> --json
```

For this repo, do not treat `codegraph affected` as an authoritative test
selector. Many tests execute scripts by path or subprocess rather than import
edges, so run the repo verification commands instead.

### Bash Output Evidence and RTK

`forge` treats Bash output as runtime evidence, not durable task state.
`PostToolUse:Bash` records command metadata in `.ai/harness/checks/` and stores
large or failed command output under ignored `.ai/harness/runs/bash-output/` with
the byte count, SHA-256 digest, and relative evidence path.

RTK can be useful as a user-level compression tool for noisy successful shell
commands, but it is optional and advisory-only. Hooks may suggest `rtk` when it
is already on `PATH`, the command is broad, and the command succeeded; hooks must
not rewrite Bash commands, require RTK, or suggest compression for failed
commands. Failed command output stays raw so test, build, and review evidence is
not hidden by a compressor.

## Update

### gstack

Claude Code:

```bash
cd ~/.claude/skills/gstack && git pull && ./setup
```

Codex:

```bash
cd ~/.claude/skills/gstack && git pull && ./setup --host codex
```

### Waza

```bash
npx -y skills update
for d in think hunt check health; do
  rsync -a --delete ~/.agents/skills/$d/ ~/.codex/skills/$d/
done
mkdir -p ~/.codex/rules
for f in anti-patterns.md chinese.md durable-context.md english.md; do
  cp ~/.agents/rules/$f ~/.codex/rules/$f
done
for d in think hunt check health; do
  diff -qr ~/.agents/skills/$d ~/.codex/skills/$d
done
for f in anti-patterns.md chinese.md durable-context.md english.md; do
  cmp -s ~/.agents/rules/$f ~/.codex/rules/$f
done
```

### gbrain

```bash
gbrain check-update --json
gbrain upgrade
```

### CodeGraph

```bash
bun add -g @colbymchenry/codegraph@latest && codegraph sync . && codegraph status .
```

## Manual Knowledge Sync

`gbrain` stays advisory-first in this contract. Manual repo sync is allowed:

```bash
gbrain sync --repo <path>
```

## Default Brain Vault

Long-lived external knowledge should land in the default brain file vault before
or alongside `gbrain` import:

```text
brain/<project>/*
```

For this repo, use:

```text
brain/forge/*
```

The retired project-skill and project-initializer staging paths have been fully removed; no tooling recognizes, syncs, or cleans them up. Do not use them as sync targets.

Keep runtime contracts, hooks, scripts, checks, evidence, and migration state in
the repo. The default brain stores reusable explanations, runbooks, decisions,
and patterns only.

Repo stubs that point to default brain pages are indexed in
`.ai/harness/brain-manifest.json`. Valuable repo-authored docs can opt into
one-way mirroring by adding a manifest entry with:

```json
{
  "id": "project-decision-log",
  "repo_path": "docs/decisions.md",
  "brain_path": "brain/<project>/decisions/project-decision-log.md",
  "gbrain_slug": "decisions/project-decision-log",
  "sync": { "direction": "repo-to-brain" }
}
```

After that, PostEdit hooks sync only that source file. Manual sync and drift
checks are also available:

```bash
bash .ai/harness/scripts/check-brain-manifest.sh
bash .ai/harness/scripts/sync-brain-docs.sh --all
bash .ai/harness/scripts/sync-brain-docs.sh --check
```

## Why gbrain MCP Stays Off by Default

- `gbrain` is useful even when only the CLI is healthy.
- Missing `gbrain` CLI is not a setup dependency failure.
- Local MCP endpoints are more failure-prone than the CLI health path.
- The policy keeps `gbrain` as a candidate MCP entry, not a required runtime dependency.
- Re-enable MCP only after the local host config is explicitly updated and `gbrain doctor --json` is healthy enough for your workflow.
