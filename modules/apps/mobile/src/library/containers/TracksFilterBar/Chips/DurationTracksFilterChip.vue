<template>
  <TracksFilterChipWithListItem
    v-model="selectedDuration"
    :items="durations"
    :title="$t('library.filters.duration')"
  />
</template>


<script lang="ts" setup>
import { TracksFilterChipWithListItem } from '@lectorium/mobile/library'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const i18n = useI18n()


/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type Duration = {
  min: number
  max: number
}

const modelValue = defineModel<Duration>({ 
  required: true, default: {},
})

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const selectedDuration = ref<string|undefined>(undefined)

const durations = [
  { id: 'short',      title: i18n.t('library.filters.durationShort'),     min: 0  * 60, max: 15 * 60 },
  { id: 'medium',     title: i18n.t('library.filters.durationMedium'),    min: 15 * 60, max: 30 * 60 },
  { id: 'long',       title: i18n.t('library.filters.durationLong'),      min: 30 * 60, max: 60 * 60 },
  { id: 'extra-long', title: i18n.t('library.filters.durationExtraLong'), min: 60 * 60, max: 60 * 60 * 24 },
]

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(selectedDuration, (selected) => {
  const selectedItem = durations.find((item) => selected == item.id)
  if (selectedItem) {
    modelValue.value = {
      min: selectedItem.min,
      max: selectedItem.max ?? Number.MAX_SAFE_INTEGER,
    }
  } else {
    modelValue.value = { min: 0, max: Number.MAX_SAFE_INTEGER }
  }
}, { deep: true, immediate: true })
</script>