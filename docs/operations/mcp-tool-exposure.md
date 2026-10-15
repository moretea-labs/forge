# MCP capability surface

Forge exposes one complete MCP `tools/list` registry. There is **no toolset selector**: the former `facade`, `core`, `advanced`, and `full` exposure modes no longer select different schemas. Each currently registered capability is discoverable and retains its own typed validation and execution authority.

The model may prefer the small `rh_*` entry points, `execute_command`, `capability_execute`, and `plugin_action_execute` for ordinary work, but preference is guidance, not a visibility gate. `adapters/mcp/toolset-names.ts` retains a small *preferred-name reference* for connector freshness and ergonomic routing; it is not a second public tool inventory. `adapters/mcp/toolset.ts` assembles the actual tool definitions once from the current module registries, returning the canonical ordered names and schema fingerprint to MCP discovery, health, status and connection diagnostics.

## Execution authority

- `execute_command`: general repository/workspace terminal and explicitly granted ForgeInstance host processes; Process Runtime owns execution and receipts.
- `capability_execute`: core typed capability actions owned by their canonical domain module.
- `plugin_action_execute`: external plugin actions owned by their provider authority.
- Other typed tools remain callable until their callers are migrated to a genuinely equivalent canonical action. Do not delete an operation simply to reduce `tools/list` count.
- Access modes (request/full access) and host/OS grants control *execution*, never tool discovery. Changing permissions does not add or hide tools.

The MCP transport publishes the complete static schema; it cannot dynamically load tools for a selected domain. Any removal or schema change requires a current-host connector refresh according to actual connector support, but does not justify retaining a second toolset profile. Historical persisted `toolset` fields never select an exposure mode. A previous `core`-only configuration is interpreted once as Request permission (to avoid silently widening access), and the obsolete selector is cleared on the next canonical configuration write.

## Performance and maintenance

A large `tools/list` can increase initial schema/context cost and tool selection ambiguity. Optimize this by measuring actual discover-to-action latency, schema bytes, routing errors and total calls to complete a task, then **migrating and deleting redundant public tools**, not by creating hidden profiles or duplicate authority. Retain typed semantics, remote mutation receipts and process observation where a shell-only replacement would lose safety or reliability.

Every source change should preserve the one-inventory invariant, the current permission model and the real MCP `tools/list` plus execution-path acceptance checks. No Runtime cutover is implied by a source-only change.
