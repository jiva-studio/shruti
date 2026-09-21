import type { Track } from "@lib/domain/track.js"

/** Tracks in the order their ids were given, skipping ids the catalog has no row for. */
export function hydrateTracks(
  ids: readonly string[],
  byId: ReadonlyMap<string, Track>
): readonly Track[] {
  return ids.map((id) => byId.get(id)).filter((track): track is Track => track !== undefined)
}

/** A curated collection can mix languages; show only what the user can listen
 *  to. An empty language set means no filter. */
export function filterByLanguages(
  tracks: readonly Track[],
  languages: readonly string[]
): readonly Track[] {
  if (languages.length === 0) return tracks
  return tracks.filter((track) => track.variants.some((v) => languages.includes(v.language)))
}
