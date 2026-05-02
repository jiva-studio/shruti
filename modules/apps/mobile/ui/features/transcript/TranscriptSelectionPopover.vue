<template>
  <IonPopover
    :translucent="true"
    :animated="true"
    :arrow="false"
    :is-open="isOpen"
    :event="anchorEvent"
    @did-dismiss="onDismiss"
  >
    <SelectionActions @action="onActionClicked" />
  </IonPopover>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { IonPopover } from "@ionic/vue"
import SelectionActions from "./SelectionActions.vue"
import type { TextSelectedEvent } from "./TranscriptText.vue"

export type SelectionAction = "copy" | "bookmark" | "share"

const props = defineProps<{
  /**
   * Selection event triggered by `TranscriptText`. Setting it opens the
   * popover anchored to the touch event; setting it back to `undefined`
   * closes the popover externally.
   */
  selection: TextSelectedEvent | undefined
}>()

const emit = defineEmits<{
  action: [event: { action: SelectionAction; text: string; timeStart: number; timeEnd: number }]
  dismissed: []
}>()

const isOpen = ref(false)
const anchorEvent = ref<TouchEvent>()
let lastAction: SelectionAction | null = null

watch(
  () => props.selection,
  (next) => {
    lastAction = null
    if (next) {
      anchorEvent.value = next.event
      isOpen.value = true
    } else {
      isOpen.value = false
    }
  }
)

function onActionClicked(action: SelectionAction): void {
  lastAction = action
  isOpen.value = false
  if (!props.selection) return
  emit("action", {
    action,
    text: props.selection.text,
    timeStart: props.selection.timeStart,
    timeEnd: props.selection.timeEnd,
  })
}

function onDismiss(): void {
  isOpen.value = false
  if (!lastAction && props.selection) {
    emit("dismissed")
  }
}
</script>
