---
version: "2.0"
name: Forge Utility Workstation
description: A precise light-first desktop utility for configuring and inspecting Forge behind ChatGPT, combining Carbon structure with Linear restraint.
colors:
  canvas: "#F5F5F3"
  surface: "#FFFFFF"
  surface-subtle: "#F0F0EE"
  surface-strong: "#E8E8E5"
  rail: "#19191B"
  rail-hover: "#242427"
  rail-selected: "#303037"
  text: "#1D1D20"
  text-secondary: "#646469"
  text-tertiary: "#909096"
  text-inverse: "#F7F7F8"
  border: "#E1E1DE"
  border-strong: "#CECECA"
  primary: "#584EE3"
  accent: "#5E54E8"
  accent-hover: "#5046D9"
  accent-subtle: "#EFEEFF"
  success: "#237A57"
  success-subtle: "#EAF5EF"
  warning: "#946200"
  warning-subtle: "#FFF4D8"
  danger: "#B44444"
  danger-subtle: "#FBECEC"
  info: "#3567B7"
  focus: "#786FF7"
typography:
  page-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Display, PingFang SC, sans-serif"
    fontSize: 24px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: -0.02em
  section-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 15px
    fontWeight: 620
    lineHeight: 1.35
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.45
  meta:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.35
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  full: 999px
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 20px
  6: 24px
  8: 32px
  10: 40px
  12: 48px
  rail: 224px
  content-max: 1280px
components:
  app-canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
  sidebar:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text-inverse}"
  sidebar-hover:
    backgroundColor: "{colors.rail-hover}"
    textColor: "{colors.text-inverse}"
  sidebar-selected:
    backgroundColor: "{colors.rail-selected}"
    textColor: "{colors.text-inverse}"
  secondary-surface:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-secondary}"
  segmented-track:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.text-secondary}"
  strong-divider:
    backgroundColor: "{colors.border-strong}"
    height: "1px"
  accent-selection:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
  accent-subtle-surface:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  accent-hover-state:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#FFFFFF"
  tertiary-text:
    textColor: "{colors.text-tertiary}"
  success-notice:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
  secondary-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.4}"
  selected-row:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.3}"
  divider:
    backgroundColor: "{colors.border}"
    height: "1px"
  status-success:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.full}"
    size: "7px"
  status-warning:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.full}"
    size: "7px"
  status-danger:
    backgroundColor: "{colors.danger}"
    rounded: "{rounded.full}"
    size: "7px"
  status-info:
    backgroundColor: "{colors.info}"
    rounded: "{rounded.full}"
    size: "7px"
  notice-warning:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  notice-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  focus-ring:
    backgroundColor: "{colors.focus}"
    rounded: "{rounded.sm}"
    size: "2px"
---

# Forge Utility Workstation

## Overview
Forge is operated primarily through ChatGPT. The web UI is the durable **configuration and inspection surface behind ChatGPT**: not a second chat interface, not Jira, and not an agent execution wall. It answers what is configured, what Forge can do, which automations exist, which repositories are registered, and what genuinely needs human attention.

The visual direction is **Carbon × Linear Utility Workstation**. Carbon contributes structural rigor, explicit status semantics and dense information grammar. Linear contributes restrained surfaces, hairline hierarchy, sparse accent usage and quiet technical polish. The Investment Decision System is a proven local reference for dark-rail/light-canvas separation, semantic tokens and page grammar, but Forge keeps its own identity.

## Product principles
### Configuration before telemetry
The console primarily shows what Forge **is configured to do**. Execution details, verbose results, logs and conversations remain in ChatGPT or System diagnostics.

### Density without card spam
Use aligned rows, tables, split panes and whitespace. A card must answer one coherent question; never create one rounded rectangle per fact. Avoid panel-inside-panel nesting.

### Truthful state only
Never render guessed percentage progress. States are categorical and backed by controller facts: enabled, paused, ready, attention, active, waiting, completed, unavailable.

### Progressive technical depth
Daily pages use product language. Runtime ids, raw actions, schemas, leases and diagnostics belong in detail panes or System.

### Backend remains authoritative
React formats and filters facts from Local Bridge APIs. It does not reimplement scheduling, plugin readiness, repository identity or execution policy.

## Token architecture
Primitive values live in `frontend/src/design/tokens.css`. Components consume semantic variables such as canvas, surface, text, border, accent and semantic status. Page components must not introduce ad-hoc hex colors, radii or shadows.

## Color system
The application is light-first: warm-neutral `{colors.canvas}`, white `{colors.surface}`, near-black `{colors.rail}` navigation and near-black `{colors.text}` ink. `{colors.accent}` is the single Forge interaction accent and is used for selection, focus and primary action—not decoration.

Status color is local and compact. Critical state is always paired with text. Large red/green background blocks are prohibited.

## Typography
Use `{typography.page-title}` for page titles, `{typography.section-title}` for section headings, `{typography.body}` for dense product text and `{typography.meta}` for timestamps and identifiers. Long objectives truncate in scan lists and expand in the detail pane.

## Layout
Desktop uses a persistent `{spacing.rail}` dark rail and an open workspace capped near `{spacing.content-max}`. The main canvas is not wrapped in one giant card. Top-level sections are separated by rhythm and hairline dividers.

Below 980px, split panes collapse into list then detail blocks. Below 760px the rail becomes compact horizontal navigation while preserving hierarchy.

## Elevation
Ordinary content uses flat surfaces and 1px hairlines. Shadows are reserved for floating overlays. Use surface ladder and spacing to communicate depth.

## Shapes
Normal controls use `{rounded.sm}`; panels use `{rounded.md}` only when an enclosure is semantically useful. Pills are reserved for segmented filters and compact categories. Avoid oversized 16–24px rounding.

## Application shell
### Sidebar
Dark, persistent and quiet. It contains Forge identity, grouped navigation, and a small footer communicating that ChatGPT is the primary work surface. Selection uses a restrained accent indicator and darker surface, not a bright full-width pill.

### Command bar
Each route owns a compact command bar: eyebrow, title, one-line purpose, refreshed time and route actions. `Open ChatGPT` remains globally available but visually secondary.

## Page composition rules
Each workspace has **one dominant information region** and at most one contextual secondary region. Pages are not collections of cards; layout, typography, aligned columns, whitespace and hairlines establish hierarchy before enclosure.

Collections use rows or tables. A selected entity uses one contextual detail pane. Configuration uses titled sections with field rows. Metrics stay inline or in compact definition rows unless direct metric comparison is the task. Normal state is visually neutral; semantic color is reserved for exceptions, attention and explicit interaction.

## Core component grammar
### Metric strip
Metric strips are exceptional. Use them only when comparing coarse operational facts is itself useful; never make equal metric cards the default page composition.

### Data list
Primary scanning surface for Work, Capabilities and Repositories. Rows use hairline separators and bounded one-line context.

### Data table
Primary surface for Automations. Columns align schedule, source, status, last and next facts. Selection drives a detail pane.

### Detail pane
A single contextual pane explains the selected object and owns actions/configuration. It replaces nested cards and repeated full descriptions.

### Status text
Use a 7px dot plus short text. Filled badges are exceptional.

## Page grammar
### Overview
Overview is the repository portfolio home. Keep the command bar compact, then make **Repository activity** the dominant region: show the most recently active repositories, their open Work count, attention count, and at most two bounded Work titles. A narrow contextual rail may contain deduplicated Needs attention and coarse System facts. Healthy Runtime state never consumes a hero panel; Runtime becomes a compact context row and only expands into a banner when degraded. No prompt composer, run timeline, persistent-goal card wall, equal metric grid or decorative posture hero.

### Automations
Use a configuration-first table with Name, Schedule, Scope, Delivery, Status, Last and Next; filters Enabled / Paused / Attention / All; selected detail pane with exact source and Run/Pause/Resume. Never duplicate report body.

### Work
Use Active / Waiting / Completed / All filters, a dense goal list and selected detail pane. No percentage, PlanStep or Run timeline.

### Capabilities
Use category filters Extensions / Services / Execution / Models / All, compact catalog rows and a detail pane with provider, health, lifecycle, capabilities and warnings. Raw MCP actions are Advanced only.

### Repositories
Use a searchable compact registry list/table and selected detail pane. Adding a repository is an inline form, not another dashboard card.

### Settings
Use a narrow grouped settings column. Rows own their controls. Credentials and routing protocol details live under Advanced.

### System
Maintenance only: posture summary, compact definition tables, and progressively disclosed diagnostics. Visually separate it from daily work.

## Interaction & motion
Transitions are 120–160ms and limited to background, border, opacity and pane movement. No bounce, scale-on-hover or decorative animation. Focus-visible states are mandatory. Destructive actions retain backend authorization.

## Do / Don't
### Do
- prefer one strong hierarchy per page;
- use open canvas and hairlines before adding a container;
- truncate scan-list copy and reveal depth contextually;
- keep status next to the fact it qualifies;
- keep ChatGPT as primary work and notification surface;
- use shared tokens and components for every route.

### Don't
- render a dashboard of equal rounded cards;
- expose internal execution ids as primary labels;
- fabricate progress or infer completion percentage;
- repeat full objectives in every row;
- use gradients, glows or “AI futuristic” decoration;
- use more than one primary accent family;
- duplicate ChatGPT result feeds inside the utility console.
