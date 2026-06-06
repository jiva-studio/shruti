import type { AuthorId, LanguageCode, LocationId, SourceId, TagId } from "@lib/domain/core.js"
import { durationFilterBounds, type DurationFilterId } from "@lib/domain/durationFilters.js"
import { dateRangeBounds, type DateBound } from "@lib/domain/dateFilters.js"
import type { ITrackRepository, TrackListFilters } from "@lib/domain/ports/trackRepository.js"
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
  /** Coarse date-range bounds, each `"YYYY"` / `"YYYY-MM"` or absent. */
  readonly dateFrom?: DateBound
  readonly dateTo?: DateBound
  readonly sortBy?: SortMethod
  readonly limit?: number
  readonly offset?: number
}

export interface SearchAndFilterTracksDeps {
  readonly tracks: ITrackRepository
}

function buildFilters(input: SearchAndFilterTracksInput): TrackListFilters {
  const duration = input.durationFilter ? durationFilterBounds(input.durationFilter) : undefined
  const dates = dateRangeBounds(input.dateFrom, input.dateTo)
  return {
    authorIds: input.authorIds,
    locationIds: input.locationIds,
    languageCodes: input.languageCodes,
    sourceIds: input.sourceIds,
    tagIds: input.tagIds,
    durationMinMs: duration?.minMs,
    durationMaxMs: duration?.maxMs,
    dateGte: dates.gte,
    dateLt: dates.lt,
  }
}

/**
 * Unified entry point for the Search view's result query. With text,
 * routes through FTS (`tracks.search`); without, through `tracks.list`.
 * Both paths apply the same filter set in SQL — pagination counts
 * narrowed rows so `limit`/`offset` are stable.
 *
 * Keeps the branching rule in one testable place instead of the view
 * controller.
 */
export async function searchAndFilterTracks(
  input: SearchAndFilterTracksInput,
  deps: SearchAndFilterTracksDeps
): Promise<readonly Track[]> {
  const text = input.query?.trim() ?? ""
  const filters = buildFilters(input)
  if (text) {
    return deps.tracks.search({
      text,
      filters,
      sortBy: input.sortBy,
      limit: input.limit,
      offset: input.offset,
    })
  }
  return deps.tracks.list({
    filters,
    sortBy: input.sortBy,
    limit: input.limit,
    offset: input.offset,
  })
}
