<template>
  <SearchFilterChip 
    :applied="isApplied"
    @click="setDialogOpen(true)"
    @remove="modelValue = undefined"
  >
    {{ title }}
  </SearchFilterChip> 
  <DateRangeSelectorDialog
    :title="title"
    :open="isDialogOpen"
    :value="modelValue"
    @close="setDialogOpen(false)"
    @select="modelValue = $event"
  />
</template>


<script lang="ts" setup>
import { computed, ref } from 'vue'
import { DateRange, DateRangeSelectorDialog } from '@lectorium/mobile/features/app.ui.selectors'
import SearchFilterChip from './SearchFilterChip.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  title: string
}>()

const modelValue = defineModel<DateRange|undefined>({ required: true, default: undefined })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isDialogOpen = ref(false)
const isApplied = computed(() => 
  modelValue.value && 
  (modelValue.value.from !== '' || modelValue.value.to !== '')
)

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function setDialogOpen(value: boolean) {
  isDialogOpen.value = value
}
</script>