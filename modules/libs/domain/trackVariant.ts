import type { LanguageCode, TrackId } from "./core.js"

export type TrackVariantKind = "original" | "generated" | "edited"

/**
 * One variant of a track for a specific language: its title, optionally
 * an audio file (dub / original recording), optionally a transcript.
 * Paths are **full** keys from the bucket root (e.g.
 * "public/tracks/xxx/audio/original.mp3") — the client never
 * concatenates prefixes.
 */
export interface TrackVariant {
  readonly trackId: TrackId
  readonly language: LanguageCode
  readonly title: string
  readonly audio: TrackAudio | null
  readonly transcript: TrackTranscriptRef | null
}

export interface TrackAudio {
  /** Full path from the bucket root. */
  readonly path: string
  readonly filesize: number | null
  /** Duration in milliseconds. */
  readonly duration: number | null
  readonly kind: TrackVariantKind
}

export interface TrackTranscriptRef {
  /** Full path from the bucket root to the JSON transcript. */
  readonly path: string
  readonly kind: TrackVariantKind
}
