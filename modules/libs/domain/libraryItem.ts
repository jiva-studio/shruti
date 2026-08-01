import type {
  AuthorId,
  IsoDate,
  LanguageCode,
  LocationId,
  TrackId,
  UnixMs,
} from "./core.js"
import type { Reference } from "./reference.js"
import type { Track } from "./track.js"
import type {
  TrackAudio,
  TrackOutlineChapter,
  TrackTranscriptRef,
  TrackVariant,
} from "./trackVariant.js"
import { pickPlayableAudio } from "./trackVariant.js"

/** Ingest lifecycle of a personal-library item. Server-authored; the client
 *  only reads it. */
export type LibraryItemStatus = "queued" | "processing" | "ready" | "failed"

/** Provenance of the item: still private to the owner, or promoted to the
 *  shared corpus (a later phase). */
export type LibraryItemOrigin = "private" | "published"

/**
 * A lecture the user added that is NOT in the shared corpus — the personal
 * library (epic #1236). Metadata is owned by the `profile` service and reaches
 * the device over profile-sync as a **pull-only** collection; the client never
 * edits it.
 *
 * `id` is the per-user membership id (UUID); `trackId` is the content hash,
 * `null` until the fetch step computes it. Audio/transcript keys and `duration`
 * are populated once `status === "ready"`. Raw metadata (`titleRaw`, …) is
 * always present and lossless; the resolved values (`authorId`, `date`, …) are
 * `null` until the pipeline confidently matches them.
 */
export interface LibraryItem {
  readonly id: string
  readonly trackId: TrackId | null
  readonly status: LibraryItemStatus
  readonly origin: LibraryItemOrigin | null
  readonly titleRaw: string | null
  readonly authorRaw: string | null
  readonly locationRaw: string | null
  readonly dateRaw: string | null
  readonly langHint: LanguageCode | null
  readonly authorId: AuthorId | null
  readonly locationId: LocationId | null
  readonly date: IsoDate
  /** ASR-detected content language — authoritative when present. */
  readonly lang: LanguageCode | null
  readonly error: string | null
  /** Full bucket key of the audio, present once ready. */
  readonly audioKey: string | null
  /** Bucket key of the PRIMARY-language transcript (also the share-PDF source).
   *  `variants` carries every language. */
  readonly transcriptKey: string | null
  /** Every stored per-language transcript with its own overview (a
   *  lecturer+translator recording has one per language). */
  readonly variants: readonly LibraryItemVariant[]
  /** Track length in MILLISECONDS (feeds the synthetic TrackAudio.duration),
   *  null until known. */
  readonly duration: number | null
  readonly coverKey: string | null
  /** Raw scripture references parsed from the title (unresolved — carried as
   *  `sourceName` + tokens, rendered as-is). Empty when none. */
  readonly references: readonly Reference[]
  /** URL the lecture was added from; null on older rows. */
  readonly sourceUrl: string | null
  readonly createdAt: UnixMs | null
  readonly updatedAt: UnixMs | null
}

/** One stored per-language transcript for a library item: its language, the full
 *  bucket key of `transcripts/<lang>.json` (only that language's blocks), and the
 *  overview (description + chapter outline) generated from that language. Audio
 *  is shared across a track's variants, so it is not repeated here. */
export interface LibraryItemVariant {
  readonly language: LanguageCode
  /** Title in this language — the source title for the primary, translated for
   *  the others. Null when the ingest didn't produce one. */
  readonly title: string | null
  readonly transcriptKey: string
  readonly description: string | null
  readonly outline: readonly TrackOutlineChapter[] | null
}

/** Fallback content language when neither ASR nor the hint resolved one. */
const DEFAULT_LANGUAGE: LanguageCode = "en"

/**
 * Adapt a personal-library item into a synthetic {@link Track} so the existing
 * playback stack — the storage-URL resolver (`resolveAssetUrl` /
 * `IStoragePublicUrl`), the download store, and the HTTP transcript repository —
 * consumes a user-added lecture unchanged. All three read a `Track`'s variant
 * paths (full bucket keys) and never look at SQL, so a faithful `Track` is all
 * they need.
 *
 * Variant paths point at the content-addressed CDN location
 * `public/tracks/<track_id>/…` — the server-supplied `audioKey` / `transcriptKey`
 * when present, else the deterministic scheme (`audio/original.mp3`,
 * `transcripts/<lang>.json`). Returns `null` when the item has no content hash
 * yet (`trackId === null`) — nothing is playable until the fetch step runs.
 */
export function libraryItemToTrack(item: LibraryItem): Track | null {
  const trackId = item.trackId
  if (trackId === null) return null

  const primaryLang = item.lang ?? item.langHint ?? DEFAULT_LANGUAGE
  // Audio is one shared file across every language variant.
  const audioPath = item.audioKey ?? `public/tracks/${trackId}/audio/original.mp3`
  const audios: readonly TrackAudio[] = [
    { path: audioPath, filesize: null, duration: item.duration, kind: "original" },
  ]
  const audio = pickPlayableAudio(audios)
  const hasTranscript = item.status === "ready" || item.transcriptKey !== null

  // One track variant per stored language, each with its own transcript +
  // overview. A track queued/processing before the split ran has no variants
  // yet, so synthesise the primary-language variant from the deterministic path.
  const langVariants: readonly LibraryItemVariant[] =
    item.variants.length > 0
      ? item.variants
      : [
          {
            language: primaryLang,
            title: item.titleRaw,
            transcriptKey:
              item.transcriptKey ?? `public/tracks/${trackId}/transcripts/${primaryLang}.json`,
            description: null,
            outline: null,
          },
        ]

  const variants: TrackVariant[] = langVariants.map((v) => ({
    trackId,
    language: v.language,
    title: v.title ?? item.titleRaw ?? "",
    audios,
    audio,
    transcript: hasTranscript ? { path: v.transcriptKey, kind: "generated" } : null,
    outline: v.outline,
    description: v.description,
  }))

  return {
    id: trackId,
    authorId: item.authorId,
    locationId: item.locationId,
    authorRaw: item.authorRaw,
    locationRaw: item.locationRaw,
    date: item.date,
    hidden: false,
    references: item.references,
    tagIds: [],
    topicIds: [],
    variants,
  }
}
