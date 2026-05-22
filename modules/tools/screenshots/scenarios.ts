import type { Page } from "@playwright/test"

export interface Scenario {
  name: string
  route: "/tabs/home" | "/tabs/search" | "/tabs/notes" | `/tabs/chat/${string}`
  waitFor: string
  settle?: number
  beforeCapture?: (page: Page) => Promise<void>
}

/** Stable session id seeded by generate-fixtures/seedChat for the
 *  `05_chat` scenario. Same id in both EN and RU fixtures so the
 *  scenario can carry one literal `/tabs/chat/<id>` route. */
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
        openTranscript: (trackId: string) => Promise<void>
        setPlayerState: (trackId: string, positionMs: number) => Promise<void>
        setLocale: (loc: "en" | "ru") => void
      }
    }
  }
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

export const scenarios: Scenario[] = [
  {
    name: "01_home",
    route: "/tabs/home",
    // Heatmap mounts only when the playlist has tracks → seed must
    // populate `playlist_items` first (see generate-fixtures/seedPlaylist.ts).
    waitFor: ".activity-heatmap",
    settle: 600,
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
    // Demo session seeded by generate-fixtures/seedChat — same id in
    // both locales so this literal works for phone-en + phone-ru.
    route: `/tabs/chat/${DEMO_CHAT_SESSION_ID}`,
    // Wait for the assistant bubble to mount: it carries the verse
    // card + citation chip which are the visual centrepiece. Until
    // the verseBodyStore has hydrated the verse falls back to a
    // chip, so scope to the bubble itself and let `settle` cover
    // the Preferences round-trip.
    waitFor: ".bubble.assistant",
    settle: 800,
    beforeCapture: pinChatUserMessageToTop,
  },
]
