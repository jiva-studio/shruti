import type { Component } from "vue"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"

export type FiltersModel = {
  authors?: string[]
  languages?: string[]
  locations?: string[]
  sources?: string[]
  tags?: string[]
  topics?: string[]
  duration?: string
  sort?: string
  /** Coarse date-range edges. Each is `"YYYY"` or `"YYYY-MM"`, or absent
   *  for an open end. A month is only set alongside its year. */
  dateFrom?: string
  dateTo?: string
}

export type MultiSectionKey = "authors" | "languages" | "locations" | "sources" | "tags" | "topics"
export type SingleSectionKey = "duration" | "sort"
export type DateSectionKey = "dates"

export interface MultiSectionDef {
  kind: "multi"
  key: MultiSectionKey
  model: MultiSectionKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

export interface SingleSectionDef {
  kind: "single"
  key: SingleSectionKey
  model: SingleSectionKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

export interface DateSectionDef {
  kind: "date"
  key: DateSectionKey
  title: string
  icon: Component
  /** Selectable years, newest first — sourced from the catalog. */
  years: readonly number[]
  /** Localised month names, index 0 = January. Length 12. */
  monthLabels: readonly string[]
}

export type SearchFilterSectionDef = MultiSectionDef | SingleSectionDef | DateSectionDef
