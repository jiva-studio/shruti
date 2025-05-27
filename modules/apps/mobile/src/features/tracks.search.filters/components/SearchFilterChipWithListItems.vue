<template>
  <SearchFilterChip 
    :applied="isApplied"
    @click="setDialogOpen(true)"
    @remove="modelValue = undefined"
  >
    {{ title }}
  </SearchFilterChip> 
  <ListItemsSelectorDialog
    :items="items"
    :title="title"
    :open="isDialogOpen"
    @close="setDialogOpen(false)"
    @select="onItemsSelected"
  />
</template>


<script lang="ts" setup>
import { computed, ref, toRefs } from 'vue'
import { ListItemsSelectorDialog, type SelectorDialogItem } from '@lectorium/mobile/features/app.ui.selectors'
import SearchFilterChip from './SearchFilterChip.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  title: string
  items: SelectorDialogItem[]
}>()

const modelValue = defineModel<string[]|undefined>({ required: true, default: undefined })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isDialogOpen = ref(false)
const isApplied = computed(() => modelValue.value ? modelValue.value.length > 0 : false)
const { items } = toRefs(props)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onItemsSelected(selectedItems: string[]) {
  if (selectedItems.length === 0) {
    modelValue.value = undefined
    return
  }
  modelValue.value = selectedItems
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function setDialogOpen(value: boolean) {
  isDialogOpen.value = value
}
</script>