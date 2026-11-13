# Automated release and growth workflows (#652)

This work is a **reusable workflow foundation**, not an App-specific polling task. The three initial iOS apps are integration/acceptance fixtures, not their own workflow engines.

## Execution ownership

- Existing Forge Workflow Asset / Workflow Runtime / Process / Plugin receipts own durable execution and remote-effect reconciliation.
- Existing Keychain + Browser + #288/#200 own credential and account authorization; never copy passwords or one-time codes to Workflow outputs, logs, or GitHub.
- macOS Python `forge-supervisor` + launchd only wakes the model. It is not a second scheduler, workflow interpreter, or status database.
- GitHub [#652](https://github.com/moretea-labs/forge/issues/652) is the delivery/acceptance record.

## Initial source assets (read-only)

| Workflow ID | Inputs | Outputs | Limits |
| --- | --- | --- | --- |
| `appstore.observe-release` | `app_id`, authorized Browser `session_id` | Apple version eligibility next-action hint; independent Chinese mainland row state | No publication write. `READY_FOR_DISTRIBUTION` is **not** downloadable Storefront evidence. |
| `x.observe-post-metrics` | X `account`, exact `post_url`, authorized Browser `session_id` | Exact post engagement counters on known accessibility labels | Unknown UI formats fail closed; important comments still require exact-thread/model assessment and separately authorized reply. |

Both are versioned JSON assets auto-installed through the existing `rh_work.workflow_execute` first-party registration path. The Workflow Registry binds only existing read capabilities. An App ID is strictly validated before any generated ASC URL is used. An X post URL must be HTTPS on `x.com`, matching the specified account and exact post ID without query or fragment.

These are **source-only** until an authorized Forge Runtime candidate is deployed and the real provider/browser session is tested; synthetic interpreter tests are not provider acceptance.

## Remaining E2E acceptance (do not close early)

- OS-backed existing credentials, scoped login/authorized registration, session expiry/restart/revocation and legitimate MFA handoff (#288, #200).
- Official Apple/QQ Mail review events and secure transient OTP use, deduplicated by original message/Case/App, with event→next-action branch.
- Approval→authorized publication→territory availability→real Storefront downloadable proof; reconcile unknown remote writes using original effect receipt (#643 and Workflow Runtime).
- Actual post publication with native post ID/URL/time, revisit after approximately 12 hours, metrics and important-comment decision, and a single authorized exact-thread reply when appropriate.
- Mainland legal ICP/game requirements addressed **per App**: 6771288893, 6831952477, 6796884084. Never reuse a signature image as authorization for a new legal declaration.

## Source verification

```sh
bun test tests/runtime/release-growth-workflows.test.ts tests/runtime/xiaohongshu-publish.test.ts tests/runtime/workflow-runtime-interpreter.test.ts tests/runtime/workflow-asset-storage.test.ts
bun run check:type
```

Read-only source test evidence: 24 passing tests, 161 assertions, TypeScript check passed. This is a bounded first delivery milestone, **not** a complete automated publishing or growth E2E.
