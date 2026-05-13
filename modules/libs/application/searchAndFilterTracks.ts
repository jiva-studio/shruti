import type { AuthorId, LanguageCode, LocationId, SourceId, TagId } from "@lib/domain/core.js"
import {
  DURATION_FILTERS,
  durationFilterBounds,
  type DurationFilterId,
} from "@lib/domain/durationFilters.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { Track } from "@lib/domain/track.js"

export interface SearchAndFilterTracksInput {
  /** Raw user query. Empty / whitespace-only routes to the filter-only path. */
  readonly query?: string
  readonly authorIds?: readonly AuthorId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly locationIds?: readonly LocationId[]
  readonly sourceIds?: readonly SourceId[]
  readonly tagIds?: readonly TagId[]
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
  const sourceSet = new Set(input.sourceIds ?? [])
  const tagSet = new Set(input.tagIds ?? [])
  const durationBucket = input.durationFilter
    ? DURATION_FILTERS.find((d) => d.id === input.durationFilter)
    : null

  return tracks.filter((t) => {
    if (authorSet.size > 0 && (!t.authorId || !authorSet.has(t.authorId))) return false
    if (locationSet.size > 0 && (!t.locationId || !locationSet.has(t.locationId))) return false
    if (languageSet.size > 0 && !t.variants.some((v) => languageSet.has(v.language))) return false
    if (sourceSet.size > 0 && !t.references.some((r) => sourceSet.has(r.sourceId))) return false
    if (tagSet.size > 0 && !t.tagIds.some((id) => tagSet.has(id))) return false
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
 * typed text, we route through FTS (`tracks.search`) and narrow the
 * result by filter selections client-side — FTS is cross-language and
 * cross-filter by design. With no text, the filters go through
 * `tracks.list`, which pushes them down to SQL.
 *
 * Language-of-variant is intentionally not a filter on the FTS path: a
 * user typing a Russian phrase should find Russian-titled tracks even if
 * the UI locale is English.
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
    const all = await deps.tracks.search({
      text,
      sortBy: input.sortBy,
      limit: input.limit,
      offset: input.offset,
    })
    return narrowByFilters(all, input)
  }
  const duration = input.durationFilter ? durationFilterBounds(input.durationFilter) : undefined
  return deps.tracks.list({
    filters: {
      authorIds: input.authorIds,
      locationIds: input.locationIds,
      languageCodes: input.languageCodes,
      sourceIds: input.sourceIds,
      tagIds: input.tagIds,
      durationMinMs: duration?.minMs,
      durationMaxMs: duration?.maxMs,
    },
    sortBy: input.sortBy,
    limit: input.limit,
    offset: input.offset,
  })
}
