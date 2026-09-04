#!/bin/bash
# Create standard project directory structure
# Usage: bash scripts/create-project-dirs.sh
#
# Creates the three-layer project structure:
#   IMMUTABLE LAYER (资产层): specs, contracts, tests
#   MUTABLE LAYER (厕纸层): src
#   SUPPORTING (支撑层): authored docs/deploy/tasks only; Runtime state lives in Controller Home

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_LIB_DIR="$SCRIPT_DIR/lib"
if [[ -f "$PI_LIB_DIR/project-init-lib.sh" ]]; then
  # shellcheck source=/dev/null
  . "$PI_LIB_DIR/project-init-lib.sh"
fi
ASSETS_TEMPLATES_DIR="$SCRIPT_DIR/../assets/templates"
ASSETS_HOOKS_DIR="$SCRIPT_DIR/../assets/hooks"
ASSETS_REF_DIR="$SCRIPT_DIR/../assets/reference-configs"
ASSETS_FACTOR_FACTORY_DIR="$ASSETS_TEMPLATES_DIR/factor-factory"
ASSETS_WORKFLOW_CONTRACT="$SCRIPT_DIR/../assets/workflow-contract.v1.json"

write_runtime_gitignore_block() {
  local extra_entries=""
  if pi_should_enable_factor_factory "$(pi_plan_type)"; then
    extra_entries="$(pi_factor_factory_gitignore_entries)"
  fi
  # Package helpers are not materialized by the v1.5 scaffold, so do not
  # manufacture ignore entries for files that should never be created.
  pi_ensure_gitignore_block ".gitignore" "$PI_DEFAULT_GITIGNORE_CONTENT" "$extra_entries" "apply"
}

install_workflow_contract() {
  pi_install_workflow_contract "$PWD" "$ASSETS_WORKFLOW_CONTRACT" "apply"
}

create_contract_directories() {
  while IFS= read -r rel_dir; do
    [[ -z "$rel_dir" ]] && continue
    mkdir -p "$rel_dir"
  done < <(pi_workflow_contract_query_lines "$ASSETS_WORKFLOW_CONTRACT" "artifacts.requiredDirectories")
}

install_hook_assets() {
  pi_install_hook_assets "$PWD" "$ASSETS_HOOKS_DIR" "apply"
}

ensure_task_sync_package_script() {
  pi_ensure_task_sync "$PWD" "1" "apply"
}

# ===== IMMUTABLE LAYER (资产层) =====
mkdir -p interfaces/modules
mkdir -p tests/unit
mkdir -p tests/integration
mkdir -p tests/e2e

# ===== MUTABLE LAYER (厕纸层) =====
mkdir -p src/modules

# ===== SUPPORTING (支撑层) =====
mkdir -p docs/reference-configs
if pi_should_generate_full_docs; then
  mkdir -p docs/architecture
  mkdir -p docs/api
  mkdir -p docs/guides
  mkdir -p docs/archives
fi
mkdir -p deploy/env
mkdir -p deploy/scripts
mkdir -p deploy/submissions
mkdir -p deploy/runbooks
mkdir -p deploy/release-checklists
mkdir -p deploy/sql
create_contract_directories

# ===== Initial Files =====
touch docs/CHANGELOG.md
if pi_should_generate_full_docs; then
  touch docs/brief.md
  touch docs/tech-stack.md
  touch docs/decisions.md
fi

cat > tasks/todos.md << 'TASK_TODO_EOF'
# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: (initial)
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| (none) | No deferred medium/long-term goal recorded yet. | Keep the first sprint bounded. | Add a row when a real follow-up is postponed. |
TASK_TODO_EOF

cat > tasks/lessons.md << 'TASK_LESSONS_EOF'
# Lessons Learned (Self-Improvement Loop)

> Capture correction-derived prevention rules here.
> Promote repeated patterns into durable project rules during spa day.

## Template
- Date:
- Triggered by correction:
- Mistake pattern:
- Prevention rule:
- Where to apply next time:
TASK_LESSONS_EOF

mkdir -p docs/researches
cat > docs/researches/README.md << 'RESEARCH_README_EOF'
# Research Reports

Durable research reports live in this directory as topic-scoped Markdown files.

Use `YYYYMMDD-topic.md` names when chronology matters, or `<topic>.md` for
stable subject reports. Keep durable product/architecture decisions in authored
documentation; mutable Requirement/Plan/Work execution state stays in Controller Home.
RESEARCH_README_EOF

install_workflow_contract
if pi_should_enable_factor_factory "$(pi_plan_type)"; then
  pi_install_factor_factory "$PWD" "$ASSETS_FACTOR_FACTORY_DIR" "$SCRIPT_DIR" "apply"
fi
ensure_task_sync_package_script
write_runtime_gitignore_block


cat > docs/spec.md << 'DOCS_SPEC_EOF'
# Product Spec

> **Status**: Draft
> **Owner**: Planner
DOCS_SPEC_EOF
# Mutable Forge Runtime state is intentionally not scaffolded into the repository.
# Repository registration binds Runtime state to Controller Home.

cat > interfaces/types.ts << 'INTERFACES_TYPES_EOF'
/**
 * Shared Runtime Interface Definitions
 *
 * IMMUTABLE: Changes here require downstream rewrites
 */

// Add shared API schemas, event schemas, DTOs, or boundary types here
export {}
INTERFACES_TYPES_EOF

cat > tests/README.md << 'TESTS_README_EOF'
# Test Directory Structure

> **Test is the new Spec. 测试是唯一的真理。**

## Asset Hierarchy

Tests are IMMUTABLE ASSETS. Implementation is DISPOSABLE.

## Rules

- Test code quantity ≥ Implementation code quantity
- Test failure = Delete module and rewrite
- Never modify tests to make buggy code pass

## Running Tests

```bash
bun test              # Run all tests
bun test --coverage   # With coverage
bun test --watch      # Watch mode
```
TESTS_README_EOF

pi_install_root_context_files "$PWD" "apply"
pi_install_directory_context_files "$PWD" "apply"

if [[ -d "$ASSETS_REF_DIR" ]]; then
  pi_install_reference_configs "$PWD" "$ASSETS_REF_DIR" "apply"
else
  pi_write_reference_config_stub "docs/reference-configs/agentic-development-flow.md" "agentic-development-flow.md" "$SCRIPT_DIR/../assets/reference-configs"
  pi_write_reference_config_stub "docs/reference-configs/external-tooling.md" "external-tooling.md" "$SCRIPT_DIR/../assets/reference-configs"
fi

touch deploy/env/.gitkeep
touch deploy/scripts/.gitkeep
touch deploy/submissions/.gitkeep
touch deploy/runbooks/.gitkeep
touch deploy/release-checklists/.gitkeep
touch deploy/sql/.gitkeep
cat > deploy/README.md << 'DEPLOY_README_EOF'
# Deployment Operations

`deploy/` is a commit-ready surface for deployment and operations runbooks, submission materials, release checklists, helper scripts, and env examples.

## Track

- `deploy/scripts/` for operational scripts.
- `deploy/submissions/` for submission or review materials.
- `deploy/runbooks/` and `deploy/release-checklists/` for operational documentation.
- `deploy/sql/` for ordered deployment SQL files named like `0001_create_tables.sql`.
- `deploy/*.md` for runbooks and operating notes.
- `deploy/env/.env.example` for documented variable shapes only.

## Do Not Track

- `_ops/`
- private keys, real env files, provider state, production tokens, credential dumps, artifacts, logs, and local-only overrides

Keep external upstream checkouts and source references in `_ref/`; `_ref/` is ignored and must stay out of commits.
DEPLOY_README_EOF

echo "Project directory structure created successfully."
