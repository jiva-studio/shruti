# Frontend Coding Style & Component Guidelines

The conventions for Vue 3 and TypeScript in lectorium: the mobile app under `modules/apps/mobile` (Vue 3 + Ionic + Capacitor), the shared `modules/libs/ui`, and the `@kit/ui` primitives in the `modules/kit` submodule. The architecture these serve is in [`architecture.md`](./architecture.md) and, in full, in [`docs/repos/lectorium/architecture/layers.md`](../../docs/repos/lectorium/architecture/layers.md).

TypeScript is strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. A component's props are a contract with another module, and an unchecked one is not a contract.

---

## 1. The domain boundary

Nothing in `modules/libs/ui` or `@kit/ui` imports `@lib/contracts`, a wire type, a domain type, or anything under `modules/apps/**` — not the components, not the fixtures.

A component takes props it defines itself, in a **vocabulary about drawing**, and emits **opaque identifiers**. A prop named after a vault, a note or an RPC message is the boundary crossed even when its type is a string. Whoever renders the component translates the domain into that shape and translates the identifier back.

The dependency runs `modules/apps/*` → `modules/libs/ui`. Never back, never sideways.

---

## 2. The pure core and the humble view

Every component splits in two.

**The core is pure.** Given the props it computes what is to be drawn — every coordinate, every state, every derived flag — as plain values: no DOM, no Vue, no clock, no randomness, no measurement of text. It lives in plain modules beside the component (`carry.ts`, `measure.ts`, `sizing.ts`, `model/`), each with its own `.test.ts`.

**The view is humble.** It receives those values and turns them into elements. It works nothing out. A number appearing in a template that the core did not produce is a broken split, and so is a `computed` reaching for `window`, `Date.now` or an element's size.

**Anything with a lifetime is a port**: the clock, `requestAnimationFrame`, the viewport, the motion preference. Each is a parameter with a browser-shaped default.

A `computed` in a `.vue` file is a thin projection. Loops, index arithmetic, string parsing and transformations belong in the pure modules, where they are tested without mounting anything.

---

## 3. Component directories

A component owns a directory under `src/`, named for the thing it draws:

```text
src/plex/
├── Plex.vue              # the humble view
├── Plex.stories.ts       # the corpus
├── Plex.test.ts          # what is emitted, and what is not
├── carry.ts              # pure modules, each with its own test beside it
├── carry.test.ts
├── model/                # the concept: the union, and what varies with it
├── render/               # what the view needs to draw the computed values
└── fixtures/             # awkward on purpose, and never taken from the domain
```

What an application may use is re-exported from `src/index.ts`, and that list is narrower than what the module contains: how a component is built is not how it is used.

**A component is split when it holds a second responsibility** — a section with independent state, or a part rendered on its own elsewhere. Length is not a rule and is never a review finding.

**A polymorphic component dispatches, it does not inline.** Where a component renders distinct variants by kind, the parent is a shallow dispatcher and each variant is its own component; a heavy dependency — an editor, a composer, a form — is never imported into something that renders a high-frequency row.

---

## 4. Section structure

Inside `<script setup lang="ts">`, in this order, with only the sections that exist:

```vue
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

/* --------------------------------- Props ---------------------------------- */
const props = defineProps<{ ... }>()

/* --------------------------------- Events --------------------------------- */
const emit = defineEmits<{ ... }>()

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

**Props → Events (or Props & Emits) → State → Hooks → Handlers → Helpers**, in the 80-character banner form. The components in the tree still carry the short `// --- <Name> ---` form and are being migrated; a new or touched component takes the banner.

---

## 5. Props, emits and state

- Type-based only: `defineProps<Props>()`, with `withDefaults` where a default is wanted. A runtime object declaration is not used.
- Every event a component emits is declared in `defineEmits<Emits>()`.
- Emits are kebab-case in the template (`@item-selected`); the handler in the script is `onItemSelected`. `update:*` for a model.
- **Do not declare sibling events differing only by a flag.** `annotate: [block?: boolean]`, not `annotate` and `annotateBlock`.
- **A second behaviour is a function, never a mode flag** — and only where a second implementation is intended. A knob with one setting is a knob nobody has read.
- **A concept is declared once.** A role, a state, a variant: the type union, the layout, the wording and the colour all read from one declaration.
- No component queries the DOM to read state. State flows through props, emits and models.
- No mutation of a prop, and no destructuring of a reactive object or store without `toRefs()` / `storeToRefs()`.
- A `watch` that could be a `computed` is a finding: derived state recomputed by hand goes stale.
- Everything started has an owner that ends it — a listener, a timer, an observer, a subscription.

---

## 6. Types and results

- Types and interfaces are singular nouns: `Tab`, `FileEntry`, `MoveResult`, `TranscriptSegment`. Never a gerund, an adjective or a verb.
- Booleans are `is…` / `has…` / `can…`. Fields are noun phrases that say what they hold: `title`, `completedCount`, `failureReason` — not `about`, `doing`, `done`.
- A fallible operation returns a discriminated result:
  ```ts
  type Result<T, E = ErrorCode> = { ok: true; value: T } | { ok: false; error: E }
  ```
  A bare value, an implicit `null`, or a second word for the failure discriminant (`refusal`, `reason`) is a finding. The word is **`error`**.
- No `any`. No `as` casting away a type the code could state. No non-null assertion standing in for a check.
- No empty `catch {}`. Every catch handles, rethrows, or carries a statement saying why it is safely ignored.

---

## 7. Naming and placement

- **Functions and methods** are imperative verb phrases (`getTranscript`, `createTab`, `openVault`) or predicates. Never third-person singular (`carries`, `reads`), never a past participle (`listened`, `spoken`), never a literary metaphor where a standard term exists.
- **Handlers** are `on<Action>`.
- **Composables** are named `use<Feature>` — never a gerund, never a bare noun. The file they live in is either that name (`useAppHotkeys.ts`) or the word for what the module is about (`useWorkspaceTabs` lives in `windowing.ts`, `useVaultStatus` in `showing.ts`); both are in use, and the module word is the more common of the two.
- **A composable has one coherent responsibility.** A composable that takes an entire component's script — every piece of state, every handler, a long list of exports — is that component undecomposed. Split the component instead.
- **Factories are `create…`.** The word `make` is not used for a factory in frontend code.
- **Files**: directories `kebab-case`, components `PascalCase`, other TypeScript `camelCase`.
- **Domain code stays in its domain.** Code serving one domain lives in that domain's folder — `note/`, `files/`, `cards/`, `recording/`. There is no `tabs/` folder and no `shared/`: what two or more domains genuinely use sits at the top of `src/` under the word for what it is (`transport.ts`, `theme.ts`, `words.ts`).

---

## 8. Styling

**The component library is shadcn-vue*.*

- **Every colour, size, radius and duration is a design token.** A literal hex, a raw `rgb()`, a hardcoded duration or a Tailwind palette class (`bg-slate-800`) in a component is a finding.
- **Tokens are declared on the root alone**, in `src/tokens/tokens.css`. A custom property declared on an element beats the same property inherited from the root, so a component declaring its own is a component a theme no longer reaches.
- **The theme defines its names from the tokens, never the reverse**, so a utility class and the CSS variable behind it resolve to one value. Ionic's own variables (`--ion-color-*`) are set from the tokens in one place, never overridden per component.
- **No `dark:` variant anywhere in the module**, including in a component copied in from the shadcn-vue registry — the tokens are `light-dark()` pairs and `color-scheme` chooses.
- **The root's font size is the interface multiplier.** What follows the interface is in `rem`; a hairline, a border, a focus ring and the stroke of a handle are one physical line and stay in `px`.
- A component copied in from the registry is edited on the way in: its palette, its `dark:` variants and its types are this module's problem from that point, because the source is now this module's own.

---

## 9. Stories and tests

**How an interface component is built*, *How this application is tested*.*

- **A component is built in Storybook**, in isolation, before any application renders it. One built inside a screen has whatever edge cases that screen happened to contain.
- **The stories are the corpus, and they are awkward on purpose**: empty, one, far too many, text that is not Latin, text far too long, text with nothing to break at, and no text at all.
- **A setting is a control.** Anything reachable by turning a knob is an `argType`, and a second story differing only by the value of one is deleted.
- **Three levels of test.** The assertions that matter sit on the pure core as plain functions. The component in jsdom covers what is emitted and what is drawn — and **the negatives belong there**, because what is *not* emitted and *not* drawn fails silently and looks right in every screenshot. The stories run as tests in a browser.
- **Both engines.** The window is WebKit on Linux and macOS, Chromium on Windows, so every story renders in both through Playwright. A run that saw one engine did not see the product.
- **A test must be able to fail.** Break the rule and watch: "the nodes were arranged" and "the component rendered" pass under almost any implementation.

---

## 10. Nothing formats TypeScript, Vue or Markdown

*TypeScript and Vue are formatted by hand.* Prettier is not installed, no package depends on it, and none declares a `format` script. **A pull request that adds one is a change to that record**, taken before the code and not alongside it.

What holds a file to a shape instead:

- `.editorconfig` — encoding, line endings, the final newline, trailing whitespace, the indent. It settles what nobody has an opinion about.
- **ESLint, with the house rules in `modules/tools/lint`** — what is wrong, never what is pretty. A rule there refuses something a reader would trip over: a gerund where a verb belongs, a composable in the wrong shape, an empty catch, a style rule nothing can reach, a dead export, a `ref` mishandled, a module reaching where it may not. Each carries its own test.
- The reviewer. Layout is read like the rest of the code.

`gofmt` is not an exception to any of this: it is part of Go rather than a choice made about it.

**A generated file is whatever generated it.** Nothing under the protocol's generated output is hand-formatted, linted for layout, or read for style, and a formatter that has touched it is a defect in the formatter's configuration.

---

## 11. Comments

A comment states the rule that holds, and stops. It never names an alternative that is not in the code and never cites an ADR number. Delete each clause in turn: what still describes the code is the comment, and the rest was argument.

---

## 12. Verification

```bash
cd modules/libs/ui
npm run typecheck
npm run test:unit
npm run build                                   # vue-tsc then vite; @kit/* resolves through the submodule
vitest run --project 'stories (chromium)'
vitest run --project 'stories (webkit)'
```

Take the `modules/libs/ui` suites **one at a time**. `npm test` there starts both story instances at once and the run dies before any test executes.

Then the windows, which need the library built first:

```bash
cd modules/apps/desktop/editor         && npm run typecheck && npm test
cd modules/apps/desktop/flashcards && npm run typecheck && npm test
```

`make lint` and `make test` from the repository root cover both sides, with the one-at-a-time caveat above.
