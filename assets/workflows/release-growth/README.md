# Release and growth workflows

These versioned assets run through the existing Workflow Runtime and plugin
capabilities. They use the ordinary repository/checkout identity; no Work,
additional provider, credential store or scheduler is required.

Call `rh_work` with `operation: "workflow_execute"`, an explicit `repo_id`,
`checkout_id`, `workflow_id`, stable `workflow_run_id`, and `workflow_inputs`.
The Runtime installs the matching first-party asset and capability bindings.

| Workflow | Inputs | Result |
| --- | --- | --- |
| `appstore.observe-release` | `app_id`, exact `version_string` | Apple version and CHN territory observations; incomplete, ambiguous or compliance-blocked state does not count as available |
| `x.publish-post` | `session_id`, `account`, approved `text` | Publication receipt after verifying the account, unique post URL and original text |
| `x.observe-post-metrics` | `session_id`, `account`, exact `post_url` | Observable counters and bounded comment previews for that post |
| `x.reply-to-comment` | `session_id`, `account`, `post_url`, `comment_url`, exact `comment_text`, approved `reply_text` | Verified reply identity and original comment context |

Use an existing Forge Browser session ID. A browser connector tab ID or native
provider tab ID is not a Workflow Browser session. App Store observation uses
the existing authorized App Store Connect profile and requires the typed
`list_app_territory_availabilities` capability.

Keep the same run ID and inputs when reading or reconciling a previous run.
Reply run IDs must be `x-reply-<lowercase-account>-<comment-status-id>`, so another
run name cannot bypass the original comment's receipt. Unknown mutations stop
for `workflow_reconcile` with a stable `workflow_reconciliation_request_id`;
never create a new run to repeat an uncertain submission.

Successful X publication returns `outcomeFollowupDueAt`, calculated from the
canonical publication receipt plus 12 hours. The existing external Supervisor
occurrence and model select the follow-up action; this does not create a native
model wake or a second schedule. Record the publication identity and follow-up
evidence on the original GitHub Issue.

First-party JSON is embedded in deployed Bun bundles. The focused tests build
and run those bundles outside the source checkout to verify asset retention.
Asset/interpreter tests do not prove a live login, remote publication, reply,
email event, App Store download or full release cycle. Those require the
corresponding real plugin/WorkflowRun receipts under the original Issue.
