import type { TrackId } from "@lib/domain/core.js"
import { pickPlayableAudio, type TrackAudio } from "@lib/domain/trackVariant.js"
import type { TrackAudioRow } from "@lib/persistence/main"
import { narrowAudioKind } from "./contentRowMappers.js"

const KEY_SEPARATOR = "\x00"

/** Grouped per (track, language) so `pickPlayableAudio` sees the same
 *  candidate set the download path does. */
function groupByTrackLanguage(rows: readonly TrackAudioRow[]): Map<string, TrackAudio[]> {
  const out = new Map<string, TrackAudio[]>()
  for (const row of rows) {
    const key = `${row.track_id}${KEY_SEPARATOR}${row.language}`
    const audio: TrackAudio = {
      path: row.path,
      filesize: row.filesize,
      duration: row.duration ?? null,
      kind: narrowAudioKind(row.kind),
    }
    const bucket = out.get(key)
    if (bucket) bucket.push(audio)
    else out.set(key, [audio])
  }
  return out
}

/**
 * Cache size per track: the playable audio's size, and the largest across
 * languages when a track has several — a track caches whichever language the
 * user opened, and over-counting is the safe direction for a budget.
 */
export function largestPlayableSizes(rows: readonly TrackAudioRow[]): ReadonlyMap<TrackId, number> {
  const out = new Map<TrackId, number>()
  for (const [key, audios] of groupByTrackLanguage(rows)) {
    const size = Number(pickPlayableAudio(audios)?.filesize ?? 0)
    if (!(size > 0)) continue
    const trackId = key.slice(0, key.indexOf(KEY_SEPARATOR)) as TrackId
    out.set(trackId, Math.max(out.get(trackId) ?? 0, size))
  }
  return out
}
