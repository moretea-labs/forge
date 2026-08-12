---
version: alpha
name: Forge Quiet Utility
description: A restrained desktop utility console for configuring and inspecting the Forge controller behind ChatGPT.
colors:
  primary: "#2F6FED"
  canvas: "#F5F6F7"
  surface: "#FFFFFF"
  surface-subtle: "#F0F2F4"
  surface-hover: "#EAEDF0"
  border: "#D9DEE3"
  border-strong: "#C5CBD2"
  text: "#1D232A"
  text-secondary: "#5E6873"
  text-tertiary: "#818B96"
  accent-subtle: "#E9F0FF"
  success: "#267A52"
  success-subtle: "#E8F4EE"
  warning: "#956400"
  warning-subtle: "#FFF4D6"
  danger: "#B33A3A"
  danger-subtle: "#FBEAEA"
  focus: "#4C7FF0"
typography:
  page-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Display, PingFang SC, sans-serif"
    fontSize: 24px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: -0.02em
  section-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 15px
    fontWeight: 620
    lineHeight: 1.4
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.3
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  full: 999px
spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  sidebar: 216px
  content-max: 1180px
components:
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  navigation-selected:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  navigation-idle:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  divider:
    backgroundColor: "{colors.border}"
    height: "1px"
  divider-strong:
    backgroundColor: "{colors.border-strong}"
    height: "1px"
  row-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  meta-text:
    textColor: "{colors.text-tertiary}"
    typography: "{typography.body-small}"
  status-success:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.full}"
    size: "8px"
  status-warning:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.full}"
    size: "8px"
  status-danger:
    backgroundColor: "{colors.danger}"
    rounded: "{rounded.full}"
    size: "8px"
  notice-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  focus-indicator:
    backgroundColor: "{colors.focus}"
    rounded: "{rounded.full}"
    size: "2px"
  notice-warning:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  notice-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  secondary-surface:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
---

# Forge Quiet Utility

## Overview
Forge is operated primarily through ChatGPT. The local web UI is a **quiet technical utility**, not a second conversational assistant and not an agent-observability wall. It answers durable questions: what is configured, what is available, which long-lived automations exist, which repositories Forge knows, and whether the local system needs attention.

The interface should feel like a well-made macOS system utility: calm, compact, and trustworthy. Avoid futuristic AI visual language, dashboard theatrics, decorative gradients, fake progress, and card-heavy project-management patterns. Internal runtime identities are available through progressive disclosure rather than promoted into the primary hierarchy.

Primary navigation is **Overview, Work, Automations, Capabilities, Repositories, Settings**, with **System** visually separated as a low-frequency maintenance destination.

## Colors
Use neutral tonal layers as the default hierarchy. `{colors.canvas}` is the application background and `{colors.surface}` is the primary content surface. `{colors.surface-subtle}` groups secondary controls without floating-card noise.

`{colors.primary}` is the single interactive accent and is never decoration. Status uses a small semantic dot plus text: `{colors.success}`, `{colors.warning}`, or `{colors.danger}`. Large saturated status fills are prohibited.

Text uses `{colors.text}` for primary reading, `{colors.text-secondary}` for explanatory copy, and `{colors.text-tertiary}` only for low-priority metadata. Borders carry more hierarchy than shadows.

## Typography
Use the system-first Inter/SF Pro stack from the typography tokens. Page titles use `{typography.page-title}` but remain visually modest. Section titles use `{typography.section-title}`. Most information uses `{typography.body}` and compact metadata uses `{typography.body-small}`.

Do not create ad-hoc text sizes. Weight, spacing, and tonal contrast should establish hierarchy first. Technical identifiers use the system monospace stack only inside Advanced disclosure or paths.

## Layout
The desktop shell uses a fixed sidebar around `{spacing.sidebar}` and a fluid main column capped near `{spacing.content-max}`. Content aligns to one consistent left edge. Prefer lists, split panes, and simple sections over grids of equal cards.

Spacing follows a 4/8-based rhythm. Page sections generally use `{spacing.xl}` or `{spacing.2xl}` separation; compact rows use `{spacing.md}` to `{spacing.lg}`. Below approximately 880px the sidebar becomes a horizontal scrollable navigation strip without changing information hierarchy.

Overview is intentionally sparse. Work shows durable tracked work with categorical state only. Automations is configuration-first. Capabilities and Settings may use split panes when detail editing is useful.

## Elevation & Depth
Depth is achieved through **tonal layering and hairline borders**, not box shadows. Canvas, surfaces, hover states, and selected rows provide enough hierarchy. Modal or transient UI may use one subtle shadow; ordinary panels remain flat.

Avoid panel-inside-panel nesting. When adjacent areas share one semantic task, prefer a divider inside one surface.

## Shapes
Controls and rows use restrained `{rounded.sm}` to `{rounded.md}` radii. Only status dots and truly pill-shaped compact controls use `{rounded.full}`. Large 16–24px rounded rectangles are not part of the design language.

Icons are simple line icons or concise glyphs. They support scanability and never become decorative illustrations.

## Components
**AppShell** — fixed navigation plus one main content column. Product identity is “Forge”; do not expose “Local Bridge” as a user-facing product name.

**NavigationItem** — icon, short label, optional attention count. Selected state uses `{colors.accent-subtle}` and primary text rather than a bright filled button. System is separated from everyday destinations.

**StatusLine** — 8px semantic dot, status text, optional short explanation. Prefer this over colored pills.

**SummaryRow** — label, one coarse value, optional action. Used on Overview. It reads like a settings summary, not an analytics KPI tile.

**ResourceList** — default structure for Work, Automations, Capabilities, and Repositories. Rows have a primary name, short secondary context, categorical status, and at most one primary inline action.

**DetailPanel** — reveals configuration and advanced facts for one selected resource. Raw IDs, action schemas, evidence payloads, and diagnostics are closed by default.

**Notice** — compact warning/error/setup message with one concrete next action. Do not create a permanent alert wall.

**Button** — primary buttons are rare and use `{colors.accent}`. Ordinary management actions use neutral secondary buttons. Destructive styling appears only at the destructive decision.

**FormControl** — neutral bordered inputs with visible labels. Placeholder text is never a substitute for a label when a value has durable meaning.

**AutomationRow** — name, repository/scope, schedule description, enabled/paused/attention state, last coarse outcome, and next-run hint only when runtime state supports it. Never invent percentages or copy delivered report content into the row.

**CapabilityRow** — presents what Forge can do before how it is implemented. Provider, plugin action IDs, health payloads, and protocol detail are secondary.

## Do's and Don'ts
**Do** treat ChatGPT as the primary work and result surface.

**Do** show durable configuration, availability, categorical state, and concrete attention items.

**Do** distinguish Automations from model/provider routing settings.

**Do** keep repository scope explicit for repository-specific actions without implying a global current repository.

**Do** preserve low-level diagnostics under System/Advanced.

**Don't** add a conversational composer to the Forge home page.

**Don't** fabricate percentage progress, step completion, or “AI is thinking” telemetry from incomplete execution evidence.

**Don't** duplicate Gmail reports, research summaries, SEO results, or other delivered content merely because an automation produced them.

**Don't** expose Issue/Task/PlanStep/Run IDs in primary navigation or default rows.

**Don't** use large gradient backgrounds, glowing borders, nested cards, or a rainbow of status pills.
