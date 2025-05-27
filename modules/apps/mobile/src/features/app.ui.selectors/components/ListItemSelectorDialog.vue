<template>
  <SelectorDialog
    :title="title"
    :open="open"
    @select="onSelect"
    @close="onClose"
  >
    <IonList
      lines="none"
      class="ion-no-margin ion-no-padding"
    >
      <IonRadioGroup
        v-model="value"
        :allow-empty-selection="allowEmpty"
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


<script setup lang="ts">
import { ref, watch } from 'vue'
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

const props = withDefaults(
  defineProps<{
    title: string,
    open: boolean,
    items: Item[],
    allowEmpty?: boolean
    value?: ItemId
  }>(), {
    allowEmpty: false,
    value: undefined
  }
)

const emit = defineEmits<{
  close: [],
  select: [items: ItemId]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = ref<ItemId>(props.value)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(() => props.value, (newValue) => { value.value = newValue })

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