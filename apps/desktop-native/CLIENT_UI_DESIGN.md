# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-23 (flat-glass visual refresh on the four-column shell).
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## Locked product decisions

- **Four-column shell.** Visual columns are: (1) icon rail 会话/项目/看板 + 自动任务/资源/统计, 设置 pinned at bottom, (2) list (threads / projects / Zen context), (3) main board — Agent chat **or** Zen board, (4) persistent right activity rail (附件 / 规划 / 知识) matching the left rail. Work-surface content between chat and the rail is **hidden by default**. Titlebar shows only Changes.
- **1A cold start.** Empty store opens Agent (`zenMode=false`, `page=.agent`) with a bootstrap thread.
- **2B dual primary surfaces.** 会话 and 看板 remain peer destinations via the icon rail; Zen is not merged into the Agent right pane. 项目 is a first-class list-column mode for repository/project selection.
- **Browser deferred.** Never show Browser as an active enabled control until a separate authorized pane exists.
- **Cursor density.** Prefer quieter chrome: denser thread rows, icon-first conversation tools, flatter composer, list-header New Chat (`sidebar.thread.new`), and a persistent right activity rail instead of a titlebar tool strip.
- **No duplicate chrome.** Titlebar shows only Changes. Files / planning / knowledge live on the right rail; the conversation column does not repeat those openers. Window title shows workspace scope + honest status color (orange when checkout unavailable), not a second copy of the selected thread title.
- **App-owned Dark Glass.** Forge owns a Dark appearance independent of the macOS global theme: SwiftUI uses a dark root color scheme and the NSWindow uses `darkAqua`, while remaining non-opaque with a shared behind-window material. Rail/list columns use only a slightly stronger tonal wash. Never paint a solid toolbar or opaque main canvas. Conversation/right panes stay content-first without card wells; search/input/composer remain translucent and the composer shows an edge only while focused.
- **Icon optical contract.** Chrome glyphs use `ForgeClientDesign.Icon`: 13pt / 28pt hit for toolbar·sidebar·composer, 15pt rail glyphs + 9pt labels; hierarchical rendering, medium weight.

## 1. Overall layout

~~~text
macOS unified toolbar: traffic lights + Changes (Agent)
+------+--------------+----------------------------------+--------+
| Icons| List         | Main board                       | Tools  |
| 52pt | 200–280pt    | Chat OR Zen board                | 52pt   |
| 会话 | threads /    | Agent: transcript + composer     | 附件   |
| 项目 | projects /   | optional work surface in between | 规划   |
| 看板 | Zen context  | Zen: board / canvas              | 知识   |
| 工具 | New Chat in  |                                  | close  |
| 设置 | list header  |                                  |        |
+------+--------------+----------------------------------+--------+
~~~

Default visible columns: left icon rail + list + main + right activity rail. The entire shell shares one dark translucent backdrop independent of the macOS system appearance; rail/list depth comes from tonal material rather than separators, borders, or opaque slabs. Titlebar exposes only Changes; 附件 / 规划 / 知识 stay on the right rail. Clicking Changes or a rail tool expands the work-surface column between chat and the rail. It supports resize, close, and maximize without destroying chat state. The side-by-side threshold is 840pt (420pt conversation + 360pt work surface + 60pt native split/spacing allowance) inside the split area beside the rail; width changes switch presentation without clearing the selected surface.

## 2. Toolbar ownership

- **No titlebar content band.** `.toolbarBackground(.hidden)` — traffic lights sit on the same surface as content. Do not host breadcrumb/status in a filled toolbar strip.
- **Titlebar default:** only Changes (`agent.changes`). Files / planning / knowledge are not titlebar actions.
- **Right rail:** always-visible left-mirrored activity rail (附件 / 规划 / 知识). Clicking a rail tool (or Changes) expands work-surface content between chat and the rail; maximize/close appear at the bottom of that rail while the pane is open. Empty Files pane omits search chrome until there is something to filter. Browser remains deferred.
- **List header (会话):** New Chat, Search, Inbox — New Chat uses `sidebar.thread.new`; icons share `ForgeClientDesign.Icon`.
- **Composer:** provider/model/attachments/voice/send; chrome icons share the same 13/28 optical size; focus ring only while focused.

## 3. Plain-button rule (P0)

NO decorative card/capsule/softFill wrapping every toolbar, rail, tab, commit form, notice, or diff shell. Globally, `.bordered` bezel buttons, pill selectors, column hairlines and boxed form fields are forbidden; secondary actions use `.forgeText`, forms use label-left rows. `.borderedProminent` is reserved for one primary action per surface. Icon-rail and list selection may use a quiet selection fill. Composer may show a focus ring only while focused; diff lines tint in place without a surrounding card.

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
3. The window toolbar exposes only Changes (`agent.changes`) by default; list header exposes New Chat (`sidebar.thread.new`).
4. Opening Changes (or a right-rail tool) expands the pane with a 附件/规划/知识 activity rail, stays selected through wide → compact → wide transitions, and can close or maximize without losing chat state.
5. `swift test` / `swift build`; GUI/AX at 860 / 1100 / 1260 / 1440 / 1800+ when authorized. The app remains Dark Glass under either macOS Light or Dark system appearance; system appearance is never changed.

Do not replace the installed App or activate Runtime without separate authorization.
