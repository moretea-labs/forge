## Iron Rules

### 1. Good Taste
- Prefer data structures over branch explosion.
- More than 3 branches or nesting levels is a refactor signal.

### 2. Pragmatism
- Solve real constraints first.
- Keep defaults inferred; ask only override-level questions.

### 3. Zero Compatibility Debt
- No compatibility shims as default behavior.
- Use deprecation + replacement routing instead of hidden forks.

### 4. Project-Specific Prohibitions

{{PROHIBITIONS}}

### 5. Detailed Standards (On Demand)

Use the nearest source-level `AGENTS.md` / `CLAUDE.md`, existing static checks, tests, and the project Requirement/Issue authority. Do not create a parallel internal documentation tree.

---
