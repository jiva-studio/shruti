<template>
  <SelectorDialog
    :title="title"
    :open="open"
    @select="onSelectDialogButtonClicked"
    @close="onCloseDialogButtonClicked"
  >
    <SearchInput
      v-if="items.length > 10"
      v-model="query"
      placeholder="Search"
    />
    <IonList
      lines="none"
      class="ion-no-margin ion-no-padding"
    >
      <IonItem
        v-for="item in filteredItems"
        :key="item.id"
      >
        <IonCheckbox
          label-placement="end"
          justify="start"
          :checked="selectedItemIds.includes(item.id)"
          @ion-change="e => onCheckboxClicked(item.id, e.detail.checked)"
        >
          {{ item.title }}
        </IonCheckbox>
      </IonItem>
    </IonList>
  </SelectorDialog>
</template>


<script setup lang="ts">
import { computed, ref, toRefs, watch } from 'vue'
import { IonList, IonCheckbox, IonItem } from '@ionic/vue'
import { SearchInput } from '@lectorium/mobile/features/app.core'
import SelectorDialog from './SelectorDialog.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type ItemId = string
export type Item = {
  id: ItemId
  title: string
}

const props = defineProps<{
  title: string,
  open: boolean,
  items: Item[],
  selected?: ItemId[]
}>()

const emit = defineEmits<{
  close: [],
  select: [items: ItemId[]]
}>()


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const query = ref('')
const selectedItemIds = ref<ItemId[]>(props.selected || [])
const { selected } = toRefs(props)

const filteredItems = computed(() =>
  props.items.filter((item) => 
    compareStrings(item.title, query.value) || 
    selectedItemIds.value.includes(item.id),
  )
)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(selected, (v) => selectedItemIds.value = v || [])

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onCheckboxClicked(id: ItemId, value: boolean) {
  if (value) {
    selectedItemIds.value.push(id)
  } else {
    selectedItemIds.value = selectedItemIds.value.filter((itemId) => itemId !== id)
  }
}

function onCloseDialogButtonClicked() {
  emit('close')
}

function onSelectDialogButtonClicked() {
  emit('select', selectedItemIds.value)
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function compareStrings(a: string, b: string) {
  return a.toLocaleLowerCase().includes(b.toLocaleLowerCase())
}
</script>