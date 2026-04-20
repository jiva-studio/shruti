<template>
  <SearchFilterChipsList>
    <TransitionGroup
      name="chips"
      tag="div"
      class="chips-wrap"
    >
      <div
        v-for="chip in sortedChips"
        :key="chip.key"
        class="chip-item"
      >
        <SearchFilterChipWithListItems
          v-if="chip.kind === 'multi'"
          :model-value="(filters[chip.model] as readonly string[] | undefined) as string[] | undefined"
          :items="chip.items"
          :title="chip.title"
          @update:model-value="(next) => update(chip.model, next)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </SearchFilterChipWithListItems>

        <SearchFilterChipWithListItem
          v-else-if="chip.kind === 'single'"
          :model-value="(filters[chip.model] as string | undefined)"
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
import { type Component, computed } from 'vue'
import SearchFilterChipsList from './SearchFilterChipsList.vue'
import SearchFilterChipWithListItems from './SearchFilterChipWithListItems.vue'
import SearchFilterChipWithListItem from './SearchFilterChipWithListItem.vue'
import IconLanguages from './icons/IconLanguages.vue'
import IconAuthors from './icons/IconAuthors.vue'
import IconLocations from './icons/IconLocations.vue'
import IconClock from './icons/IconClock.vue'
import IconSort from './icons/IconSort.vue'
import type { SelectorDialogItem } from '@ui/features/selectors/index.js'

/* -------------------------------------------------------------------------- */
/*                                   Models                                   */
/* -------------------------------------------------------------------------- */

export type FiltersModel = {
  authors?: string[]
  languages?: string[]
  locations?: string[]
  duration?: string
  sort?: string
}

type MultiChipKey = 'authors' | 'languages' | 'locations'
type SingleChipKey = 'duration' | 'sort'

type MultiChipDef = {
  key: MultiChipKey
  kind: 'multi'
  model: MultiChipKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

type SingleChipDef = {
  key: SingleChipKey
  kind: 'single'
  model: SingleChipKey
  title: string
  icon: Component
  items: SelectorDialogItem[]
}

type ChipDef = MultiChipDef | SingleChipDef

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  authorsItems: SelectorDialogItem[]
  languagesItems: SelectorDialogItem[]
  locationsItems: SelectorDialogItem[]
  durationItems: SelectorDialogItem[]
  sortItems: SelectorDialogItem[]
  authorsTitle: string
  languagesTitle: string
  locationsTitle: string
  durationTitle: string
  sortTitle: string
  datesTitle?: string
}>()

const filters = defineModel<FiltersModel>({ required: true })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const chips = computed<readonly ChipDef[]>(() => [
  {
    kind: 'multi',
    key: 'languages',
    model: 'languages',
    title: props.languagesTitle,
    icon: IconLanguages,
    items: props.languagesItems,
  },
  {
    kind: 'multi',
    key: 'authors',
    model: 'authors',
    title: props.authorsTitle,
    icon: IconAuthors,
    items: props.authorsItems,
  },
  {
    kind: 'multi',
    key: 'locations',
    model: 'locations',
    title: props.locationsTitle,
    icon: IconLocations,
    items: props.locationsItems,
  },
  {
    kind: 'single',
    key: 'duration',
    model: 'duration',
    title: props.durationTitle,
    icon: IconClock,
    items: props.durationItems,
  },
  {
    kind: 'single',
    key: 'sort',
    model: 'sort',
    title: props.sortTitle,
    icon: IconSort,
    items: props.sortItems,
  },
])

const sortedChips = computed(() => {
  const v = filters.value ?? {}
  return [...chips.value].sort((a, b) => {
    const aHas = hasValue(v, a.model)
    const bHas = hasValue(v, b.model)
    if (aHas !== bHas) return aHas ? -1 : 1
    return a.title.localeCompare(b.title)
  })
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function update(model: keyof FiltersModel, next: string[] | string | undefined) {
  const current = filters.value ?? {}
  filters.value = { ...current, [model]: next } as FiltersModel
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function hasValue(v: FiltersModel, model: keyof FiltersModel) {
  const cur = v[model]
  if (Array.isArray(cur)) return cur.length > 0
  return cur !== undefined && cur !== null && cur !== ''
}
</script>

<style scoped>
.chips-wrap {
  display: flex;
  gap: 8px;
}

.chip-item {
  display: inline-flex;
}

.chips-move {
  transition: transform 500ms ease;
}
</style>
