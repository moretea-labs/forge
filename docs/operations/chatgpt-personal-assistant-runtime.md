# ChatGPT-first Personal Assistant Runtime

This runtime is designed for a local-first personal assistant where ChatGPT is the primary natural-language controller and Forge is the guarded local execution layer.

## Product boundary

The Local Controller should not be the main task input surface. It stores routines, inbox items, memory, approvals, audit events, device tokens, and plugin state. ChatGPT, MCP, or a GPT Action should translate natural language into one of the high-level assistant APIs.

## High-level API surface

Expose these endpoints to ChatGPT Actions instead of exposing every low-level plugin action:

- `POST /api/assistant/intent` — submit a natural-language utterance or a ChatGPT-planned action list.
- `GET /api/assistant/inbox` — read assistant outputs, routine results, and approval notes.
- `GET /api/assistant/routines` — list saved routines.
- `POST /api/assistant/routines` — create a routine from a natural-language goal.
- `POST /api/assistant/routines/:routineId/run` — run one routine immediately.
- `POST /api/assistant/routines/:routineId/pause` — pause a routine.
- `POST /api/assistant/routines/:routineId/resume` — resume a routine.
- `POST /api/assistant/routines/:routineId/delete` — soft-delete a routine.
- `GET /api/assistant/memory` and `POST /api/assistant/memory` — read/write local preference memory.
- `GET /api/assistant/openapi.json` — minimal OpenAPI schema for a Custom GPT Action.

All `/api/*` routes still require the local controller token.

## Intent modes

`/api/assistant/intent` supports three modes:

- `plan_only`: return the interpreted plan without submitting execution jobs.
- `plan_then_execute`: plan and submit safe steps; block high-risk steps.
- `execute`: submit the supplied plan directly through the same policy gate.

The preferred ChatGPT flow is:

1. ChatGPT understands the user request.
2. ChatGPT asks for missing information or confirmation when needed.
3. ChatGPT calls `/api/assistant/intent` with either the natural-language utterance or an explicit `plan`.
4. Forge validates policy, creates durable Execution Jobs, stores an Assistant Inbox item, and returns display text.

## Routine model

A routine stores the user's natural-language goal rather than a traditional GUI rule form:

```json
{
  "name": "每日邮件整理",
  "naturalLanguageGoal": "每天早上 9 点整理过去 24 小时重要邮件，重点关注工作、API、BA、Jira、PR，用中文输出摘要。",
  "scheduleText": "每天 09:00",
  "dataSources": ["gmail", "calendar", "tasks"],
  "output": "assistant_inbox",
  "allowedActions": ["gmail.list_messages", "gmail.get_message"],
  "forbiddenActions": ["gmail.send_message", "gmail.trash_message"]
}
```

Routine execution and long-lived goal continuation use the existing Schedule Engine rather than a second assistant daemon. Semantic/model-backed routine logic remains external-controller-owned; the Kernel does not execute an unbounded model loop on a timer.

For an accepted non-terminal Work, ChatGPT can create a bounded `rh_work.schedule_create` policy in one of three modes:

- `continuation` — wake the bound ChatGPT/Codex/Claude/Grok Controller at the configured trigger;
- `browser_watch` — silently refresh/read an allowed browser target, fingerprint a deterministic text projection, and wake the bound Controller only when the observation changes;
- `browser_keepalive` — silently refresh an authenticated browser target and wake only when configured login markers indicate that user authentication is required.

The first `browser_watch` observation is a silent baseline by default. Unchanged observations do not create a ChatGPT conversation turn. When the bound Work becomes terminal, Forge disables the Schedule before performing another external probe, so temporary watchers naturally disappear with the Goal they serve.

## Policy defaults

Allowed without extra approval:

- Read Gmail, Calendar, and Tasks.
- Create a Google Task / reminder.
- Create a Gmail draft.
- Create a personal calendar event without attendees.

Requires human approval:

- Send email.
- Trash email.
- Cancel calendar event.
- Reschedule calendar event.
- Delete task.
- Scheduled routine writes beyond explicitly allowed draft/reminder behavior.

## Assistant Inbox

Assistant Inbox is the user-facing result surface for meaningful routine outputs, approval/authentication needs, and intent execution records. A successful scheduled probe with no external change should remain silent rather than generating a daily "completed" notification. ChatGPT can read meaningful items and then present the result conversationally, for example: "今天助理整理了什么？"

## Current limitation

The runtime does not embed a full NLP model. ChatGPT Actions should provide structure when precision matters. The local runtime includes conservative intent inference only for routine creation, reminders, and immediate mail-summary collection.

`browser_watch` is a fallback observation source for services without a usable API or webhook; it depends on a live authenticated browser session and caller-supplied selectors/terms when the page contains unrelated or volatile content. Browser refresh can reduce inactivity-related logout but cannot override a provider's absolute session lifetime, security checks, or MFA policy. Provider-native APIs/events should replace browser probes when they are available and more reliable.
