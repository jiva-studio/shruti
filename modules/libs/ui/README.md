# `@lib/ui` — shared UI components

Vue single-file components rendered by **both** hosts: the mobile app
(`modules/apps/mobile`, which symlinks this directory as `submodules/ui`) and
the Astro web site (`modules/apps/web`). Separate from the mobile app's own
`ui/**` layer, which is app-local and may use Ionic.

Everything here is a pure leaf — props in, events out. No store, no repository,
no data fetching, no domain object. Each host wraps a component in a thin
container that resolves the data.

| Directory | What it holds |
|---|---|
| `chat/` | Chat answer cards (verse, citation, commentary, chapter, media, outline, track) and their pieces, plus `types.ts` |
| `transcript/` | Transcript view, block text, verse-ref chip, `renderInlineMarkdown` |
| `player/` | `AudioPlayerBar`, `Waveform` |
| `input/` | `FloatingInput`, `FloatingInputButton` |
| `excerpt/` | `ExcerptCard` |
| `primitives/` | `HighlightText` |

## Boundary

Enforced by the `submodules/ui/**` block in
`modules/apps/mobile/eslint.config.js`. May import `vue`, `marked`, the shared
kernel (`@lib/contracts`, `@kit/*`) and its own files. Must **not** import
`@lib/domain`, `@lib/persistence/*`, `@usecases`, `@ports/*`, `@infra/*`,
`@shruti/*`, `@capacitor/*`, `@ui/*` or `@ionic/*`.

Domain payload shapes the chat cards render are mirrored in `chat/types.ts`
rather than imported. A mirror carries only the fields the card renders and is
a snapshot, not a live link — extend it in the same change that starts using a
new field.

Full write-up: [`docs/repos/shruti/components/lib-ui.md`](../../../docs/repos/shruti/components/lib-ui.md).
