export interface SmartLibraryFilters {
  readonly authorIds?: readonly string[]
  readonly tagIds?: readonly string[]
  readonly sourceIds?: readonly string[]
  readonly locationIds?: readonly string[]
  readonly languageCodes?: readonly string[]
}

interface ChipCount {
  readonly key: string
  readonly n: number
}

const DIMENSIONS: readonly { field: keyof SmartLibraryFilters; key: string }[] = [
  { field: "authorIds", key: "chat.actionConfigureSmartLibraryChipAuthors" },
  { field: "tagIds", key: "chat.actionConfigureSmartLibraryChipTopics" },
  { field: "sourceIds", key: "chat.actionConfigureSmartLibraryChipSources" },
  { field: "locationIds", key: "chat.actionConfigureSmartLibraryChipLocations" },
  { field: "languageCodes", key: "chat.actionConfigureSmartLibraryChipLanguages" },
]

/** Counts per dimension, in card order. Counts rather than names: resolving
 *  ids belongs to Settings, and the card is a teaser. */
export function smartLibraryChipCounts(
  filters: SmartLibraryFilters | undefined
): readonly ChipCount[] {
  if (!filters) return []
  return DIMENSIONS.map(({ field, key }) => ({ key, n: filters[field]?.length ?? 0 })).filter(
    (chip) => chip.n > 0
  )
}
