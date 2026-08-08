/**
 * Discovery search **wire protocol** — the transport contract between the
 * clients and the discovery Go service (`POST /discovery/search`), the index of
 * lectures published on archives we do not own.
 *
 * Hand-authored to mirror the Go handler in the JSON shape it emits
 * (snake_case). Lives in `@lib/contracts` for the same reason the ingest and
 * sync contracts do: the port below is consumed by application code and
 * implemented by an infrastructure adapter (`@infra/discovery/http/*`).
 *
 * Scope: **pure transport**. Nothing here knows what a carousel is or which
 * hits have covers.
 */

/**
 * What narrows a search. Everything is optional and everything is a list where
 * an interface offers several — the server refuses a request that carries
 * neither a question nor one of these.
 *
 * `text` and `query` are the two ways to hand over words, and they are not the
 * same request. `query` is read by a model that folds the sentence into these
 * same fields ("lectures by Radhanath Swami from 2019" becomes an author and a
 * year); `text` is searched as written and costs no model at all. Typing sends
 * `text`; the magnifier sends `query`.
 */
export interface DiscoveryFilter {
  readonly text?: string
  /** Speakers, written the way a person writes them — the server resolves. */
  readonly authors?: readonly string[]
  /** Two-letter codes, matching what the corpus stores. */
  readonly languages?: readonly string[]
  /** Scriptures. Any spelling the canon knows resolves — a code ("SB"), a name
   *  ("Бхагавад-гита"), marked or plain. */
  readonly sources?: readonly string[]
  /** A coordinate inside those scriptures: "2.13". */
  readonly tokens?: string
  /** A reference as a person writes it: "BG 2.13". */
  readonly ref?: string
  readonly collection?: string
  /** ISO dates, "2019-01-31". */
  readonly date_from?: string
  readonly date_to?: string
  readonly limit?: number
  readonly offset?: number
}

/** `POST /discovery/search` request: a question, a filter, or both. */
export interface DiscoverySearchRequest {
  readonly query?: string
  readonly filter?: DiscoveryFilter
}

/** Where a recording sits inside a cycle of talks. */
export interface DiscoveryHitCollection {
  readonly id: number
  readonly title: string
  readonly url?: string
  readonly ordinal: number
  readonly of: number
}

/** One recording found on some archive. */
export interface DiscoveryHit {
  readonly item_id: number
  /** The audio/video address. This is what gets handed to ingest. */
  readonly media_url: string
  /** The page it was found on, where there was one. */
  readonly page_url?: string
  readonly title?: string
  readonly author?: string
  readonly location?: string
  readonly language?: string
  readonly recorded_on?: string
  readonly references?: readonly string[]
  readonly source?: string
  readonly collection?: DiscoveryHitCollection
  /** The passage that matched, for showing why this came back. */
  readonly chunk?: string
  readonly score: number
  /** "present", or "vanished" when the file stopped appearing on its page. */
  readonly media_state?: string
}

/**
 * Anything that happened to the request and is not a recording: a name that
 * matches nobody, a field the sentence overruled, a reader that was not
 * configured.
 *
 * Worth surfacing rather than dropping. An empty list cannot say whether the
 * corpus holds nothing or the question could never have matched, and those are
 * different things to tell somebody.
 */
export interface DiscoveryMessage {
  readonly field?: string
  readonly kind: string
  readonly text: string
}

/** `POST /discovery/search` response. */
export interface DiscoverySearchResponse {
  /** The question exactly as it was asked. */
  readonly query: string
  /** The filter it was read into — send it back with one field changed rather
   *  than rewriting the sentence and hoping it reads the same way. */
  readonly filter: DiscoveryFilter
  readonly messages?: readonly DiscoveryMessage[]
  readonly hits: readonly DiscoveryHit[]
}

/** Transport port: ask the index what it has. */
export interface IDiscoveryClient {
  search(
    req: DiscoverySearchRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<DiscoverySearchResponse>
}
