# Canonical Repo Harness Skill Surface

Status: accepted

## Decision

Repo Harness exposes one host-discoverable skill: `repo-harness`. CLI commands,
controller actions, and workflow modes are routed by that canonical skill and are
not installed as standalone skills.

## Removed standalone entries

The former command facades for planning, review, autoplan, ship, init, scaffold,
migrate, upgrade, capability, architecture, handoff, deploy, repair, check, PRD,
sprint, goal, GPT Pro setup, and GPT Pro consultation were duplicate discovery
surfaces over existing CLI commands. The repo-local ChatGPT bridge and browser
skills were also removed as standalone discovery entries; their durable safety
and controller rules remain in the canonical skill, controller tool contracts,
and ordinary documentation.

## Why

- A command alias is not an independent knowledge domain.
- Overlapping descriptions make automatic skill routing less reliable.
- ChatGPT Controller does not need a second skill registry or new MCP tools to
  operate existing typed capabilities.
- One canonical skill keeps Codex and Claude discovery predictable while the CLI
  remains fully expressive.

## Distribution

`scripts/sync-codex-installed-copies.sh` installs the canonical skill and removes
historical managed facade names from Codex and Claude skill roots. It does not
create a new registry, resolver, background service, or MCP tool.

## Reconsideration gate

A new standalone skill requires evidence of a recurring failure that cannot be
addressed through the canonical router, existing context/resources, or typed
controller/plugin capabilities. Tool-count growth is not an acceptable default.
