<template>
  <TracksFilterChipsList>
    <AuthorsTracksFilterChip v-model="value.authors" />
    <SourcesTracksFilterChip v-model="value.sources" />
    <LocationsTracksFilterChip v-model="value.locations" />
    <LanguagesTracksFilterChip v-model="value.languages" />
    <DurationTracksFilterChip v-model="value.duration" />
    <DateRangeTracksFilterChip v-model="value.dates" />
  </TracksFilterChipsList>
</template>


<script lang="ts" setup>
import { TracksFilterChipsList } from '@lectorium/mobile/library'
import AuthorsTracksFilterChip from './Chips/AuthorsTracksFilterChip.vue'
import SourcesTracksFilterChip from './Chips/SourcesTracksFilterChip.vue'
import LocationsTracksFilterChip from './Chips/LocationsTracksFilterChip.vue'
import LanguagesTracksFilterChip from './Chips/LanguagesTracksFilterChip.vue'
import DurationTracksFilterChip from './Chips/DurationTracksFilterChip.vue'
import DateRangeTracksFilterChip from './Chips/DateRangeTracksFilterChip.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TracksFilterValue = {
  query: string
  ids?: string[]
  authors: string[]
  sources: string[]
  locations: string[]
  languages: string[]
  duration: { min: number, max: number }
  dates: { from: string, to: string }
}

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = defineModel<TracksFilterValue>({ required: true })
</script>