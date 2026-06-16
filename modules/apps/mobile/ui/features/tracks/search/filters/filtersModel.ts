import type {
  DateSectionDef,
  FiltersModel,
  MultiSectionDef,
  MultiSectionKey,
  SearchFilterSectionDef,
  SingleSectionDef,
  SingleSectionKey,
} from "./types.js"

/** Which edge of the date range a `FiltersModel` key addresses. */
export type DateEdge = "dateFrom" | "dateTo"

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

/* ----------------------------- date range -------------------------------- */

/** Parsed `"YYYY"` / `"YYYY-MM"` edge, or `null` when unset/malformed. */
export function parseDateEdge(value: string | undefined): { year: number; month?: number } | null {
  if (!value) return null
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(value)
  if (!m) return null
  const month = m[2] !== undefined ? Number(m[2]) : undefined
  if (month !== undefined && (month < 1 || month > 12)) return null
  return { year: Number(m[1]), month }
}

/** Compose the stored edge string from a year (or undefined → cleared) and
 *  an optional 1-based month. Month is dropped when no year is present. */
export function composeDateEdge(
  year: number | undefined,
  month: number | undefined
): string | undefined {
  if (year === undefined) return undefined
  if (month === undefined) return String(year)
  return `${year}-${String(month).padStart(2, "0")}`
}

export function setDateEdge(
  filters: FiltersModel,
  edge: DateEdge,
  value: string | undefined
): FiltersModel {
  return { ...filters, [edge]: value }
}

/** "Март 2001" / "2001" / "" for an unset edge. */
function formatDateEdge(value: string | undefined, monthLabels: readonly string[]): string {
  const parsed = parseDateEdge(value)
  if (!parsed) return ""
  if (parsed.month === undefined) return String(parsed.year)
  return `${monthLabels[parsed.month - 1] ?? parsed.month} ${parsed.year}`
}

/** Compact range summary, e.g. "Март 2001 – 2012", "от 2001", "до Дек 2012". */
export function getDateSummary(filters: FiltersModel, section: DateSectionDef): string {
  const from = formatDateEdge(filters.dateFrom, section.monthLabels)
  const to = formatDateEdge(filters.dateTo, section.monthLabels)
  if (!from && !to) return ""
  if (from && to) return `${from} – ${to}`
  if (from) return `${from} – …`
  return `… – ${to}`
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
  if (section.kind === "date") {
    return getDateSummary(filters, section)
  }
  const current = getSingleValue(filters, section.key)
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

export function asDate(section: SearchFilterSectionDef | null): DateSectionDef | null {
  return section && section.kind === "date" ? section : null
}
