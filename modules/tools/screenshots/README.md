# Lectorium screenshots pipeline

Playwright-driven pipeline that captures store screenshots of the Lectorium mobile app and composites them into Google Play / App Store device frames.

Three independent stages: fixtures → capture → frame.

## Quick start

```bash
# 1. install
npm install
npx playwright install chromium

# 2. stage the content DB (one-time; not committed)
cp ../../../../resources/lake-out/artifacts/catalog/current.db fixtures/content.db

# 3. generate the user DB fixtures (one per CAPTURE_LOCALES entry)
npm run generate-user-fixture

# 4. capture raw screenshots
npm run capture
# → out/raw/phone-en/0X_*.png   (1236×2676)
# → out/raw/phone-ru/0X_*.png

# 5. wrap in device frame + localized headline
npm run frame
# → out/framed/phone-en/0X_*.png  (same dims, ready for Play Console)
# → out/framed/phone-ru/0X_*.png
```

The capture spec autostarts the mobile app's Vite dev server via
`npm run dev:screenshots` (sets `VITE_DEBUG_API=true` so the dev-only
debug bridge at `modules/apps/mobile/lectorium/services/debug/` is
installed). Production builds tree-shake the bridge entirely.

## Scenarios

| Name | Route | What it shows |
|------|-------|---------------|
| `01_home` | `/tabs/home` | Activity heatmap (90+ days seeded) + "Up Next" playlist |
| `02_search` | `/tabs/search` | Discovery/browse page — recommendations, collection carousels, topic tiles, lecture shelves |
| `03_chat` | `/tabs/chat?session=<id>` | Sadhu chat answering "What is the soul?" — full verse card (BG 2.20) + citation chip |
| `04_transcript` | TranscriptDialog | Mid-playback transcript with `.current` and `.highlighted` blocks |
| `05_track` | TrackSheet | Per-track detail bottom-sheet — description, chapter outline, topic chips, share / add-to-playlist |
| `06_notes` | `/tabs/notes` | 4 bookmarks anchored to real transcript sentences |
| `07_library` | `/tabs/search/tracks` | Flat, filterable catalog list (Bhagavad-gita, sorted by reference) |
| `08_filters` | `/tabs/search/tracks` | Filters bottom-sheet over the catalog list (author/source/place/tag/duration/sort) |

> Audio/transcripts/outlines exist only in `en` + `ru`. UI locales without
> their own audio fall back to English content (see `contentLanguageFor` in
> `config.ts`). `08_track` is rich in `ru` but title-only in `en` (EN lectures
> carry no description/outline/topics in the catalog yet), and the `07_search`
> "Recommended" row surfaces RU lectures under an EN UI for the same reason.

Per scenario: `scenarios.ts` — selectors + optional `beforeCapture` hook.

## Locales & devices

Devices come from `DEVICES` in `config.ts`. **Locales come from the shared store
registry** `modules/apps/mobile/store-locales.json` — the single source of truth
that fastlane reads too. `config.ts` derives `CAPTURE_LOCALES` from it (entries
with `capture !== false`); the Playwright projects (`${device}-${locale}`),
capture, fixtures, and framing all follow.

To add a language to the stores + screenshots:

1. **Add one entry** to `store-locales.json` (the key must be one of the app's
   `SUPPORTED_LOCALES`). Set its `play` / `appStore` codes — use `null` for a
   store that doesn't support the language (e.g. Serbian on the App Store).
2. **Headlines:** `OPENROUTER_API_KEY=… npm run translate-titles` fills in
   `frame/titles.json` for any new locale (canonical `en`/`ru` are never
   touched). Review the result.
3. **Store copy:** `OPENROUTER_API_KEY=… npm run translate-store-copy`
   translates the canonical English listing into the new locale's
   `metadata/{android,ios}/<code>/` files. Review the result.
4. **Fixture:** `npm run generate-user-fixture` (loops the capture set).

Then the fastlane `screenshots` / `metadata` lanes pick the locale up
automatically. A locale with no headline yet is skipped at the framing stage,
not an error.

> Translations are machine-generated and **must be reviewed** before going live
> (no invented features, no calques). The fastlane lanes stage everything for
> review and never auto-submit. Some scripts need an extra `frame/fonts/`
> subset — Latin-script locales with diacritics (Polish, Serbian) use
> `rubik-latin-ext-*`.

## Adding a scenario

1. Pick a route, a CSS selector that exists when the page is ready.
2. Add an entry to `scenarios.ts`.
3. (Optional) Add a `beforeCapture(page, code)` hook that drives the app into
   the target state via `window.__lectorium.debug` (see `services/debug/index.ts`).
4. Add an entry to `frame/titles.json` with the localized headline.

## Layout

```
package.json                 # capture / frame / generate-user-fixture / translate-*
playwright.config.ts         # vite webServer + projects generated from config.ts
config.ts                    # DEVICES + CAPTURE_LOCALES (derived from store-locales.json)
scenarios.ts                 # scenario definitions (single source of truth)
fixtures/
  content.db                 # local mirror of catalog/current.db (gitignored)
  user-<locale>.db           # generated per capture locale (gitignored)
generate-fixtures/
  index.ts                   # cli entry — sql.js + migrations + seeders
  tracks.ts                  # curated demo track IDs
  chat.ts                    # `05_chat` session content + verse-body cache seed
translate/
  llm.ts                     # OpenRouter helper (reads OPENROUTER_API_KEY)
  titles.ts                  # translate-titles  → fills frame/titles.json
  store-copy.ts              # translate-store-copy → fills fastlane metadata
specs/
  capture.spec.ts            # navigate → wait → screenshot
  frame.spec.ts              # composite raw PNG into frame/template.html
frame/
  template.html, .css        # phone silhouette + headline layout
  fonts/rubik-{cyrillic,latin,latin-ext}-{400,700}-normal.woff2
  titles.json                # localized headlines per scenario
out/                         # all generated artifacts (gitignored)
```

The locale registry lives at `../../apps/mobile/store-locales.json` and is shared
with `modules/apps/mobile/fastlane/Fastfile`, which uses it to drive its
`screenshots` (capture + upload) and `metadata` (listing-copy upload) lanes.
Canonical English listing copy lives in `fastlane/metadata/{android,ios}/en-US/`.
