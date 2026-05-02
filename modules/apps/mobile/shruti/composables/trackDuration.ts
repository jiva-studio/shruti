import type { Track } from "@lib/domain/track.js"

/**
 * Picks the LONGEST audio variant's duration as a representative
 * length for the track in milliseconds.
 *
 * The player picks a variant by `preferredLanguage` and writes
 * positions against its duration; using the first variant in the UI
 * can give >100% (clamped to a full ring) when the picked variant
 * happens to be longer than the first one. MAX guarantees the
 * denominator ≥ any saved progress so the percentage stays in
 * [0..100], at the cost of slight under-estimation when the user
 * actually played the shorter variant.
 */
export function maxAudioDurationMs(track: Track): number {
  let max = 0
  for (const v of track.variants) {
    if (v.audio?.duration && v.audio.duration > max) max = v.audio.duration
  }
  return max
}
