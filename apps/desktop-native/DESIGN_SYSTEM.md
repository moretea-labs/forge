# Forge Desktop Design System

This file is the visual authority for Forge Desktop. New UI must reuse shared tokens and modifiers in `ForgeClientDesign.swift` before introducing local styling.

## Character
Forge is content-first, compact, native, translucent, and quiet. The target is Cursor/Codex-class desktop chrome, not a dashboard full of cards.

## Navigation
- Activity rail is icon-only. Persistent text labels are prohibited; use tooltip and accessibility text.
- Rail icons use one optical size and stroke family.
- Selection is a faint wash, never a dark tile or colored button.
- Secondary actions are icon-first when the symbol is conventional.
- Do not duplicate an Inspector/open-panel action in adjacent toolbars or Composer.

## Glass and color
- Window, sidebar, Inspector, search, and Composer share one translucent material family.
- Prefer material and spacing hierarchy over separators, opaque slabs, thick strokes, cards, or shadows.
- Use semantic system colors plus ForgePalette tokens only.
- Accent color communicates action/status, not structure.
- Light and dark appearances must preserve the same hierarchy.

## Density and typography
- Desktop chrome stays compact; avoid stacked title bars.
- Use ForgeClientDesign spacing and typography metrics.
- Strong weight is reserved for hierarchy, not every selected row.
- Project/task metadata is smaller and quieter than primary content.
- Utility panes should not use oversized titles.

## Inspector
- One global entry point opens the work surface.
- Once open, the Inspector header owns close/maximize.
- Inspector tabs are compact and must not resemble a second app toolbar.

## Motion
- Chrome state changes use short ease-out transitions, roughly 120–180ms.
- Ordinary navigation must not use large page slide/fade effects.
- Respect Reduce Motion.

## Responsive review
- Prefer continuous adaptation over hard jumps.
- Reclaim navigation width before compressing reading content.
- Toolbars may simplify or wrap but must not overlap or truncate into partial labels.
- Shell changes are visually checked near 720px, 900px, and wide desktop widths.

## Acceptance
1. No local color, spacing, or font system added.
2. No duplicate navigation or Inspector action added.
3. Rail remains icon-only and tooltip-accessible.
4. Selection remains subtle in light and dark mode.
5. Compact window stays readable.
6. Empty states and metadata do not dominate.
7. A built-client screenshot is required; compilation alone is not visual acceptance.
