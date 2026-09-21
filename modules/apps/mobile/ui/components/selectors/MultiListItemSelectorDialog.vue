<script setup lang="ts">
import { ref, watch } from "vue"
import { IonList, IonItem, IonCheckbox } from "@ionic/vue"
import SelectorDialog from "./SelectorDialog.vue"

export type Item = {
  id: string
  title: string
}

// Multi-select sibling of ListItemSelectorDialog: same dialog shell + Apply, but
// a checkbox per item. At least one item must stay checked — the lone checked
// item is disabled and the toggle refuses to clear the last — so the caller
// never gets back an empty selection. The choice is held locally until Apply.
const props = withDefaults(
  defineProps<{
    title: string
    open: boolean
    items: Item[]
    value: string[]
    sheet?: boolean
  }>(),
  { sheet: false }
)

const emit = defineEmits<{
  close: []
  select: [ids: string[]]
}>()

const selected = ref<string[]>([...props.value])

watch(
  () => props.value,
  (next) => {
    selected.value = [...next]
  }
)
// Re-sync to the source of truth whenever the dialog (re)opens, so an
// abandoned in-flight edit doesn't persist across opens.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) selected.value = [...props.value]
  }
)

function toggle(id: string, on: boolean): void {
  const set = new Set(selected.value)
  if (on) {
    set.add(id)
  } else {
    if (selected.value.length <= 1) return // keep at least one
    set.delete(id)
  }
  selected.value = [...set]
}

function onSelect(): void {
  emit("select", selected.value)
}

function onClose(): void {
  emit("close")
}
</script>

<template>
  <SelectorDialog :title="title" :open="open" :sheet="sheet" @select="onSelect" @close="onClose">
    <IonList lines="none" class="ion-no-margin ion-no-padding">
      <IonItem v-for="item in items" :key="item.id">
        <IonCheckbox
          :checked="selected.includes(item.id)"
          :disabled="selected.length === 1 && selected.includes(item.id)"
          @ion-change="toggle(item.id, $event.detail.checked)"
        >
          {{ item.title }}
        </IonCheckbox>
      </IonItem>
    </IonList>
  </SelectorDialog>
</template>
