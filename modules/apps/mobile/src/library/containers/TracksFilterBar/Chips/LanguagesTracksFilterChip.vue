<template>
  <TracksFilterChipWithListItems 
    v-model="modelValue"
    :items="state"
    title="🇺🇸 Languages"
  />
</template>


<script lang="ts" setup>
import { useDAL } from '@/app'
import { useAsyncState } from '@vueuse/core'
import { TracksFilterChipWithListItems } from '@/library'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<string[]>({ required: true, default: [] })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state } = useAsyncState(loadItems, [], { immediate: true, shallow: false })


/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadItems() {
  const allItems = await dal.languages.getAll()
  return allItems
    .map((item) => ({
      id: item._id.replace('language::', ''),
      title: item.fullName + ' ' + item.icon,
      checked: false,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}
</script>