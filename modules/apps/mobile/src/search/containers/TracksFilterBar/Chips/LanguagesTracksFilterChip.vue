<template>
  <TracksFilterChipWithListItems 
    v-model="modelValue"
    :items="state"
    :title="$t('search.filters.languages')"
  />
</template>


<script lang="ts" setup>
import { watch } from 'vue'
import { useDAL } from '@lectorium/mobile/app'
import { useAsyncState } from '@vueuse/core'
import { TracksFilterChipWithListItems } from '@lectorium/mobile/search'

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
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(modelValue, (value) => {
  state.value.forEach((item) => {
    item.checked = value.includes(item.id)
  })
})

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