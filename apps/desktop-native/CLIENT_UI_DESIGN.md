# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-24 (user-authorized compact toolbar and on-demand inspector).
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## Locked product decisions

- **Default three-column shell + on-demand inspector.** Left icon rail (会话/项目/看板 + 自动任务/资源/统计, 设置 pinned below), list, and main Agent or Zen workspace. No permanent right rail. The only Agent tool opener is the top-right inspector toggle; its panel contains 改动 / 附件 / 规划 / 知识 / 能力 tabs. New windows start closed; the last available tab is remembered.
- **1A cold start.** Empty store opens Agent (`zenMode=false`, `page=.agent`) with a bootstrap thread.
- **2B dual primary surfaces.** 会话 and 看板 remain peer destinations via the icon rail; Zen is not merged into the Agent right pane. 项目 is a first-class list-column mode for repository/project selection.
- **Browser deferred.** Never show Browser as an active enabled control until a separate authorized pane exists.
- **Cursor density.** Prefer quieter chrome: denser thread rows, icon-first conversation tools, flatter composer, list-header New Chat (`sidebar.thread.new`), and a single on-demand inspector toggle instead of a persistent tool rail.
- **No duplicate chrome.** A compact 36pt header at the top of the main glass pane hosts the conversation title, truthful workspace status, and one trailing inspector toggle; the native toolbar remains transparent and compact. Do not repeat status as an overlay in the transcript.
- **App-owned Floating Dark Glass.** Forge owns a Dark appearance independent of the macOS global theme: SwiftUI uses a dark root color scheme and the NSWindow uses `darkAqua`, while remaining non-opaque with shared behind-window material. The outer shell is a custom divider-free `HStack`, not `NavigationSplitView`: left navigation glass and main glass are separate rounded panels with an 8pt air gap, never a black/system splitter. The left panel uses only a slightly stronger tonal wash; the inspector occupies no space until opened. Search/input/composer/work-surface controls are nested translucent glass with near-invisible rims; the composer shows a stronger edge only while focused.
- **Icon optical contract.** Chrome glyphs use the bundled Tabler assets through `ForgeGlyph`: 13pt glyphs in a shared 30pt hit frame; rail rows remain 52×36pt. The rail is icon-only; destination names remain available through help and accessibility labels.

## 1. Overall layout

~~~text
macOS compact unified toolbar: traffic lights
Main pane header (36pt): conversation title | fixed status slot | inspector toggle
+------+--------------+------------------------------------------+
| Icons| List         | Main board                              |
| 52pt | 236pt        | Chat OR Zen board                        |
| 会话 | threads /    | Transcript + fixed composer              |
| 项目 | projects /   | Inspector only when opened               |
| 看板 | Zen context  | Tabs: 改动 / 附件 / 规划 / 知识 / 能力   |
| 设置 | list header  | Compact: transcript overlay; Composer clear |
+------+--------------+------------------------------------------+
~~~

Default visible columns: icon rail + list + main. The left glass is responsive: 228pt compact minimum (52 + 176), grows with window width, and caps at the existing 288pt desktop ideal (52 + 236). The left and main glass share an 8pt transparent gap. No outer native split divider. Closed inspector consumes zero width. A normal open overlays only the transcript viewport at the trailing edge; it never covers the Composer or changes transcript/Composer bounds. Only explicit maximize replaces the conversation. Preserve draft, attachments, scroll, selected tab and running tasks. The transcript starts at 8pt top inset and 20pt horizontal gutter; empty state uses only its intrinsic height plus 20pt top spacing.

## 2. Toolbar ownership

- **No titlebar content band.** `.toolbarBackground(.hidden)` — traffic lights sit on the same surface as content. Do not host breadcrumb/status in a filled toolbar strip.
- **Main pane header:** `agent.inspector.toggle` is the sole Agent tool opener, pinned to the trailing edge. The same compact header displays the conversation title and honest workspace status; no centered native toolbar items.
- **Transcript and composer geometry:** both use one centered reading-column rule (760pt cap, 20pt horizontal gutter). Their left/right edges stay aligned at compact and desktop widths.
- **Layout stability contract:** responsive sidebar width is continuous (no integer rounding steps), and sidebar headers must compress/truncate within one view tree rather than swap layouts via `ViewThatFits`. Passive conversation auto-follow during streaming/new-message/busy growth is non-animated; explicit user jumps may animate. Header status owns a fixed-width slot, and the Composer text viewport stays at a fixed 38pt height with internal scrolling, so status/draft changes cannot push surrounding layout. Inspector stays closed until requested. A normal open is a trailing floating overlay anchored to the transcript viewport, 340–420pt wide; it never covers the Composer and does not change transcript/Composer bounds. Only explicit maximize replaces the conversation; close/restore keeps the mounted workspace, draft, attachments, scroll, running tasks and selected tab.
- **Inspector:** tabs 改动 / 附件 / 规划 / 知识 / 能力 are available only when opened. 能力 uses real Plugin install/health/authorization state and stays summary-first; full plugin/version/authorization detail belongs to the existing management page. Skills/MCP/Agents/Commands/Hooks are stable presentation slots (`skills` / `mcp` / `agents` / `commands` / `hooks`) with stable AX ids (`agent.capability.*`); the content pane uses `agent.capabilities.panel`, distinct from the `agent.capabilities` tab button. MCP / 外部工具 is a real read-only projection of canonical `controller_capabilities` (tool surface/version, exposed tool count, capability descriptor count, connector freshness). Skills/Agents/Commands/Hooks remain visually secondary and explicitly `待接入` until a real discovery/invocation backend exists; implementation notes such as backend/layout migration instructions do not appear in product UI. Maximize and close live in its header. Unavailable tabs remain disabled; reopening restores the last available tab or falls back to 附件. Browser remains deferred.
- **Icon system:** primary navigation, list header and Agent commands use bundled Tabler SVG assets through `ForgeGlyph`, rendered at 13pt within a shared 30pt glyph frame (navigation rows are 52×36pt). Rail is icon-only; each control exposes its destination title through help and accessibility labels. Selection uses adaptive foreground and a quiet wash, not changing stroke weight. System symbols remain for incidental metadata and native menus. Icons are decorative inside controls with explicit accessibility labels.
- **List header (会话):** New Chat, Search, Inbox — New Chat uses `sidebar.thread.new`; shared custom glyphs use consistent hover and selection states.
- **Composer:** one quiet capability opener + provider/model/attachments/voice/send; shared outline glyphs and stable 30pt command hit areas; focus ring only while focused. Configuration controls scroll horizontally; narrow conversation widths use a separate configuration row so primary actions retain their hit targets.

## 3. Plain-button rule (P0)

NO decorative card/capsule/softFill wrapping every toolbar, rail, tab, commit form, notice, or diff shell. Globally, `.bordered` bezel buttons, pill selectors, native column dividers, column hairlines and boxed form fields are forbidden; secondary actions use `.forgeText`, forms use label-left rows. `.borderedProminent` is reserved for one primary action per surface. Icon-rail and list selection may use a quiet translucent selection wash. Composer/search/work-surface may use nested glass, but their resting rim must be nearly invisible; Composer may strengthen its focus ring only while focused. Diff lines tint in place without a surrounding card.

## 4. Navigation invariants

- Rail items show the icon only; destination names remain available through help and VoiceOver accessibility labels.
- The list column shows the conversation list only for 会话; utility destinations (自动任务/资源/统计/设置) show their own section navigation.

- Icon rail 会话 → Agent thread list + chat main.
- Icon rail 项目 → project list column; selecting a project opens/focuses that repository context without inventing a second project authority.
- Icon rail 看板 → Zen sidebar list + Zen board/canvas main.
- Opening/closing the right pane preserves draft, attachments, scroll and live execution.
- Project → Requirement → Agent → review → Back reuses `projectDetailReturnContext`.

## 5. Source ownership

- `ForgeClientShell.swift`: window shell, icon rail, list column, remembered inspector tab and per-window visibility state.
- `ForgeClientSidebar.swift`: destination enum (会话/项目/看板 + utilities).
- `AgentWorkbenchViews.swift`: AgentPane, conversation toolbar, right work surface.
- `ZenModeView.swift`: peer board destination.
- `ForgeClientDesign.swift`: single token vocabulary including `iconRailWidth`.
- `ForgeNativeApp.swift`: `@main` only.

## 6. Acceptance

1. Cold start shows Agent with right pane closed.
2. Icon rail switches 会话 / 项目 / 看板 without losing draft or return context.
3. The Agent header exposes a single trailing inspector opener (`agent.inspector.toggle`); no permanent right rail or hidden panel tabs in the closed state. List header exposes New Chat (`sidebar.thread.new`).
4. Open inspector, switch 改动/附件/规划/知识/能力, close/reopen the same available tab, resize wide → compact → wide, maximize/restore/close without losing chat state. Verify the Composer/transcript AX bounds are identical immediately before and after normal Inspector open/close; only maximize may replace the conversation. Also verify header context, continuous responsive sidebar width (228pt minimum, 264.6pt @ 1260, 288pt cap), aligned transcript/composer edges, fixed header-status/composer geometry, non-animated passive streaming follow, and reduced top whitespace.
5. `swift test` / `swift build`; GUI/AX at 860 / 1100 / 1260 / 1440 / 1800+ when authorized. The app remains Dark Glass under either macOS Light or Dark system appearance; system appearance is never changed. At 860 and 1260 the outer left/main glass panels must remain divider-free and readable; a high-contrast/purple backdrop must visibly sample through the shell rather than reveal an opaque gray canvas.

Do not replace the installed App or activate Runtime without separate authorization.
