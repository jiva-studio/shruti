<template>
  <SelectorDialog :title="title" :open="open" :sheet="sheet" @select="onSelect" @close="onClose">
    <SearchInput
      v-if="items.length > SEARCH_VISIBILITY_THRESHOLD"
      v-model="searchQuery"
      :placeholder="$t('app.search')"
    />
    <IonList lines="none" class="ion-no-margin ion-no-padding">
      <IonItem v-for="item in filteredItems" :key="item.id">
        <IonCheckbox
          label-placement="end"
          justify="start"
          :checked="selectedItemIds.includes(item.id)"
          @ion-change="(e) => toggle(item.id, e.detail.checked)"
        >
          {{ item.title }}
        </IonCheckbox>
      </IonItem>
    </IonList>
  </SelectorDialog>
</template>

<script setup lang="ts">
import { toRefs } from "vue"
import { IonList, IonCheckbox, IonItem } from "@ionic/vue"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import SelectorDialog from "./SelectorDialog.vue"
import { useMultiSelectorDialogState } from "./composables/useSelectorDialogState.js"
import { SEARCH_VISIBILITY_THRESHOLD } from "./utils.js"

export type ItemId = string
export type Item = {
  id: ItemId
  title: string
}

const props = defineProps<{
  title: string
  open: boolean
  items: Item[]
  selected?: ItemId[]
  sheet?: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [items: ItemId[]]
}>()

const { items, selected } = toRefs(props)
const { searchQuery, selectedItemIds, filteredItems, toggle } = useMultiSelectorDialogState({
  items,
  selected,
})

function onClose() {
  emit("close")
}

function onSelect() {
  emit("select", selectedItemIds.value)
}
</script>
