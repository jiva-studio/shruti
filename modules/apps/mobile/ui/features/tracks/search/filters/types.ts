import type { Component } from "vue"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"

export type FiltersModel = {
  authors?: string[]
  languages?: string[]
  locations?: string[]
  sources?: string[]
  tags?: string[]
  duration?: string
  sort?: string
}

export type MultiSectionKey = "authors" | "languages" | "locations" | "sources" | "tags"
export type SingleSectionKey = "duration" | "sort"

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

export type SearchFilterSectionDef = MultiSectionDef | SingleSectionDef
