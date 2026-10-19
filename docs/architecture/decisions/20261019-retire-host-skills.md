# Decision: Retire Forge-owned host Skills and duplicate version authority

**Status:** Accepted (2026-10-19). Supersedes the host-Skill distribution decision of 20260803.

## Evidence
Forge execution uses CLI, MCP, Runtime, and host adapters. The former root Skill only offered prompt discovery for Codex/Claude; its separate installer and version manifest added a second release authority which blocked version 1.8.2 without evidence of a Runtime defect.

## Decision
- Remove the Forge-owned host Skill, Codex Skill metadata, bundled cross-review Skills, and their installers.
- Forge setup no longer installs third-party Waza/Mermaid Skills. Existing user-installed Skills are user-owned and left untouched.
- Project guidance templates read their version from package.json.version. Eliminate the independent version manifest and generated per-project Skill version stamp.
- Retire the deprecated empty Skill lifecycle-hook table and executor.
- Keep CLI, MCP, Runtime, host hook adapters, project guidance, Forge Plugins, and unrelated Cognitive Skill semantics.

## Migration and acceptance
Packaged distributions no longer include Forge-owned host Skills. CLI init/update/adopt do not synchronize them. All changed code, project templates, architecture, and release gates must be validated with one canonical version authority. No replacement provider is introduced.
