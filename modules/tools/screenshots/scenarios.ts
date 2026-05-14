import type { Page } from "@playwright/test"

export interface Scenario {
  name: string
  route: "/tabs/home" | "/tabs/search" | "/tabs/notes"
  waitFor: string
  settle?: number
  beforeCapture?: (page: Page) => Promise<void>
}

declare global {
  interface Window {
    __shruti?: {
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
    const dbg = window.__shruti?.debug
    if (!dbg) throw new Error("debug bridge not installed")
    const id = dbg.demoTrackId()
    await dbg.setPlayerState(id, dbg.demoPositionMs())
    await dbg.openTranscript(id)
  })
  // Wait for the modal portal to mount in DOM so the selector wait can
  // resolve. Ionic adds the open class once it has appended the modal.
  await page.locator("ion-modal.transcript-dialog").waitFor({ state: "attached", timeout: 10_000 })
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
]
