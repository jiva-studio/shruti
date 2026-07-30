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
  readonly datePrecision: string | null
  /** ASR-detected content language — authoritative when present. */
  readonly lang: LanguageCode | null
  readonly langConfidence: number | null
  readonly error: string | null
  /** Full bucket key of the audio, present once ready. */
  readonly audioKey: string | null
  /** Full bucket key of the JSON transcript, present once ready. */
  readonly transcriptKey: string | null
  readonly duration: number | null
  readonly coverKey: string | null
  /** LLM overview of the lecture, generated on ready; null when not generated. */
  readonly description: string | null
  /** Coarse chapter outline (table of contents), null when not generated. */
  readonly outline: readonly TrackOutlineChapter[] | null
  /** Raw scripture references parsed from the title (unresolved — carried as
   *  `sourceName` + tokens, rendered as-is). Empty when none. */
  readonly references: readonly Reference[]
  readonly createdAt: UnixMs | null
  readonly updatedAt: UnixMs | null
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

  const language = item.lang ?? item.langHint ?? DEFAULT_LANGUAGE
  const audioPath = item.audioKey ?? `public/tracks/${trackId}/audio/original.mp3`
  const audios: readonly TrackAudio[] = [
    { path: audioPath, filesize: null, duration: item.duration, kind: "original" },
  ]
  const transcript: TrackTranscriptRef | null =
    item.status === "ready" || item.transcriptKey !== null
      ? {
          path: item.transcriptKey ?? `public/tracks/${trackId}/transcripts/${language}.json`,
          kind: "generated",
        }
      : null

  const variant: TrackVariant = {
    trackId,
    language,
    title: item.titleRaw ?? "",
    audios,
    audio: pickPlayableAudio(audios),
    transcript,
    outline: item.outline,
    description: item.description,
  }

  return {
    id: trackId,
    authorId: item.authorId,
    locationId: item.locationId,
    date: item.date,
    hidden: false,
    references: item.references,
    tagIds: [],
    topicIds: [],
    variants: [variant],
  }
}
