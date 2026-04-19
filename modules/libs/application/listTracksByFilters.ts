import type { AuthorId, LanguageCode, LocationId, TagId } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { durationFilterBounds, type DurationFilterId } from "@lib/domain/durationFilters.js"

export interface ListTracksByFiltersInput {
  readonly authorIds?: readonly AuthorId[]
  readonly locationIds?: readonly LocationId[]
  readonly languageCodes?: readonly LanguageCode[]
  readonly tagIds?: readonly TagId[]
  readonly durationFilter?: DurationFilterId
  readonly sortBy?: SortMethod
  readonly limit?: number
  readonly offset?: number
}

export interface ListTracksByFiltersDeps {
  readonly tracks: ITrackRepository
}

/**
 * Thin use case around `ITrackRepository.list()`. Converts the UI-level
 * duration filter id ("short"/"medium"/"long") into ms bounds the
 * repository expects, and otherwise passes filters through.
 */
export async function listTracksByFilters(
  input: ListTracksByFiltersInput,
  deps: ListTracksByFiltersDeps
): Promise<readonly Track[]> {
  const duration = input.durationFilter ? durationFilterBounds(input.durationFilter) : undefined
  return deps.tracks.list({
    filters: {
      authorIds: input.authorIds,
      locationIds: input.locationIds,
      languageCodes: input.languageCodes,
      tagIds: input.tagIds,
      durationMinMs: duration?.minMs,
      durationMaxMs: duration?.maxMs,
    },
    sortBy: input.sortBy,
    limit: input.limit,
    offset: input.offset,
  })
}
