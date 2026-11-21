# Forge Design/UI-UX · First-party knowledge v1

**Scope:** Generic UI/product-design method, not a product-specific layout or a new design state machine. This is a bundled Forge knowledge source. It must never supersede the current user's decisions, the product Issue, project `AGENTS.md`/`DESIGN.md`, frozen screens, Design Tokens, platform contracts or actual runtime evidence. No external Forge Design plugin, Artboard, Vite prototype or registered design project is required.

## Choose the smallest responsible mode

- **Visual detail / bug:** Inspect the current screen and accepted baseline, locate the actual component/token, make a bounded correction, then compare rendered before/after evidence. Do not restart product discovery for a 1pt icon adjustment.
- **Interaction / IA change:** Review the affected user journey, states, navigation, persistence, failure and recovery before changing the screen; include neighboring screens that share the semantics.
- **Redesign / new screen:** Explicitly establish User Job, product goal, primary/secondary tasks, journey, information roles, states, interaction patterns and Screen Family *before* composition, visual direction and tokens.
- **Accepted/frozen layout:** Never treat a generic UI optimization request as permission to alter a separately frozen structure. Preserve layout, content ownership and action discoverability until the user explicitly authorizes a different baseline.

## Product before pixels

1. Identify **User Job and outcome** (read, monitor, decide, manage, add, edit, delete, export). Know what must be understood or completed before leaving.
2. Trace the real **flow**: entry → search/filter/selection → action → save/cancel → detail/history → return and error recovery. Do not independently optimize a list item when create/edit/detail disagree about the record's meaning.
3. Classify information: identity/anchor, core meaning, action/status, evidence, exception, next step, provenance, secondary metadata. Database-field equality is not visual priority.
4. Inventory materially distinct states: empty, busy, loading, failed, disabled, read-only, filtered, normal, degraded, recovered. Show only decision-relevant state prominently.
5. Choose interaction semantics before visuals: search, filter, selection, sort, edit, delete, confirm, reversal, sheet, notification; share a pattern only when the *meaning and user task* match.
6. Choose compatible Screen Family grammar (dashboard, management/list, detail, editor, comparison/export) without copying a Golden from an unrelated family.

## Visual judgment, not layout arithmetic

- Prioritize hierarchy, scan order, density, alignment rhythm and space before surface, border, blur or shadow. Do not turn each field into a card or add nested boxes to simulate organization.
- **Optical centering differs from geometry:** Equal frames, center anchors, baseline coordinates, and identical padding do not prove visible balance. Inspect the rendered glyph silhouette, stroke weight, internal whitespace, asymmetry and apparent visual center. A small explicit optical offset is legitimate when supported by current screenshot evidence; do not remove it solely to make coordinates equal. Re-evaluate when font, symbol, size or platform changes.
- Keep touch/AX bounds independent of visible glyph bounds. Honor platform touch minimums, text scaling, locale lengths, safe area, contrast and VoiceOver ordering. A visually smaller face can have a larger accessible hit target.
- Cross-screen consistency has **four layers:** shared semantics → behavior → component/token contract → composition only for compatible Screen Families. Reuse a component without forcing different pages into identical layouts.
- Align tokens semantically; avoid naked/ad-hoc color, radius, shadow and spacing values when the product already defines a design system. Generic rules must not overwrite a project's accepted brand or deliberate visual differences.

## Evidence-driven review and closure

- Before implementation: compare the current product/approved baseline with the actual requested outcome; assess affected flow, exceptions and preserved behavior. Review product meaning, IA/interaction and visual intent in proportion to risk.
- After implementation: inspect a **real rendered screen**, not only SwiftUI/DOM layout code, a screenshot path, successful build or bounding-box test. View pixels and interact with meaningful states; check icon clearance, centering, clipping, line wrap, spatial rhythm, action discoverability, animation/reduced motion and return/recovery.
- For meaningful redesign review, include representative compact/large screens, long language/large type and at least normal, empty and failure states when relevant. Use existing simulator/browser/device tools; do not require the Forge Design plugin to inspect real product output.
- Treat `Captured` → `Model Visible` → `Visual Reviewed` as separate evidence states. Human acceptance is different from model review. `PASS`, `FAIL`, `BLOCKED`, `NOT RUN` must reflect actual evidence at the exact source revision, device/profile and state.
- A known frozen-design authorization failure blocks the forbidden structural change. Missing review does **not** generally block an ordinary code edit, but it prevents declaring a UI delivery visually accepted or ready for release when that evidence is required.
- Repeat only checks invalidated by the current change. Report uncovered cases and keep the existing product Issue open; do not create parallel progress owners or an extra UI design workflow lifecycle.

## Source and maintenance

This document is a **semantic consolidation**, not a verbatim copy. Original provenance:
- `moretea-labs/forge-design:docs/PRODUCT_DESIGN_WORKFLOW.md` (user job, flow, product model, Design Units and review)
- `moretea-labs/forge-design:docs/studio-visual-quality-workflow.md` (runtime preview, hierarchy, accessibility, real task review)
- `moretea-labs/forge:adapters/mcp/instructions.ts` (real rendered UI review; evidence and Issue ownership)
- Avela user correction, 2026-11-21: optical center must not be replaced by a geometric-center shortcut.

**Authority:** Forge-owned general knowledge; project-specific source is still sovereign. Any new generic Design guidance should update this canonical pack rather than forking another global Skill/Plugin rule. The accompanying manifest records the exact content digest.
