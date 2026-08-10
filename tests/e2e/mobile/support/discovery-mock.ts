import type { Page } from "@playwright/test"

/**
 * The "found on the internet" lane's service, offline.
 *
 * Offline there is nothing to ask, and an unmocked cross-origin POST per
 * keystroke would leave every library spec rendering an error strip — so a
 * default install rides on `interceptContent()` and answers every spec.
 *
 * The default answer is deliberately one hit of each shape: a YouTube address
 * (a poster is derivable, so it rides the carousel) and a plain mp3 on
 * somebody's web server (no poster, so it reads as a row). Everything the lane
 * can render beyond that — a hit with no title of its own, the service's
 * `messages`, an empty result, a failure — is reachable only by a spec asking
 * for it, which is what the options here are for.
 *
 * Wire shape mirrors `@lib/contracts/discovery` (snake_case, as the Go handler
 * emits it); the fields the app reads are the ones typed here.
 */
export interface DiscoveryHitStub {
  item_id: number
  media_url: string
  page_url?: string
  title?: string
  author?: string
  language?: string
  cover_url?: string
  recorded_on?: string
  references?: string[]
  collection?: { id: number; title: string; url?: string; ordinal: number; of: number }
  chunk?: string
  media_state?: string
  score: number
}

export interface DiscoveryMessageStub {
  field?: string
  kind: string
  text: string
}

export interface DiscoveryStubOptions {
  /** Replaces the default two hits. `[]` is the empty-result state. */
  hits?: DiscoveryHitStub[]
  /** Anything that happened to the request and is not a recording. */
  messages?: DiscoveryMessageStub[]
  /** Answer with this status instead of 200 — the lane's failure strip. */
  status?: number
  /** Record every request body the app sent, in order. */
  onRequest?: (body: unknown) => void
}

/** The two hits every spec gets unless it asks for others. */
export const DEFAULT_DISCOVERY_HITS: DiscoveryHitStub[] = [
  {
    item_id: 9001,
    media_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    page_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "A lecture published as video",
    author: "Test Speaker",
    language: "en",
    recorded_on: "1974-04-09T00:00:00Z",
    references: ["BG 4.20"],
    score: 0.9,
  },
  {
    item_id: 9002,
    media_url: "https://archive.example/talks/0001.mp3",
    page_url: "https://archive.example/talks/0001",
    title: "A lecture published as a file",
    author: "Test Speaker",
    language: "en",
    recorded_on: "1974-03-27T00:00:00Z",
    references: [],
    score: 0.8,
  },
]

/**
 * A recording the archive published without a title of its own. What the tile
 * must show is the span its references cover — never the media address.
 */
export const UNTITLED_DISCOVERY_HIT: DiscoveryHitStub = {
  item_id: 9003,
  media_url: "https://archive.example/talks/0002.mp3",
  page_url: "https://archive.example/talks/0002",
  title: "",
  author: "Test Speaker",
  language: "en",
  recorded_on: "1974-06-30T00:00:00Z",
  references: ["SB 7.5.33", "SB 7.5.34", "SB 7.5.35", "SB 7.5.36", "SB 7.5.37"],
  score: 0.7,
}

/**
 * Register the lane's route on the page. Later registrations win, so a spec may
 * call this again to replace what `interceptContent()` installed.
 */
export async function installDiscoveryMock(
  page: Page,
  options: DiscoveryStubOptions = {}
): Promise<void> {
  const { hits = DEFAULT_DISCOVERY_HITS, messages, status = 200, onRequest } = options
  await page.route("**/discovery/search", (route) => {
    if (onRequest) {
      try {
        onRequest(route.request().postDataJSON())
      } catch {
        onRequest(undefined)
      }
    }
    if (status !== 200) {
      void route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_configured", message: "no reader" } }),
      })
      return
    }
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ query: "", filter: {}, ...(messages ? { messages } : {}), hits }),
    })
  })
}
