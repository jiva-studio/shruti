import type { Page } from "@playwright/test"

export interface Scenario {
  name: string
  route: "/tabs/home" | "/tabs/search" | "/tabs/notes" | "/tabs/chat"
  waitFor: string
  settle?: number
  beforeCapture?: (page: Page) => Promise<void>
}

/** Stable session id seeded by generate-fixtures/seedChat for the
 *  `05_chat` scenario. Same id in both EN and RU fixtures so one literal
 *  drives `debug.openChatSession(...)` for both locales. */
export const DEMO_CHAT_SESSION_ID = "chat_demo_soul"
/** Id of the user-question row inside the demo session — pinned to
 *  the top of the viewport in `beforeCapture` so the screenshot
 *  shows both "What is the soul?" AND the long assistant reply.
 *  Keep this in sync with chat.ts:`messages[0].id`. */
const DEMO_CHAT_USER_MESSAGE_ID = "msg_demo_soul_user"

declare global {
  interface Window {
    __lectorium?: {
      debug?: {
        demoTrackId: () => string
        demoPositionMs: () => number
        navigateTo: (path: string) => Promise<void>
        openChatSession: (sessionId: string) => Promise<void>
        openTranscript: (trackId: string) => Promise<void>
        setPlayerState: (trackId: string, positionMs: number) => Promise<void>
        setLocale: (loc: "en" | "ru") => void
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
  await pinChatUserMessageToTop(page)
}

async function pinChatUserMessageToTop(page: Page): Promise<void> {
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
  }, DEMO_CHAT_USER_MESSAGE_ID)
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

export const scenarios: Scenario[] = [
  {
    name: "01_home",
    route: "/tabs/home",
    // Heatmap mounts only when the playlist has tracks → seed must
    // populate `playlist_items` first (see generate-fixtures/seedPlaylist.ts).
    waitFor: ".activity-heatmap",
    settle: 600,
    // Park the floating player mid-playback so the screenshot shows the
    // app has an active player (and the bottom row renders its radial).
    beforeCapture: openHomeWithPlayer,
  },
  {
    name: "02_library",
    route: "/tabs/search",
    waitFor: ".track",
    settle: 600,
  },
  {
    name: "03_notes",
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
    name: "05_chat",
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
    name: "06_filters",
    route: "/tabs/search",
    // Wait for the open filters sheet's content (the list of dimensions),
    // not just the modal host, so the sheet has finished presenting.
    waitFor: "ion-modal.filters-sheet .view",
    settle: 700,
    beforeCapture: openSearchFilters,
  },
]
