<template>
  <SearchFilterChip 
    :applied="isApplied"
    @click="setDialogOpen(true)"
    @remove="modelValue = undefined"
  >
    {{ title }}
  </SearchFilterChip> 
  <ListItemSelectorDialog
    :title="title"
    :items="items"
    :open="isDialogOpen"
    :value="modelValue"
    @close="setDialogOpen(false)"
    @select="modelValue = $event"
  />
</template>


<script lang="ts" setup>
import { computed, ref } from 'vue'
import { ListItemSelectorDialog, type ListItemSelectorItem } from '@lectorium/mobile/features/app.ui.selectors'
import SearchFilterChip from './SearchFilterChip.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  title: string
  items: ListItemSelectorItem[]
}>()

const modelValue = defineModel<string|undefined>({ required: true, default: undefined })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isDialogOpen = ref(false)
const isApplied = computed(() => modelValue.value !== undefined)


/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function setDialogOpen(value: boolean) {
  isDialogOpen.value = value
}
</script>