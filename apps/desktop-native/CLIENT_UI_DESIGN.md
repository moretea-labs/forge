# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-22.
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## 1. Overall layout — Agent first, one window shell

Forge is an Agent-first workbench, not a set of disjoint screens. One native titlebar and one shared window shell continue across Agent, Project, Resources and Settings. No second permanent icon rail, duplicate sidebar, per-page window frame, or stacked decorative toolbar.

~~~text
macOS unified titlebar: [Sidebar] Project > repo/checkout     Search | Layout | Right pane
+----------------+----------------------------------+----------------------------------+
| Navigation     | Agent conversation / main task   | Optional work surface            |
| 238–286pt      | flexible; keep chat readable     | resizable, 360pt–55%             |
| Project        | Session title · Requirement      | Changes | Files | Browser        |
| Chats / Tasks  | Session toolbar actions          | Local panel toolbar              |
| Search         | Conversation / task details      | Diff / file / web page           |
|                |                                  | Independent scroll and focus     |
|                | Composer docked at the bottom    |                                  |
+----------------+----------------------------------+----------------------------------+
~~~

Default at desktop width: THREE columns — project/session navigation, Agent conversation and right Changes work surface. At compact widths preserve Agent conversation and open the work surface explicitly. Right pane supports resize, close, and maximize to primary area without reinitializing chat. With insufficient available width, the right target becomes a primary tab with a clear Back-to-conversation affordance; never shrink a code diff or browser into a fixed 320pt inspector or popover.

There is ONE right work-surface role with switchable tabs, not multiple permanent drawers. Planning and Knowledge remain optional lightweight context; real file editing/review and Browser belong to the work surface.

## 2. One native toolbar for the entire window

Leafspan is the structural reference: the macOS unified titlebar is the ONE window toolbar. It shows Product/Repository/Agent conversation context and contains Changes/Attachments switching, review-scope options, panel maximize/close and refresh. The NavigationSplitView sidebar toggle is the single native sidebar control.

No second Agent 44pt bar, no duplicate Changes tabstrip or review header, and no per-page pseudo-window toolbar. Actual content controls such as file selection, diff hunks and actions remain within their respective content areas, without a competing toolbar. Unimplemented Browser does not get a fake active action.

The navigation sidebar, central Agent transcript with docked composer, and right work surface are independently scrollable, with the right surface resizable. Changing work surface, closing or maximizing must not destroy the central conversation. On narrow windows the chat remains visible by default; explicitly opening review promotes the work surface to primary.

## 3. Non-negotiable plain-button rule (P0)

NO decorative card, capsule, raised rectangle, border, gradient or shadow wrapping each toolbar, navigation, row-action or tab button. The default command is bare readable text or icon+text, with platform plain-button behavior. This includes Return, Search, Refresh, More, Changes, Files, Browser and contextual controls. Do not place every action inside its own RoundedRectangle with softFill.

Allow surfaces only for real content zones (sidebar/editor/preview), the composer input well, code diff, selected list row, native dialogs, or genuinely necessary primary macOS controls. Removing decorative button backgrounds does NOT mean removing functional pane boundaries.

Prefer native semantic colors, one material per zone, subtle hover and row selection, keyboard-visible focus rings, no thick shadows, no decorative gradients. Hover must not be the only way to discover an action. Support Light/Dark, high contrast, Full Keyboard Access, VoiceOver and Reduce Motion.

Unify typography and geometry: session titles around 13–14pt; main body around 12–13pt; supporting text generally 11pt or larger; lengths and truncation handled consistently. No arbitrary 9pt actions or separate 10.5pt tokens sprinkled through pages.

## 4. Data, navigation and panel invariants

- Product Project → Requirement / Plan and linked Repository → Checkout are distinct. Breadcrumbs and tool scopes use the current conversation/task binding, not unrelated global selection.
- Opening and closing Changes / Files / Browser preserves conversation draft, attachments, scrolling and live execution.
- Reopening a tab restores its file, panel width, scroll and other view-local state where applicable; this is presentation state, never a second canonical domain store.
- Changes provides file navigator plus readable patch canvas (later unified/split diff); long code lines can scroll horizontally. Reuse existing Git review / commit / restore authority and confirmations.
- Project → Requirement → Agent → review → Back preserves original project, selected task, list position and navigation. Reuse existing projectDetailReturnContext rather than inventing another source of truth.
- Responsive widths are measured from remaining usable primary pane, not just outer window width. Sidebar and work surface collapse only when necessary.
- Only bounded transactions use modals; never put main project navigation or code review in modal sheets.

## 5. Migration map from existing SwiftUI

- ForgeNativeApp.swift / ForgeWorkspaceView: keep its ONE NavigationSplitView sidebar. Converge window actions into one native toolbar.
- ForgeNativeApp.swift / ForgeWorkspaceView.unifiedWindowToolbarActions: sole owner of titlebar actions and scene-local right pane state; AgentPane has no independent toolbar.
- AgentPane.semanticInspector: reserve for lightweight Planning/Knowledge context; do not mix it with Changes / Files / Browser.
- AgentPane + AgentChangesPane: changes on main as a standalone replacement (adf4f28fb) and its inner navigator (13994f87d) are INTERIM. Rehost existing Diff component in tabbed right work surface while keeping its data, actions and adjustable reader; allow maximize.
- ZenModeView.swift project navigation: stay in primary workbench, reuse Requirement return context and list position.
- AgentAssetsDashboard.swift: reuse its File preview as the right Files tab so chat does not disappear merely to inspect a file.
- ForgeClientDesign.swift: consolidate semantic typography, spacing, button states, panel geometry and breakpoints; no second theme or design plugin.

## 6. Implementation order and acceptance

1. Implement the shared three-column window shell with one native toolbar, resizable right pane, global tab selection/close/maximize. Rehost Diff; do not implement Browser automation yet.
2. Systematically remove card-style button backgrounds from navigation, workbench, Agent, changes and settings while preserving real surfaces and accessibility.
3. Complete Project → Requirement → Agent → Changes → Return and Agent → File → Source conversation without losing identity, scroll, composer or focus.
4. Only then add Browser webview and Agent control under a separate scoped Requirement and explicit grants.
5. Run matched native GUI and AX checks for 860 / 1100 / 1440 / 1800+ widths, both pane states, long diff lines, narrow transitions, keyboard, VoiceOver, Light/Dark and Reduce Motion.

Swift compilation is not a substitute for real GUI/AX acceptance. Preserve other Writer dirty and Process leases. Do not change the frozen Runtime, installed Client or release without separate authorization.

References: https://cursor.com/changelog/2-3 ; https://cursor.com/docs/release-notes ; https://cursor.com/docs/agent/tools/browser ; https://developer.apple.com/design/human-interface-guidelines/toolbars ; https://developer.apple.com/design/human-interface-guidelines/split-views
