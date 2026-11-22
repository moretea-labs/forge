# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-22 (four-column shell restore).
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## Locked product decisions

- **Four-column shell.** Visual columns are: (1) icon rail 会话/项目/看板, (2) list (threads / projects / Zen context), (3) main board — Agent chat **or** Zen board, (4) optional right work surface (Changes | Files), **hidden by default**.
- **1A cold start.** Empty store opens Agent (`zenMode=false`, `page=.agent`) with a bootstrap thread.
- **2B dual primary surfaces.** 会话 and 看板 remain peer destinations via the icon rail; Zen is not merged into the Agent right pane. 项目 is a first-class list-column mode for repository/project selection.
- **Browser deferred.** Never show Browser as an active enabled control until a separate authorized pane exists.

## 1. Overall layout

~~~text
macOS unified titlebar: Project › repo/checkout                          Refresh
+------+--------------+----------------------------------+------------------+
| Icons| List         | Main board                       | Right (optional) |
| 52pt | 200–280pt    | Chat OR Zen board                | hidden by default|
| 会话 | threads /    | Agent: conversation toolbar +    | Changes | Files  |
| 项目 | projects /   |      transcript + composer       | open from chat   |
| 看板 | Zen context  | Zen: board / canvas              | toolbar          |
| 更多 |              |                                  |                  |
+------+--------------+----------------------------------+------------------+
~~~

Default visible columns: icon rail + list + main. Opening Changes/Files from the **conversation toolbar** (top of center pane) reveals the right pane; it supports resize, close, and maximize without destroying chat state.

## 2. Toolbar ownership

- **Window titlebar:** sidebar toggle, Project › repository breadcrumb, global refresh for non-Agent pages, back when navigation stack is non-empty.
- **Conversation toolbar (top of Agent main):** session title, **Changes / Files / More**, provider status. This is where session tools enter — not the icon rail.
- **Right pane tab strip:** Changes | Files local actions, maximize/close.
- **Composer:** provider/model/attachments/voice/send; stays mounted while the right pane is open.

## 3. Plain-button rule (P0)

NO decorative card/capsule/softFill wrapping every toolbar, rail, or tab button. Icon-rail selection may use a quiet selection fill. Real surfaces remain for list selection, composer well, and diff canvas.

## 4. Navigation invariants

- Icon rail 会话 → Agent thread list + chat main.
- Icon rail 项目 → project list column; selecting a project opens/focuses that repository context without inventing a second project authority.
- Icon rail 看板 → Zen sidebar list + Zen board/canvas main.
- Opening/closing the right pane preserves draft, attachments, scroll and live execution.
- Project → Requirement → Agent → review → Back reuses `projectDetailReturnContext`.

## 5. Source ownership

- `ForgeClientShell.swift`: window shell, icon rail, list column, SceneStorage for right pane.
- `ForgeClientSidebar.swift`: destination enum (会话/项目/看板 + utilities).
- `AgentWorkbenchViews.swift`: AgentPane, conversation toolbar, right work surface.
- `ZenModeView.swift`: peer board destination.
- `ForgeClientDesign.swift`: single token vocabulary including `iconRailWidth`.
- `ForgeNativeApp.swift`: `@main` only.

## 6. Acceptance

1. Cold start shows Agent with right pane closed.
2. Icon rail switches 会话 / 项目 / 看板 without losing draft or return context.
3. Changes/Files open as a fourth column from the conversation toolbar and can close/maximize.
4. `swift test` / `swift build`; GUI/AX at 860 / 1100 / 1440 / 1800+ when authorized.

Do not replace the installed App or activate Runtime without separate authorization.
