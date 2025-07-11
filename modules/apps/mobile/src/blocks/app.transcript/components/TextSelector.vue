<template>
  <div
    ref="textSelector"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
    @touchstart="onTouchStart"
  >
    <slot ref="slotRef" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { onLongPress } from '@vueuse/core'
import { useTemplateRef } from 'vue'
import { Haptics, ImpactStyle } from '@capacitor/haptics'


/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  datasetField: string
}>()

const emit = defineEmits<{
  selected: [firstItemId: number, lastItemId: number, event: TouchEvent]
  selecting: [firstItemId: number, lastItemId: number]
}>()


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const textSelector = useTemplateRef<HTMLElement>('textSelector')
const firstSelectedId = ref<number>()
const lastSelectedId = ref<number>()
const isInSelectionMode = ref<boolean>(false)


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onLongPress(
  textSelector,
  onLongPressed,
  {
    modifiers: {
      prevent: true
    }
  }
)

function onTouchStart(event: TouchEvent) {
  const { clientX: touchX, clientY: touchY } = event.touches[0]
  const element = document.elementFromPoint(touchX, touchY)
  const elementId = parseInt(element?.getAttribute(props.datasetField) || '-1')
  if (element && elementId && elementId !== -1) {
    firstSelectedId.value = elementId
  }
}

function onTouchMove(event: TouchEvent) {
  if (!isInSelectionMode.value) { return }
  if (event.touches.length === 0) { return }
  event.preventDefault()

  const { clientX: touchX, clientY: touchY } = event.touches[0]
  const element = document.elementFromPoint(touchX, touchY)
  const elementId = parseInt(element?.getAttribute(props.datasetField) || '-1')
  
  if (element && elementId && elementId !== -1) {
    lastSelectedId.value = elementId
  }
  if (firstSelectedId.value && lastSelectedId.value) {
    emit(
      'selecting', 
      Math.min(firstSelectedId.value, lastSelectedId.value),
      Math.max(firstSelectedId.value, lastSelectedId.value)
    )
  }
}

function onTouchEnd(event: TouchEvent) {
  if (firstSelectedId.value && isInSelectionMode.value) {
    emit(
      'selected', 
      firstSelectedId.value, 
      lastSelectedId.value || firstSelectedId.value, 
      event
    )
  }
  isInSelectionMode.value = false
  firstSelectedId.value = undefined
  lastSelectedId.value = undefined
}

function onLongPressed() {
  isInSelectionMode.value = true
  if (firstSelectedId.value) {
    emit(
      'selecting', 
      Math.min(firstSelectedId.value, lastSelectedId.value || firstSelectedId.value),
      Math.max(firstSelectedId.value, lastSelectedId.value || firstSelectedId.value)
    )
  }
  Haptics.impact({ style: ImpactStyle.Light })
}
</script>