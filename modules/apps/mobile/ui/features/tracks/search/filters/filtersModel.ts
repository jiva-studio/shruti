import type {
  FiltersModel,
  MultiSectionDef,
  MultiSectionKey,
  SearchFilterSectionDef,
  SingleSectionDef,
  SingleSectionKey,
} from "./types.js"

/**
 * Pure value helpers over `FiltersModel`. Extracted from
 * SearchFiltersSheet.vue so the multi-vs-single dispatch and the
 * "summary" logic are unit-testable without mounting the modal.
 *
 * Every mutation returns a fresh `FiltersModel` so the v-model assignment
 * upstream stays referentially distinct and reactive consumers re-fire.
 */

export function getMultiSelected(filters: FiltersModel, key: MultiSectionKey): readonly string[] {
  return (filters[key] as string[] | undefined) ?? []
}

export function getMultiCount(filters: FiltersModel, key: MultiSectionKey): number {
  return getMultiSelected(filters, key).length
}

export function isMultiSelected(filters: FiltersModel, key: MultiSectionKey, id: string): boolean {
  return getMultiSelected(filters, key).includes(id)
}

export function setMultiSelected(
  filters: FiltersModel,
  key: MultiSectionKey,
  id: string,
  checked: boolean
): FiltersModel {
  const current = getMultiSelected(filters, key)
  const next = checked
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((x) => x !== id)
  return { ...filters, [key]: next }
}

export function getSingleValue(filters: FiltersModel, key: SingleSectionKey): string | undefined {
  return filters[key] as string | undefined
}

export function toggleSingleValue(
  filters: FiltersModel,
  key: SingleSectionKey,
  id: string | undefined
): FiltersModel {
  const current = getSingleValue(filters, key)
  return { ...filters, [key]: current === id ? undefined : id }
}

/**
 * Human-readable summary of the current selection for a section,
 * used on the list-view row under the section title.
 */
export function getSectionSummary(filters: FiltersModel, section: SearchFilterSectionDef): string {
  if (section.kind === "multi") {
    const ids = getMultiSelected(filters, section.key)
    if (ids.length === 0) return ""
    const titles = ids
      .map((id) => section.items.find((i) => i.id === id)?.title)
      .filter((t): t is string => !!t)
    return titles.join(", ")
  }
  const current = getSingleValue(filters, (section as SingleSectionDef).key)
  if (!current) return ""
  return section.items.find((i) => i.id === current)?.title ?? ""
}

/** Discriminator helpers — flatten the union access for templates. */
export function asMulti(section: SearchFilterSectionDef | null): MultiSectionDef | null {
  return section && section.kind === "multi" ? section : null
}

export function asSingle(section: SearchFilterSectionDef | null): SingleSectionDef | null {
  return section && section.kind === "single" ? section : null
}
