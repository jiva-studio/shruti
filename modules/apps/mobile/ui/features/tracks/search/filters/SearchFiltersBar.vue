<template>
  <SearchFilterChipsList>
    <TransitionGroup name="chips" tag="div" class="chips-wrap">
      <div v-for="chip in sortedChips" :key="chip.key" class="chip-item">
        <SearchFilterChipWithListItems
          v-if="chip.kind === 'multi'"
          :model-value="filters[chip.model] as string[] | undefined"
          :items="chip.items"
          :title="chip.title"
          @update:model-value="(next) => update(chip.model, next)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </SearchFilterChipWithListItems>

        <SearchFilterChipWithListItem
          v-else
          :model-value="filters[chip.model] as string | undefined"
          :items="chip.items"
          :title="chip.title"
          @update:model-value="(next) => update(chip.model, next)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </SearchFilterChipWithListItem>
      </div>
    </TransitionGroup>
  </SearchFilterChipsList>
</template>

<script lang="ts" setup>
import { type Component, toRefs } from "vue"
import SearchFilterChipsList from "./SearchFilterChipsList.vue"
import SearchFilterChipWithListItems from "./SearchFilterChipWithListItems.vue"
import SearchFilterChipWithListItem from "./SearchFilterChipWithListItem.vue"
import { useActiveFirstOrder } from "./composables/useActiveFirstOrder.js"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"

export type FiltersModel = {
  authors?: string[]
  languages?: string[]
  locations?: string[]
  duration?: string
  sort?: string
}

type MultiChipKey = "authors" | "languages" | "locations"
type SingleChipKey = "duration" | "sort"

interface MultiChipDef {
  kind: "multi"
  key: MultiChipKey
  model: MultiChipKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

interface SingleChipDef {
  kind: "single"
  key: SingleChipKey
  model: SingleChipKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

export type SearchFilterChipDef = MultiChipDef | SingleChipDef

const props = defineProps<{
  chips: readonly SearchFilterChipDef[]
}>()

const filters = defineModel<FiltersModel>({ required: true })

const { chips } = toRefs(props)

const sortedChips = useActiveFirstOrder({
  chips,
  isActive: (chip) => hasValue(filters.value ?? {}, chip.model),
})

function update(model: keyof FiltersModel, next: string[] | string | undefined): void {
  const current = filters.value ?? {}
  filters.value = { ...current, [model]: next } as FiltersModel
}

function hasValue(model: FiltersModel, key: keyof FiltersModel): boolean {
  const cur = model[key]
  if (Array.isArray(cur)) return cur.length > 0
  return cur !== undefined && cur !== null && cur !== ""
}
</script>

<style scoped>
.chips-wrap {
  display: flex;
  gap: 8px;
}

/* Trailing space after the last chip in the horizontal scroll row.
   Padding on the scroll container and `margin-inline-end` on the last
   flex item both fail at scroll-end in mobile WebKit (neither contributes
   to the scrollable width). A `::after` pseudo-element is a real generated
   flex item and reliably reserves space at the end of the row. */
.chips-wrap::after {
  content: "";
  flex: 0 0 4px;
  align-self: stretch;
}

.chip-item {
  display: inline-flex;
}

.chips-move {
  transition: transform 500ms ease;
}
</style>
