<template>
  <SelectorDialog :title="title" :open="open" :sheet="sheet" @select="onSelect" @close="onClose">
    <IonList lines="none" class="ion-no-margin ion-no-padding">
      <IonRadioGroup v-model="selected" :allow-empty-selection="allowEmpty">
        <IonItem v-for="item in items" :key="item.id">
          <IonRadio :value="item.id">
            {{ item.title }}
          </IonRadio>
        </IonItem>
      </IonRadioGroup>
    </IonList>
  </SelectorDialog>
</template>

<script setup lang="ts">
import { toRefs } from "vue"
import { IonList, IonRadioGroup, IonRadio, IonItem } from "@ionic/vue"
import SelectorDialog from "./SelectorDialog.vue"
import { useSingleSelectorDialogState } from "./composables/useSelectorDialogState.js"

export type ItemId = string | undefined
export type Item = {
  id: ItemId
  title: string
}

const props = withDefaults(
  defineProps<{
    title: string
    open: boolean
    items: Item[]
    allowEmpty?: boolean
    value?: ItemId
    sheet?: boolean
  }>(),
  {
    allowEmpty: false,
    value: undefined,
    sheet: false,
  }
)

const emit = defineEmits<{
  close: []
  select: [items: ItemId]
}>()

const { value: valueProp, open: openProp } = toRefs(props)
const { value: selected } = useSingleSelectorDialogState({ value: valueProp, open: openProp })

function onClose() {
  emit("close")
}

function onSelect() {
  emit("select", selected.value)
}
</script>
