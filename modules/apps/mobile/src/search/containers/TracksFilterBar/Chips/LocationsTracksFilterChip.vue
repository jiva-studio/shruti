<template>
  <TracksFilterChipWithListItems 
    v-model="modelValue"
    :items="state"
    :title="$t('search.filters.locations')"
  />
</template>


<script lang="ts" setup>
import { watch } from 'vue'
import { useDAL, useConfig } from '@lectorium/mobile/app'
import { useAsyncState } from '@vueuse/core'
import { TracksFilterChipWithListItems } from '@lectorium/mobile/search'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const config = useConfig()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const modelValue = defineModel<string[]>({ required: true, default: [] })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state, execute: refresh } = useAsyncState(
  async () => await loadItems(), 
  [], { immediate: true, shallow: false }
)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(config.appLanguage, async () => await refresh())

watch(modelValue, (value) => {
  state.value.forEach((item) => {
    item.checked = value.includes(item.id)
  })
})

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadItems() {
  const allItems = await dal.locations.getAll()
  return allItems
    .map((item) => ({
      id: item._id.replace('location::', ''),
      title: item.fullName[config.appLanguage.value] 
             || item.fullName['en'] 
             || item._id,
      checked: false,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}
</script>