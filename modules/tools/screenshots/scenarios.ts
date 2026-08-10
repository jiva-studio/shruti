import type { Page } from "@playwright/test"
import { contentLanguageFor, type CaptureLocale } from "./config.js"

export interface Scenario {
  name: string
  route:
    | "/tabs/home"
    | "/tabs/search"
    | "/tabs/search/tracks"
    | "/tabs/notes"
    | "/tabs/chat"
    | "/tabs/settings"
  waitFor: string
  settle?: number
  beforeCapture?: (page: Page, code: CaptureLocale) => Promise<void>
}

/** Stable session id seeded by generate-fixtures/seedChat for the
 *  `03_chat` scenario. Same id in both EN and RU fixtures so one literal
 *  drives `debug.openChatSession(...)` for both locales. */
export const DEMO_CHAT_SESSION_ID = "chat_demo_soul"
/** Id of the user-question row inside the demo session — pinned to
 *  the top of the viewport in `beforeCapture` so the screenshot
 *  shows both "What is the soul?" AND the long assistant reply.
 *  Keep this in sync with chat.ts:`messages[0].id`. */
const DEMO_CHAT_USER_MESSAGE_ID = "msg_demo_soul_user"

/** Remembrance-video demo session — its assistant reply carries a
 *  `[media:…]` marker → MediaCard. Keep in sync with chat.ts
 *  `DEMO_MEDIA_SESSION_ID` / its first message id. */
export const DEMO_MEDIA_SESSION_ID = "chat_demo_remembrance"
const DEMO_MEDIA_USER_MESSAGE_ID = "msg_demo_remembrance_user"

declare global {
  interface Window {
    __lectorium?: {
      debug?: {
        demoTrackId: () => string
        demoPositionMs: () => number
        navigateTo: (path: string) => Promise<void>
        openChatSession: (sessionId: string) => Promise<void>
        openTranscript: (trackId: string) => Promise<void>
        openTrackSheet: (trackId: string) => void
        setPlayerState: (trackId: string, positionMs: number) => Promise<void>
        setLocale: (loc: "en" | "ru") => Promise<void>
        setSubscription: (value: "free" | "pro" | "default") => void
      }
    }
  }
}

/** Position (ms) the demo track's floating player is parked at on Home.
 *  ~8 min into the ~33-min "Когда Господь улыбается" lecture → a ~25%
 *  progress radial on both the floating player and that bottom row. */
const HOME_PLAYER_POSITION_MS = 500_000

async function openHomeWithPlayer(page: Page): Promise<void> {
  // Drive the floating player into an open, mid-playback state so the
  // Home screenshot shows there IS a player (otherwise it's invisible and
  // the screen reads as "no playback"). `setPlayerState` sets the player
  // store directly — it does NOT call `openTrack`, so the
  // `openTranscriptAutomatically` setting won't pop the transcript dialog.
  // The track is the demo (bottom row of the queue); the player owns its
  // row → it renders the "playing" radial there.
  await page.evaluate(async (positionMs) => {
    const dbg = window.__lectorium?.debug
    if (!dbg) throw new Error("debug bridge not installed")
    await dbg.setPlayerState(dbg.demoTrackId(), positionMs)
  }, HOME_PLAYER_POSITION_MS)
  // FloatingPlayer (root class `.player.floating`) shows once the player
  // store has a track and the route isn't chat — see App.vue
  // `floatingPlayerHidden`.
  await page.locator(".player.floating").first().waitFor({ state: "visible", timeout: 10_000 })
}

async function openTranscriptMidPlayback(page: Page): Promise<void> {
  // Drive the floating player + transcript dialog into a known "currently
  // playing, mid-track" state: one block shows `.current`, another already
  // has a saved note → `.highlighted`. Seeded `notes` rows in user.db
  // anchor the `.highlighted` blocks; the player state below puts the
  // playhead inside the second seeded sentence so `.current` is non-empty.
  await page.evaluate(async () => {
    const dbg = window.__lectorium?.debug
    if (!dbg) throw new Error("debug bridge not installed")
    const id = dbg.demoTrackId()
    await dbg.setPlayerState(id, dbg.demoPositionMs())
    await dbg.openTranscript(id)
  })
  // Wait for the modal portal to mount in DOM so the selector wait can
  // resolve. Ionic adds the open class once it has appended the modal.
  await page.locator("ion-modal.transcript-dialog").waitFor({ state: "attached", timeout: 10_000 })
}

async function openDemoChatSession(page: Page): Promise<void> {
  // Open the seeded demo session through the debug bridge rather than a
  // `?session=` deep link. ChatView opens a session reactively from the
  // route query (ensureSessionFromRoute), but `useRoute()` in that
  // controller is unreliable under the Vite-dev DI race — in the
  // dev-served screenshots build the query watcher never fires, so a
  // deep link lands on the empty chat home. `openChatSession` drives the
  // store's `openSession` directly (same call the recent-chat tap makes)
  // and syncs the URL, so the captured frame is a genuinely-open session.
  await page.evaluate(
    (id) => window.__lectorium!.debug!.openChatSession(id),
    DEMO_CHAT_SESSION_ID
  )
  await pinChatUserMessageToTop(page, DEMO_CHAT_USER_MESSAGE_ID)
}

async function openDemoMediaSession(page: Page): Promise<void> {
  // Same debug-bridge path as openDemoChatSession (see there for why we
  // don't deep-link). Opens the remembrance session whose assistant reply
  // renders the MediaCard, then pins the user question to the top so the
  // frame shows the question, the intro line, and the video card.
  await page.evaluate(
    (id) => window.__lectorium!.debug!.openChatSession(id),
    DEMO_MEDIA_SESSION_ID
  )
  await pinChatUserMessageToTop(page, DEMO_MEDIA_USER_MESSAGE_ID)
}

async function pinChatUserMessageToTop(page: Page, messageId: string): Promise<void> {
  // ChatView's `onMounted → ensureSessionFromRoute → openSession →
  // scrollToBottom()` lands the viewport on the last message — for
  // the assistant's long verse-card reply that scrolls the user's
  // "What is the soul?" bubble off-screen. We re-anchor here to mimic
  // the live app's mid-streaming behaviour (`scrollMessageToTop` in
  // ChatView.controller pins the just-sent user bubble at the top of
  // the viewport), so the screenshot shows Q + A on one frame.
  //
  // Wait until the controller flips `scrollReady=true` (removes the
  // `is-loading` class) — otherwise the controller's auto-scroll
  // would run AFTER ours and overwrite it.
  await page
    .locator(".chat-scroll:not(.is-loading)")
    .waitFor({ state: "attached", timeout: 10_000 })
  await page.evaluate((id) => {
    const target = document.querySelector(
      `[data-message-id="${id}"]`
    ) as HTMLElement | null
    target?.scrollIntoView({ block: "start", behavior: "auto" })
  }, messageId)
}

async function openSearchFilters(page: Page): Promise<void> {
  // Open the filters bottom-sheet the same way a tap does — there is no
  // debug-bridge hook for it, so click the filter button in the search
  // header (`.search-row-filter-button` → sets `filtersOpen = true`).
  // The sheet is an IonModal (`.filters-sheet`) presented at its 0.9
  // breakpoint, listing every filter dimension (author, source, place,
  // tag, duration, sort).
  await page.locator(".search-row-filter-button").click()
  await page
    .locator("ion-modal.filters-sheet")
    .waitFor({ state: "visible", timeout: 10_000 })
}

async function settleDiscoveryCovers(page: Page): Promise<void> {
  // Collection / topic covers resolve through an ASYNC local image cache: the
  // <img> only mounts once its cached URL is ready, then fades in on load, and
  // the card flips `.is-loaded`. So a fixed delay (or an `img.complete` check —
  // a not-yet-mounted cover isn't even in the DOM) leaves tiles blank. Instead
  // poll the loaded-cover count and only proceed once it has STOPPED growing
  // for a beat — adapts to a slow cache without guessing a duration.
  await page
    .waitForFunction(
      () => {
        const w = window as unknown as { __covN?: number; __covAt?: number }
        const n = document.querySelectorAll(".collection-card.is-loaded").length
        const now = performance.now()
        if (n !== w.__covN) {
          w.__covN = n
          w.__covAt = now
          return false
        }
        // Settled: count unchanged for 1.2s and at least one cover is in.
        return n > 0 && now - (w.__covAt ?? now) >= 1200
      },
      null,
      { timeout: 15_000, polling: 200 }
    )
    .catch(() => {
      // Best-effort: capture whatever loaded rather than failing the scenario.
    })
}

/** Track whose detail sheet we open for the `05_track` scenario, keyed by
 *  CONTENT language (the only two that exist). RU has a rich lecture
 *  (description + chapter outline + topic chips); EN lectures carry no
 *  outline/description/topics in the catalog yet, so the EN sheet shows title +
 *  author + the share / add-to-playlist actions only. A UI locale without its
 *  own audio resolves to the English demo via contentLanguageFor. */
const SHEET_DEMO_TRACK: Record<"en" | "ru", string> = {
  en: "track_0M6TgFqYKo01",
  // Short description (~5 lines) + 4-chapter outline + topic chips, so the
  // whole sheet — description, chips and "Содержание" — fits above the fold.
  ru: "track_9ociWb0Sh2St",
}

async function openTrackSheet(page: Page, code: CaptureLocale): Promise<void> {
  // Open the unified per-track bottom sheet (<TrackSheet>) the same way a
  // track-row tap does — there's no gesture to script reliably under the
  // dev-server DI race, so drive useTrackSheetStore directly via the debug
  // bridge. The sheet loads its detail (description / outline / topics)
  // asynchronously; waiting for the pinned footer actions means the modal has
  // finished presenting, and `settle` covers the detail round-trip.
  await page.evaluate(
    (trackId) => window.__lectorium!.debug!.openTrackSheet(trackId),
    SHEET_DEMO_TRACK[contentLanguageFor(code)]
  )
  await page
    .locator("ion-modal.track-sheet .sheet-actions")
    .waitFor({ state: "visible", timeout: 10_000 })
}

async function openSmartLibrary(page: Page): Promise<void> {
  // The Smart Library entry is Pro-gated (tapping it opens the paywall when
  // not subscribed). Force a subscribed state via the debug bridge so the tap
  // opens the dialog, then tap the row. The dialog is an IonModal.
  //
  // `setSubscription("pro")` re-evaluates Pro gating app-wide; on some locales
  // that recompute bounces the Ionic router back to /tabs/home and destroys
  // the execution context mid-`evaluate`. So: set pro FIRST (tolerating a
  // navigation that kills the evaluate — retry once it settles), then RE-enter
  // settings explicitly (the bounce may have left us on home) before opening
  // the dialog.
  await evaluateThroughNavigation(page, () =>
    window.__lectorium!.debug!.setSubscription("pro")
  )
  await page.evaluate(() => window.__lectorium!.debug!.navigateTo("/tabs/settings"))
  await page.waitForURL("**/tabs/settings", { timeout: 10_000 })
  const row = page.locator("[data-testid=settings-smart-library]")
  await row.waitFor({ state: "visible", timeout: 10_000 })
  await row.click()
  await page
    .locator("ion-modal.smart-library-dialog")
    .waitFor({ state: "visible", timeout: 10_000 })
}

/**
 * Run a debug-bridge `page.evaluate` that may itself trigger an app navigation
 * (Ionic route bounce), which Playwright surfaces as "Execution context was
 * destroyed". The bridge call is fire-and-forget on the app side, so re-running
 * it after the route settles is safe and idempotent.
 */
async function evaluateThroughNavigation(
  page: Page,
  fn: () => void
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.evaluate(fn)
      return
    } catch (err) {
      if (!/Execution context was destroyed/.test(String(err))) throw err
      await page.waitForTimeout(300)
    }
  }
  // Last attempt: let a genuine failure surface instead of swallowing it.
  await page.evaluate(fn)
}

async function scrollToPlaybackSettings(page: Page): Promise<void> {
  // The "and much more" slide bundles continuous playback (Autoplay), auto
  // scroll and the track-info layout — the three Pro rows at the bottom of the
  // appearance section. Pin the first of them (Autoplay) to the top of the
  // viewport so the top-cropped slide shows all three with their PRO badges,
  // not the account rows.
  //
  // Wait for the row to mount BEFORE touching it — this hook runs right after
  // `waitForURL("**/tabs/settings")`, while the route transition / appLanguage
  // re-seed (skews to fallback locales like sr/uk) can still navigate and
  // destroy the execution context mid-scroll `evaluate`. `locator.waitFor`
  // survives that; `page.evaluate` does not.
  await page
    .locator("[data-testid=settings-track-info]")
    .waitFor({ state: "visible", timeout: 10_000 })
  await page.locator("[data-testid=settings-track-info]").scrollIntoViewIfNeeded()
  await page
    .locator("[data-testid=settings-autoplay]")
    .evaluate((el) => el.scrollIntoView({ block: "start" }))
}

// The `NN_` filename prefix sets the order screenshots appear in the stores
// (App Store / Play sort by filename), independent of this array's order.
// Display order: home → search → chat → transcript → track → notes → library → filters.
export const scenarios: Scenario[] = [
  {
    name: "01_home",
    route: "/tabs/home",
    // Activity card mounts only when the playlist has tracks / there's seeded
    // activity → seed must populate `playlist_items` first (see
    // generate-fixtures/seedPlaylist.ts).
    waitFor: ".activity-card",
    settle: 600,
    // Park the floating player mid-playback so the screenshot shows the
    // app has an active player (and the bottom row renders its radial).
    beforeCapture: openHomeWithPlayer,
  },
  {
    // The flat, filterable catalog list — the old "search" page, now reached
    // via Search → "All lectures" and living at /tabs/search/tracks (the
    // /tabs/search root is the new discovery/browse page, see 02_search).
    name: "07_library",
    route: "/tabs/search/tracks",
    waitFor: ".track",
    settle: 600,
  },
  {
    name: "06_notes",
    route: "/tabs/notes",
    waitFor: ".note",
    settle: 600,
  },
  {
    name: "04_transcript",
    route: "/tabs/home",
    // Scope `.current` / `.highlighted` to the transcript so we don't
    // false-match Ionic's own .current on tab buttons or settings rows.
    waitFor: ".transcript-text .highlighted, .transcript-text .current",
    settle: 800,
    beforeCapture: openTranscriptMidPlayback,
  },
  {
    name: "03_chat",
    // Land on the stable chat pathname, then open the seeded demo
    // session in `beforeCapture` via the debug bridge (see
    // openDemoChatSession for why we don't deep-link the session here).
    route: "/tabs/chat",
    // Wait for the assistant bubble to mount: it carries the verse
    // card + citation chip which are the visual centrepiece. Until
    // the verseBodyStore has hydrated the verse falls back to a
    // chip, so scope to the bubble itself and let `settle` cover
    // the Preferences round-trip.
    waitFor: ".bubble.assistant",
    settle: 800,
    beforeCapture: openDemoChatSession,
  },
  {
    // The filters bottom-sheet lives on the catalog list (TracksView), not the
    // discovery root — open it there.
    name: "08_filters",
    route: "/tabs/search/tracks",
    // Wait for the open filters sheet's content (the list of dimensions),
    // not just the modal host, so the sheet has finished presenting.
    waitFor: "ion-modal.filters-sheet .view",
    settle: 700,
    beforeCapture: openSearchFilters,
  },
  {
    // The redesigned discovery/browse page: "recommended for you", collection
    // carousels (groups), a topic-tile grid, and lecture shelves. Wait for the
    // first cover card — a carousel collection OR a topic tile: collections are
    // stored per content-language (en/ru only), so a UI locale without its own
    // collections (e.g. sr-Latn) shows the topic grid but no carousels. Topics
    // fall back, so the tile grid is the one section present for every locale.
    name: "02_search",
    route: "/tabs/search",
    waitFor: ".carousel-section .collection-card, .tile-section .collection-card",
    settle: 600,
    beforeCapture: settleDiscoveryCovers,
  },
  {
    // The unified per-track detail bottom sheet (<TrackSheet>) that opens when a
    // track is tapped: title, description, chapter outline, topic chips, and the
    // share / add-to-playlist actions. Opened over the catalog list.
    name: "05_track",
    route: "/tabs/search/tracks",
    waitFor: "ion-modal.track-sheet .sheet-actions",
    settle: 700,
    beforeCapture: openTrackSheet,
  },
  {
    name: "07_media",
    // Stable chat pathname, then open the remembrance session in
    // `beforeCapture` (same debug-bridge approach as 03_chat).
    route: "/tabs/chat",
    // Wait for the MediaCard itself — its poster + play overlay are the
    // visual centrepiece. The card renders only once the message's
    // `media` payload is present (seeded into the chat_messages meta), so
    // this also guards against an empty bubble. `settle` covers the
    // poster fetch (intercepted → committed fixture) + decode.
    waitFor: ".media-card",
    settle: 1000,
    beforeCapture: openDemoMediaSession,
  },
  // These two don't ship to the stores — they feed the in-app subscription /
  // onboarding paywall screenshot strip (public/onboarding/<lang>/<name>.webp,
  // downscaled from the raw capture). They have no frame/titles.json headline,
  // so frame.spec skips them and fastlane never uploads them.
  {
    name: "smartLibrary",
    route: "/tabs/settings",
    waitFor: "ion-modal.smart-library-dialog",
    settle: 500,
    beforeCapture: openSmartLibrary,
  },
  {
    name: "more",
    route: "/tabs/settings",
    waitFor: "[data-testid=settings-autoplay]",
    settle: 400,
    beforeCapture: scrollToPlaybackSettings,
  },
]
