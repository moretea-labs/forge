# Forge Client UI Design Contract

Authority: moretea-labs/forge#649 — 2026-11-22 (1A / 2B lock).
Scope: native macOS Client window architecture, layout, navigation, typography, panels and focus. This contract does not create or change Project/Requirement/Plan, Checkout, Provider, Git or Runtime authority.

## Locked product decisions (1A / 2B)

- **1A — Agent-first cold start.** With no restored navigation context, the Client opens on Agent conversation (`zenMode=false`, `page=.agent`) with the latest or bootstrap thread and a docked composer. New install / empty store must not land on the Zen workbench.
- **2B — Dual primary destinations.** Sidebar keeps peer entries `Agent | 工作台 | 自动任务 | 更多…`. Zen Requirement / Plan / Board remains an independent workbench destination; it is **not** merged into the Agent right work surface.
- **Browser deferred.** Do not present Browser as an active work-surface action until a separate authorized Requirement delivers a real pane. Disabled or omitted only — never a fake enabled control.
- Restored session state (persisted project/repo/checkout/thread) may reopen the last destination when an explicit navigation snapshot exists; empty/bootstrap state remains Agent.

## 1. Overall layout — Agent first, one window shell

Forge is an Agent-first workbench, not a set of disjoint screens. One native titlebar and one shared window shell continue across Agent, Workbench, Resources and Settings. No second permanent icon rail, duplicate sidebar, per-page window frame, or stacked decorative toolbar.

~~~text
macOS unified titlebar: [Sidebar] Project > repo/checkout > Agent|Workbench     Search | Layout | Right pane
+----------------+----------------------------------+----------------------------------+
| Destinations   | PRIMARY                          | Optional (Agent only)            |
| Agent*         | Transcript + docked composer     | Changes | Files                  |
| 工作台         | Zen board / canvas               | (no second permanent drawer)     |
| 自动任务/更多  | Schedule / Resources / …         |                                  |
| 238–286pt      | flexible; keep chat readable     | resizable, 360pt–55%             |
+----------------+----------------------------------+----------------------------------+
* default on cold start (1A)
~~~

Default at desktop width on Agent: THREE columns — destination/session navigation, Agent conversation and right Changes work surface. At compact widths preserve Agent conversation and open the work surface explicitly. Right pane supports resize, close, and maximize to primary area without reinitializing chat. With insufficient available width, the right target becomes a primary tab with a clear Back-to-conversation affordance; never shrink a code diff into a fixed 320pt inspector or popover.

There is ONE right work-surface role with switchable tabs (Changes | Files), used only while Agent is primary. Planning and Knowledge remain optional lightweight inspectors; they must not compete with Changes / Files. Workbench (2B) uses the same window shell and toolbar ownership without inventing a second right-drawer role.

## 2. One native toolbar for the entire window

Leafspan is the structural reference: the macOS unified titlebar is the ONE window toolbar. It shows Product/Repository/Agent-or-Workbench context and contains Changes/Files switching (Agent), panel maximize/close and refresh. The NavigationSplitView sidebar toggle is the single native sidebar control.

No second Agent 44pt bar, no duplicate Changes tabstrip or review header, and no per-page pseudo-window toolbar. Actual content controls such as file selection, diff hunks and actions remain within their respective content areas, without a competing toolbar.

The navigation sidebar, central primary pane, and (when open) right work surface are independently scrollable, with the right surface resizable. Changing work surface, closing or maximizing must not destroy the central conversation. Switching Agent ↔ 工作台 must preserve thread draft, attachments, `projectDetailReturnContext`, list position and right-pane SceneStorage where applicable.

## 3. Non-negotiable plain-button rule (P0)

NO decorative card, capsule, raised rectangle, border, gradient or shadow wrapping each toolbar, navigation, row-action or tab button. The default command is bare readable text or icon+text, with platform plain-button behavior. This includes Return, Search, Refresh, More, Changes, Files and contextual controls. Do not place every action inside its own RoundedRectangle with softFill.

Allow surfaces only for real content zones (sidebar/editor/preview), the composer input well, code diff, selected list row, native dialogs, or genuinely necessary primary macOS controls. Removing decorative button backgrounds does NOT mean removing functional pane boundaries.

Prefer native semantic colors, one material per zone, subtle hover and row selection, keyboard-visible focus rings, no thick shadows, no decorative gradients. Hover must not be the only way to discover an action. Support Light/Dark, high contrast, Full Keyboard Access, VoiceOver and Reduce Motion.

Unify typography and geometry through `ForgeClientDesign` (including former `ForgePalette` tokens): session titles around 13–14pt; main body around 12–13pt; supporting text generally 11pt or larger; lengths and truncation handled consistently. No arbitrary 9pt actions or separate 10.5pt tokens sprinkled through pages. No second theme engine.

## 4. Data, navigation and panel invariants

- Product Project → Requirement / Plan and linked Repository → Checkout are distinct. Breadcrumbs and tool scopes use the current conversation/task binding, not unrelated global selection.
- Opening and closing Changes / Files preserves conversation draft, attachments, scrolling and live execution.
- Reopening a tab restores its file, panel width, scroll and other view-local state where applicable; this is presentation state, never a second canonical domain store.
- Changes provides file navigator plus readable patch canvas (later unified/split diff); long code lines can scroll horizontally. Reuse existing Git review / commit / restore authority and confirmations.
- Project → Requirement → Agent → review → Back preserves original project, selected task, list position and navigation. Reuse existing projectDetailReturnContext rather than inventing another source of truth.
- Responsive widths are measured from remaining usable primary pane, not just outer window width. Sidebar and work surface collapse only when necessary.
- Only bounded transactions use modals; never put main project navigation or code review in modal sheets.

## 5. Source ownership map

- `ForgeClientShell.swift` / `ForgeWorkspaceView`: ONE `NavigationSplitView`; sole owner of titlebar actions and scene-local right pane state.
- `ForgeClientSidebar.swift`: destinations, thread tree, Zen sidebar host, project switcher.
- `AgentWorkbenchViews.swift`: `AgentPane`, Changes/Files work surface, composer-adjacent chat chrome; no independent window toolbar.
- `AgentPane` semantic inspectors: lightweight Planning/Knowledge only; do not mix with Changes / Files.
- `ZenModeView.swift`: peer workbench destination (2B); reuse Requirement return context and list position; share shell plain-button rules for nav/return chrome.
- `AgentAssetsDashboard.swift`: Files tab preview so chat does not disappear merely to inspect a file.
- `ForgeClientDesign.swift`: single semantic palette, typography, spacing, button states, panel geometry and breakpoints.
- `ForgeNativeApp.swift`: `@main`, `WindowGroup`, scene commands only.

## 6. Implementation order and acceptance

1. Lock 1A/2B in this contract and #649; default cold start to Agent.
2. Shared three-column Agent shell with one native toolbar, resizable right pane, tab selection/close/maximize. Rehost Diff; Browser remains deferred.
3. Split shell/sidebar/agent sources out of the former monolith; consolidate design tokens.
4. Systematically remove card-style button backgrounds from navigation, Agent chrome, changes and shared shell controls while preserving real surfaces and accessibility.
5. Prove Agent ↔ 工作台 ↔ Changes ↔ Return without losing identity, scroll, composer or focus.
6. Run matched native GUI and AX checks for 860 / 1100 / 1440 / 1800+ widths, both pane states, long diff lines, narrow transitions, keyboard, VoiceOver, Light/Dark and Reduce Motion.

Swift compilation is not a substitute for real GUI/AX acceptance. Preserve other Writer dirty and Process leases. Do not change the frozen Runtime, installed Client or release without separate authorization.

References: https://cursor.com/changelog/2-3 ; https://cursor.com/docs/release-notes ; https://cursor.com/docs/agent/tools/browser ; https://developer.apple.com/design/human-interface-guidelines/toolbars ; https://developer.apple.com/design/human-interface-guidelines/split-views
