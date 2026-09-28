# Frontend Coding Style & Component Guidelines

The conventions for TypeScript and Vue in shruti: the mobile app (`modules/apps/mobile`, Vue 3 + Ionic + Capacitor), the libraries it compiles (`modules/libs/{domain,contracts,catalog,chat,persistence,ui}`), the `@kit/*` toolkit in `modules/kit`, and the Astro site in `modules/apps/web`. The layers and what each may import are in [`architecture.md`](./architecture.md) and, in full, in [`layers.md`](../../docs/repos/shruti/architecture/layers.md).

TypeScript is `strict`. A component's props are a contract with another module.

---

## 1. Layers, briefly

- `@lib/domain` and `@usecases` are pure: no `vue`, no Ionic, no Capacitor, no clock, no randomness.
- `@ui/*` is humble: it takes props in a vocabulary about drawing and emits events. It never imports `@lib/domain`, `@usecases`, `@ports` or `@infra`. When it needs a domain shape it declares a **mirror type** in a local `types.ts`, and one builder in `shruti/composables/` converts domain values into it.
- `shruti/` (views, stores, composables, router) is the composition root. It calls use cases; it does not reach `@infra` from a view.
- Network access goes through a port implemented in `@infra/*`; a component never calls `fetch`.

---

## 2. The pure core and the humble view

- What a component draws is computed in plain modules beside it (or in a use case), each with its own test. The `.vue` file turns those values into elements.
- A `computed` in a `.vue` file is a thin projection. Loops, index arithmetic, parsing and transformations belong in the pure module.
- Anything with a lifetime is a port or a parameter: the clock, `requestAnimationFrame`, the viewport, `matchMedia`. ESLint refuses them in `usecases/` and `ports/`.

---

## 3. Section structure

Inside `<script setup lang="ts">`, in this order, with only the sections that exist:

```vue
<script setup lang="ts">
import { computed, ref, onMounted } from "vue"

/* --------------------------------- Props ---------------------------------- */
const props = defineProps<Props>()

/* --------------------------------- Events --------------------------------- */
const emit = defineEmits<Emits>()

/* --------------------------------- State ---------------------------------- */
const isOpen = ref(false)

/* --------------------------------- Hooks ---------------------------------- */
onMounted(() => { ... })

/* -------------------------------- Handlers -------------------------------- */
function onSubmit() { ... }

/* -------------------------------- Helpers --------------------------------- */
function formatValue(val: string) { ... }
</script>
```

---

## 4. Props, emits and state

- Type-based only: `defineProps<Props>()`, `withDefaults` where a default is wanted.
- Every emitted event is declared in `defineEmits<Emits>()`; kebab-case in the template, `on<Action>` handlers in the script.
- No nested ternaries in a template, no logic in an event binding, no `querySelector` for state.
- No mutation of a prop; no destructuring of a reactive object or store without `toRefs()` / `storeToRefs()`.
- A `watch` that could be a `computed` is a finding.
- Everything started has an owner that ends it: listeners, timers, observers, subscriptions — and an async continuation checks that its owner is still alive (`disposed`, a generation counter, the signed-in user id) before writing state.
- `useI18n()` only inside `setup`; stores and plain modules use `i18n.global.t`.

---

## 5. Types and results

- Types are singular nouns: `Track`, `PlaylistItem`, `TranscriptBlock`.
- Booleans are `is…` / `has…` / `can…`.
- A fallible operation returns `Result<T, E>` from `@kit/core` (`ok` / `err`).
- No `any`, no `as` casting away a type the code could state, no non-null assertion standing in for a check.
- No empty `catch {}`; a `.catch(() => undefined)` is the same thing. Handle, rethrow, or say in a comment why ignoring is safe.

---

## 6. Naming and placement

- Functions are imperative verb phrases (`loadTranscript`, `addTrackToPlaylist`) or predicates. Handlers are `on<Action>`. Composables are `use<Feature>`. Factories are `create…`.
- Files: directories `kebab-case` or `camelCase` as the neighbours are, components `PascalCase`, other TypeScript `camelCase`.
- Use cases live in `usecases/<feature>/`, one exported function per scenario.
- A multi-step write on the user database goes through `IUnitOfWork.run`.

---

## 7. Styling and formatting

- Prettier formats TypeScript and Vue: `semi: false`, `singleQuote: false`, `printWidth: 100`, `trailingComma: "es5"` (`.prettierrc.json` in the mobile app and the kit). ESLint runs it as `prettier/prettier`; never hand-format around it. `npx eslint --fix` applies it.
- Colours and spacing come from the Ionic theme variables and the app's CSS custom properties in `shruti/theme/`; a literal hex in a component is a finding.

---

## 8. Tests

- Vitest for the app and the kit. Use cases and pure modules are tested as plain functions; components cover what is emitted and drawn — including what is **not** emitted.
- **A test must be able to fail.** Break the rule and watch it go red.
- Mutation testing is mandatory for the mobile app: `make mutate-diff` (Stryker, `stryker.config.json`) must pass on every change to it.
- End-to-end: `make e2e` (Playwright over the web build) and `make native` (Appium on an emulator; rebuild first with `make native-build`).

---

## 9. Comments

[`comments.md`](./comments.md) applies.

---

## 10. Verification

From the repository root:

```bash
make check-mobile                          # eslint, vue-tsc, vitest for the app and the libs it compiles
make check-kit                             # the same for @kit
make check-web                             # astro check
make check-package PKG=modules/apps/mobile # any of the above, by path
make mutate-diff                           # Stryker on the files this branch changed
make check-architecture                    # dependency-cruiser and the gate self-test
```

A fresh worktree needs `npm ci` in `modules/apps/mobile` (the gate runs it when `node_modules` is missing) and a build of the in-house plugins (`npm ci && npm run build` in `modules/plugins/audio-player` and `modules/plugins/media-downloader`) before `make check-architecture` and before the native suite.
