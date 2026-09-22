# @jiva-studio/kit

Shared, **framework-agnostic** building blocks: generic primitives, a user-DB
migration engine, and themeable UI components.

## Principles

- **No business domain, no framework lock-in.** Generic primitives, infra and
  UI only — never app-specific domain models or business logic.
- **UI is framework-agnostic.** Components take text via props/slots (no `$t`
  calls) and emit events for navigation (no router imports).
- **Theming via CSS variables.** Components consume a token contract; the host
  supplies the values (light + dark). Neutral defaults ship in `theme/base.css`.

## Layout

```
src/
  core/        # Result, date utils, generic scalars
  persistence/ # generic user-DB engine: IDatabase, Migration, runMigrations
  ui/          # themeable primitives (Heatmap, StatBadge, SectionHeader, …)
  theme/       # base.css token stubs
```

## Develop

```
npm ci
npm run lint
npm run typecheck
npm test
```
