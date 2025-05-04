<template>
  <TracksFilterChip 
    :applied="isApplied"
    @click="setDialogOpen(true)"
    @remove="modelValue = undefined"
  >
    {{ title }}
  </TracksFilterChip> 
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
import { ListItemSelectorDialog, type ListItemSelectorItem } from '@lectorium/mobile/app'
import { TracksFilterChip } from '@lectorium/mobile/search'

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