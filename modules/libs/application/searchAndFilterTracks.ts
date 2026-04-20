import type { AuthorId, LanguageCode, LocationId } from "@lib/domain/core.js"
import { DURATION_FILTERS, type DurationFilterId } from "@lib/domain/durationFilters.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { Track } from "@lib/domain/track.js"
import { listTracksByFilters } from "./listTracksByFilters.js"
import { searchTracks } from "./searchTracks.js"

export interface SearchAndFilterTracksInput {
  /** Raw user query. Empty / whitespace-only routes to listTracksByFilters. */
  readonly query?: string
  readonly authorIds?: readonly AuthorId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly locationIds?: readonly LocationId[]
  readonly durationFilter?: DurationFilterId
  readonly sortBy?: SortMethod
  readonly limit?: number
  readonly offset?: number
}

export interface SearchAndFilterTracksDeps {
  readonly tracks: ITrackRepository
}

function narrowByFilters(
  tracks: readonly Track[],
  input: SearchAndFilterTracksInput
): readonly Track[] {
  const authorSet = new Set(input.authorIds ?? [])
  const languageSet = new Set(input.languageCodes ?? [])
  const locationSet = new Set(input.locationIds ?? [])
  const durationBucket = input.durationFilter
    ? DURATION_FILTERS.find((d) => d.id === input.durationFilter)
    : null

  return tracks.filter((t) => {
    if (authorSet.size > 0 && (!t.authorId || !authorSet.has(t.authorId))) return false
    if (locationSet.size > 0 && (!t.locationId || !locationSet.has(t.locationId))) return false
    if (languageSet.size > 0 && !t.variants.some((v) => languageSet.has(v.language))) return false
    if (durationBucket) {
      const anyInRange = t.variants.some((v) => {
        const d = v.audio?.duration
        return d !== null && d !== undefined && d >= durationBucket.minMs && d < durationBucket.maxMs
      })
      if (!anyInRange) return false
    }
    return true
  })
}

/**
 * Unified entry point for the Search view's result query. When the user
 * typed text, we route through FTS (searchTracks) and narrow the result
 * by filter selections client-side — FTS is cross-language and cross-
 * filter by design. With no text, the same filters go through
 * listTracksByFilters which pushes them down to SQL.
 *
 * Keeps the branching rule in one testable place instead of the view
 * controller.
 */
export async function searchAndFilterTracks(
  input: SearchAndFilterTracksInput,
  deps: SearchAndFilterTracksDeps
): Promise<readonly Track[]> {
  const text = input.query?.trim() ?? ""
  if (text) {
    const all = await searchTracks(
      { query: text, limit: input.limit, offset: input.offset },
      { tracks: deps.tracks }
    )
    return narrowByFilters(all, input)
  }
  return listTracksByFilters(
    {
      authorIds: input.authorIds,
      languageCodes: input.languageCodes,
      locationIds: input.locationIds,
      durationFilter: input.durationFilter,
      sortBy: input.sortBy,
      limit: input.limit,
      offset: input.offset,
    },
    { tracks: deps.tracks }
  )
}
