import type {
  ChatActionPayload,
  ChatChapterBody,
  ChatOutlinePayload,
  MediaPayload,
} from "@lib/domain/chatMessage.js"
import type { ResearchSourceKind } from "@lib/contracts"

/** What folding one stream event tells its consumer. The chat store turns
 *  each into a reactive mutation; the finalised message is built from the
 *  fold's cards and state, not from these. */
export type ChatFoldEvent =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "tool-start" }
  | {
      readonly kind: "status"
      /** Server-emitted i18n key — e.g. "searching_corpus",
       *  "composing_answer". The store maps it to a localized label
       *  via `t(`chat.status.${statusKey}`, params)`. */
      readonly statusKey: string
      readonly params?: Readonly<Record<string, string | number>>
    }
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly payload: ChatActionPayload
    }
  | {
      readonly kind: "outline"
      readonly trackId: string
      readonly payload: ChatOutlinePayload
    }
  | {
      readonly kind: "verse-payload"
      readonly sourceId: string
      readonly tokens: string
      readonly addrLabel: string
      readonly sanskrit: string
      readonly transliteration: string
      /** Original IAST (Latin) transliteration; present only when the shown
       *  one is a different script. Flips with the translation on toggle. */
      readonly transliterationOriginal?: string
      /** Language of the shown `translation` entry, resolved server-side. */
      readonly lang?: string
      readonly translation: { readonly [lang: string]: string }
      readonly audioUrl?: string
      /** True when `translation[lang]` is a machine translation — the card
       *  surfaces a footnote + toggle to the original `translation.en`. */
      readonly mt?: boolean
    }
  /** Chapter-location region for one `[chapter:source/region|label]`
   *  marker (locate intent), streamed ahead of its marker. The store
   *  caches it so `ChapterCard.vue` renders the chapter list; absent ⇒
   *  the chip fallback. */
  | {
      readonly kind: "chapter-payload"
      readonly sourceId: string
      readonly regionToken: string
      readonly regionLabel: string
      readonly chapters: ChatChapterBody["chapters"]
      /** At least one title is machine-translated — the card discloses it. */
      readonly mt?: boolean
    }
  /** Transcript snippet for one `[cite:track@start-end|caption]`
   *  fragment, streamed ahead of its marker. The store caches it so
   *  `CitationCard.vue` renders the full quote block; absent ⇒ the chip
   *  fallback. */
  | {
      readonly kind: "cite-transcript-payload"
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      readonly text: string
      /** True when `text` is a machine translation — the card surfaces a
       *  footnote + toggle to `textOriginal`. */
      readonly mt?: boolean
      /** Verbatim source-language transcript, present only when `mt`. */
      readonly textOriginal?: string
    }
  /** Purport / prose-chapter / letter citation for one `[commentary:<ref>]`
   *  marker, streamed ahead of it (audio-citation shape). The store caches
   *  it by `ref` so `CommentaryCard.vue` renders the quote as a card
   *  (text + author + reference); absent ⇒ nothing renders for the marker. */
  | {
      readonly kind: "commentary-payload"
      readonly ref: number
      readonly text: string
      readonly authorName: string
      readonly addrLabel: string
      /** Source kind: "commentary" | "prose_chapter" | "letter". */
      readonly commentaryKind: string
      /** True when `text` is a machine translation — the card surfaces a
       *  footnote + toggle to `textOriginal`. */
      readonly mt?: boolean
      /** Verbatim source-language quote, present only when `mt`. */
      readonly textOriginal?: string
    }
  /** Media result (video/audio file + transcript) for one
   *  `[media:<id>|<caption>]` marker, streamed ahead of its marker. The
   *  store stashes it on `ChatMessage.media[id]` so `MediaCard.vue`
   *  renders the player + transcript; absent ⇒ the marker renders nothing
   *  (guarded like the other cards). */
  | {
      readonly kind: "media-payload"
      readonly payload: MediaPayload
    }
  /** Sub-query the research pipeline just generated — append to the
   *  live "investigating" list under the streaming bubble. The store
   *  does not persist these: when the prose deltas start landing the
   *  status pill (and this list) collapse together. */
  | { readonly kind: "research-question"; readonly question: string }
  /** A source the pipeline is inspecting right now. Dedup is the
   *  store's job — keyed by `id` so the same chunk surfaced from
   *  multiple sub-queries collapses to one chip. */
  | {
      readonly kind: "research-source"
      readonly sourceKind: ResearchSourceKind
      readonly id: string
      readonly label: string
    }
  /** Per-turn quota chip frame. Emitted by the server's SSE finally-block
   *  on success, LLM error, and client disconnect. Store sets `chatUsage`
   *  and persists. */
  | {
      readonly kind: "usage"
      readonly scope: string
      readonly current: number
      readonly limit: number
      readonly resetsAtEpoch: number
    }
