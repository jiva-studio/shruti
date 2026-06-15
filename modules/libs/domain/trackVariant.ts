import type { LanguageCode, TrackId } from "./core.js"

export type TrackVariantKind = "original" | "generated" | "edited"

/** Audio version discriminator: the source recording vs. the denoised one. */
export type TrackAudioKind = "original" | "clean"

/**
 * One variant of a track for a specific language: its title, its audio
 * versions (original recording + optional denoised "clean"), optionally a
 * transcript. Paths are **full** keys from the bucket root (e.g.
 * "public/tracks/xxx/audio/original.mp3") — the client never
 * concatenates prefixes.
 */
export interface TrackVariant {
  readonly trackId: TrackId
  readonly language: LanguageCode
  readonly title: string
  /** All audio versions for this variant (may be empty for translation-only). */
  readonly audios: readonly TrackAudio[]
  /**
   * The version to play: clean if available, else original, else first.
   * Convenience pick computed from `audios`; `null` when there is no audio.
   */
  readonly audio: TrackAudio | null
  readonly transcript: TrackTranscriptRef | null
  /** Chapter outline (table of contents), or null when not generated. */
  readonly outline: readonly TrackOutlineChapter[] | null
  /** Short lecture description / overview, or null when not generated. */
  readonly description: string | null
}

export interface TrackAudio {
  /** Full path from the bucket root. */
  readonly path: string
  readonly filesize: number | null
  /** Duration in milliseconds. */
  readonly duration: number | null
  readonly kind: TrackAudioKind
}

/** Preferred audio for playback: clean over original over whatever exists. */
export function pickPlayableAudio(audios: readonly TrackAudio[]): TrackAudio | null {
  return (
    audios.find((a) => a.kind === "clean") ??
    audios.find((a) => a.kind === "original") ??
    audios[0] ??
    null
  )
}

export interface TrackTranscriptRef {
  /** Full path from the bucket root to the JSON transcript. */
  readonly path: string
  readonly kind: TrackVariantKind
}

/** One outline chapter: a heading spanning [startMs, endMs). */
export interface TrackOutlineChapter {
  readonly title: string
  /** Chapter start in milliseconds. */
  readonly startMs: number
  /** Chapter end in milliseconds (next chapter's start; last = duration). */
  readonly endMs: number
}
