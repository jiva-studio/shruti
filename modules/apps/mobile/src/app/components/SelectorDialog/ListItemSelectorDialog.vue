<template>
  <SelectorDialog
    :title="title"
    :open="open"
    @select="onSelect"
    @close="onClose"
  >
    <IonList
      lines="full"
      class="ion-no-margin ion-no-padding"
    >
      <IonRadioGroup
        v-model="value"
        :allow-empty-selection="true"
      >
        <IonItem
          v-for="item in items"
          :key="item.id"
        >
          <IonRadio :value="item.id">
            {{ item.title }}
          </IonRadio>
        </IonItem>
      </IonRadioGroup>
    </IonList>
  </SelectorDialog>
</template>


<script setup lang="ts" generic="T extends Item">
import { ref } from 'vue'
import { IonList, IonRadioGroup, IonRadio, IonItem } from '@ionic/vue'
import SelectorDialog from './SelectorDialog.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type ItemId = string | undefined
export type Item = {
  id: ItemId
  title: string
}

defineProps<{
  title: string,
  open: boolean,
  items: Item[],
}>()

const emit = defineEmits<{
  close: [],
  select: [items: ItemId]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = ref<ItemId>(undefined)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onClose() {
  emit('close')
}

function onSelect() {
  emit('select', value.value)
}
</script>