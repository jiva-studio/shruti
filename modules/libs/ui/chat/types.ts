/**
 * UI mirror types for the shared chat cards.
 *
 * `@lib/ui` is a presentation library: it must not import `@lib/domain`
 * (enforced by the `submodules/ui/**` eslint block). The cards therefore
 * declare structurally-identical mirrors of the chat payloads that hosts
 * feed them — the mobile app passes its `@lib/domain/chatMessage` objects,
 * the web app passes objects it builds straight from the SSE wire, and both
 * are assignable to these shapes.
 *
 * Each mirror carries **only the fields the card renders**, not the whole
 * domain payload. A mirror is a snapshot, not a live link: when a card starts
 * rendering a new field, add it here in the same change.
 */

/** Mirror of the domain `ChatVerseBody` — `VerseCard.vue`. */
export interface UiChatVerseBody {
  readonly addrLabel: string
  readonly sanskrit: string
  readonly transliteration: string
  /** Original IAST transliteration, shown when the user flips to the original. */
  readonly transliterationOriginal?: string
  /** Language of the shown `translation` entry; absent ⇒ fall back to the locale prop. */
  readonly lang?: string
  readonly translation: { readonly [lang: string]: string }
  /** Full public URL of the Sanskrit recitation, when one exists. */
  readonly audioUrl?: string
  /** True when the active-locale translation is machine-generated. */
  readonly mt?: boolean
}

/** Mirror of the domain `ChatCiteSnippet` — `CitationCard.vue` renders the
 *  quote text only; every other field it shows arrives as its own prop. */
export interface UiChatCiteSnippet {
  readonly text: string
}

/** Mirror of the domain `ChatChapterBody` — `ChapterCard.vue`. */
export interface UiChatChapterBody {
  readonly regionLabel: string
  readonly chapters: readonly {
    readonly tokens: string
    readonly title: string
    /** Source-language title, present only when `mt` is true. */
    readonly titleOriginal?: string
  }[]
  /** At least one title is machine-translated — gates the card's
   *  TranslationNotice and its view-original toggle. */
  readonly mt?: boolean
}

/** Mirror of the domain `ChatCommentaryBody` — `CommentaryCard.vue` renders the
 *  attribution line; the quote itself arrives pre-rendered as `bodyHtml`. */
export interface UiChatCommentaryBody {
  readonly authorName: string
  /** Human address / reference, e.g. "БГ 2.13". */
  readonly addrLabel: string
}

/** Mirror of the domain `MediaPayload` — `MediaCard.vue`. */
export interface UiMediaPayload {
  readonly type: "video" | "audio"
  readonly title: string
  readonly text: string
  readonly speaker?: string
  readonly date?: string
}
