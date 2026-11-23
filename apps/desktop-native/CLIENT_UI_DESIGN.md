# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-23 (Cursor-density polish on four-column shell).
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## Locked product decisions

- **Four-column shell.** Visual columns are: (1) icon rail 会话/项目/看板 + 自动任务/资源/统计, 设置 pinned at bottom — all tools visible, never collapsed into a More menu, (2) list (threads / projects / Zen context), (3) main board — Agent chat **or** Zen board, (4) optional right work surface (Changes | Files), **hidden by default**.
- **1A cold start.** Empty store opens Agent (`zenMode=false`, `page=.agent`) with a bootstrap thread.
- **2B dual primary surfaces.** 会话 and 看板 remain peer destinations via the icon rail; Zen is not merged into the Agent right pane. 项目 is a first-class list-column mode for repository/project selection.
- **Browser deferred.** Never show Browser as an active enabled control until a separate authorized pane exists.
- **Cursor density.** Prefer quieter chrome: denser thread rows, icon-first conversation tools, flatter composer, list-header New Chat (`sidebar.thread.new`), and right-pane tab strip instead of a dropdown title.
- **No duplicate chrome.** When the right pane is open, Changes/Files live only in its tab strip; the conversation column does not repeat those openers. Window title shows workspace scope + honest status color (orange when checkout unavailable), not a second copy of the selected thread title.

## 1. Overall layout

~~~text
macOS unified toolbar: sidebar / title / breadcrumb / navigation
+------+--------------+----------------------------------+------------------+
| Icons| List         | Main board                       | Right (optional) |
| 52pt | 200–280pt    | Chat OR Zen board                | hidden by default|
| 会话 | threads /    | Agent: quiet tools +              | tab: Changes|Files|
| 项目 | projects /   | transcript + flat composer        | open from chat   |
| 看板 | Zen context  | Zen: board / canvas               | close / maximize |
| 工具 | New Chat in  |                                  |                  |
| 设置 | list header  |                                  |                  |
+------+--------------+----------------------------------+------------------+
~~~

Default visible columns: icon rail + list + main. Opening Changes/Files from the **middle conversation toolbar** reveals the right pane; it supports resize, close, and maximize without destroying chat state. The side-by-side threshold is 840pt (420pt conversation + 360pt work surface + 60pt native split/spacing allowance); width changes switch presentation without clearing the selected surface.

## 2. Toolbar ownership

- **Window toolbar:** global navigation chrome: sidebar toggle, session title and `project › repo › branch` context, plus back when available. Agent-specific Changes/Files/More actions do not live here.
- **Middle conversation toolbar (Agent main):** icon-first Changes / Files / More when the right pane is closed. Stable action identifiers are `agent.changes`, `agent.files`, and `agent.tools.more`. Hidden while the right pane is open.
- **Right pane:** tab strip is the only Changes | Files switcher while open; maximize and close stay as plain icon buttons. Empty Files pane omits search chrome until there is something to filter. Browser remains deferred and disabled.
- **List header (会话):** New Chat, Search, Inbox — New Chat uses `sidebar.thread.new`.
- **Window toolbar, other pages and 看板:** sidebar toggle, back, Project › repository breadcrumb, page refresh.
- **Composer:** provider/model/attachments/voice/send; single quiet shadow; remains mounted while the right pane replaces its presentation at compact widths.

## 3. Plain-button rule (P0)

NO decorative card/capsule/softFill wrapping every toolbar, rail, or tab button. Globally, `.bordered` bezel buttons, pill selectors and boxed form fields are forbidden; secondary actions use `.forgeText`, forms use label-left rows. `.borderedProminent` is reserved for one primary action per surface. Icon-rail selection may use a quiet selection fill. Real surfaces remain for list selection, composer well, and diff canvas.

## 4. Navigation invariants

- Rail items always show icon + text label.
- The list column shows the conversation list only for 会话; utility destinations (自动任务/资源/统计/设置) show their own section navigation.

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
3. The middle conversation toolbar exposes Changes / Files / More with the stable AX identifiers above; list header exposes New Chat (`sidebar.thread.new`).
4. The right pane opens from the middle toolbar, shows a Changes|Files tab strip, stays selected through wide → compact → wide transitions, and can close or maximize without losing chat state.
5. `swift test` / `swift build`; GUI/AX at 860 / 1100 / 1260 / 1440 / 1800+ when authorized.

Do not replace the installed App or activate Runtime without separate authorization.
