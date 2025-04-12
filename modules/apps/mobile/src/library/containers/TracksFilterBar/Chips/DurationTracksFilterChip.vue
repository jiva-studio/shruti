<template>
  <TracksFilterChipWithListItem
    v-model="selectedDuration"
    :items="durations"
    title="⏰ Durations"
  />
</template>


<script lang="ts" setup>
import { TracksFilterChipWithListItem } from '@/library'
import { ref, watch } from 'vue'

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
  { id: 'short',      title: $t('filter-duration-short'),      min: 0  * 60, max: 15 * 60 },
  { id: 'medium',     title: $t('filter-duration-medium'),     min: 15 * 60, max: 30 * 60 },
  { id: 'long',       title: $t('filter-duration-long'),       min: 30 * 60, max: 60 * 60 },
  { id: 'extra-long', title: $t('filter-duration-extra-long'), min: 60 * 60, max: 60 * 60 * 24 },
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

function $t(key: string) {
  return key
}
</script>