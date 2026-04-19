import type { AuthorId, IsoDate, LocationId, TrackId, TagId } from "./core.js"
import type { Reference } from "./reference.js"
import type { TrackVariant } from "./trackVariant.js"

/**
 * Track — a single lecture recording. Language-independent metadata lives
 * here; per-language titles / audio / transcript paths live in TrackVariant.
 */
export interface Track {
  readonly id: TrackId
  /** nullable — legacy recordings may have unknown author */
  readonly authorId: AuthorId | null
  /** nullable — legacy recordings may have unknown location */
  readonly locationId: LocationId | null
  readonly date: IsoDate
  readonly hidden: boolean
  readonly sortReference: string
  readonly sortDate: string
  readonly references: readonly Reference[]
  readonly tagIds: readonly TagId[]
  readonly variants: readonly TrackVariant[]
}
