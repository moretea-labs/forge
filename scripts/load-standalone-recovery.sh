#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
Direct standalone-Recovery reload is disabled.

Recovery Gateway and Watchdog must be changed only by the immutable Recovery
installer, which stages a complete release, records exact current/previous
evidence, performs a bounded two-service launchd handoff, and verifies or rolls
back the exact previous release.

Use:
  bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home

Use --stage-only to build and inspect a candidate without changing services.
EOF
exit 2
