<template>
  <TracksFilterChip 
    :applied="isApplied"
    @click="setDialogOpen(true)"
    @remove="modelValue = []"
  >
    {{ title }}
  </TracksFilterChip> 
  <ListItemsSelectorDialog
    :items="items"
    :title="title"
    :open="isDialogOpen"
    @close="setDialogOpen(false)"
    @select="modelValue = $event"
  />
</template>


<script lang="ts" setup>
import { computed, ref, toRefs } from 'vue'
import { ListItemsSelectorDialog, type SelectorDialogItem } from '@lectorium/mobile/app'
import { TracksFilterChip } from '@lectorium/mobile/search'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  title: string
  items: SelectorDialogItem[]
}>()

const modelValue = defineModel<string[]>({ required: true, default: [] })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isDialogOpen = ref(false)
const isApplied = computed(() => modelValue.value.length > 0)
const { items } = toRefs(props)

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function setDialogOpen(value: boolean) {
  isDialogOpen.value = value
}
</script>