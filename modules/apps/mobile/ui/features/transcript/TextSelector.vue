<template>
  <div
    ref="textSelector"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
    @touchstart="onTouchStart"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, useTemplateRef } from "vue"
import { onLongPress } from "@vueuse/core"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  datasetFieldStart: string
  datasetFieldEnd: string
}>()

const emit = defineEmits<{
  selected: [start: number, end: number, event: TouchEvent]
  selecting: [start: number, end: number]
  /** Long-press landed on a selectable block — parent decides whether to fire haptics. */
  pickStart: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const textSelector = useTemplateRef<HTMLElement>("textSelector")
const initialTimeStart = ref<number>(-1)
const initialTimeEnd = ref<number>(-1)
const currentTimeStart = ref<number>(-1)
const currentTimeEnd = ref<number>(-1)
const isInSelectionMode = ref<boolean>(false)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onLongPress(textSelector, onLongPressed, {
  modifiers: {
    prevent: true,
  },
})

function onTouchStart(event: TouchEvent) {
  const { clientX: touchX, clientY: touchY } = event.touches[0]
  const element = document.elementFromPoint(touchX, touchY)

  const parentWithTimes = element?.closest(`[${props.datasetFieldStart}][${props.datasetFieldEnd}]`)
  const timeStart = parentWithTimes
    ? parseFloat(parentWithTimes.getAttribute(props.datasetFieldStart) || "-1")
    : -1
  const timeEnd = parentWithTimes
    ? parseFloat(parentWithTimes.getAttribute(props.datasetFieldEnd) || "-1")
    : -1

  if (timeStart !== -1 && timeEnd !== -1) {
    initialTimeStart.value = currentTimeStart.value = timeStart
    initialTimeEnd.value = currentTimeEnd.value = timeEnd
  }
}

function onTouchMove(event: TouchEvent) {
  if (!isInSelectionMode.value) {
    return
  }
  if (event.touches.length === 0) {
    return
  }
  event.preventDefault()

  const { clientX: touchX, clientY: touchY } = event.touches[0]
  const element = document.elementFromPoint(touchX, touchY)

  const parentWithTimes = element?.closest(`[${props.datasetFieldStart}][${props.datasetFieldEnd}]`)
  const timeStart = parentWithTimes
    ? parseFloat(parentWithTimes.getAttribute(props.datasetFieldStart) || "-1")
    : -1
  const timeEnd = parentWithTimes
    ? parseFloat(parentWithTimes.getAttribute(props.datasetFieldEnd) || "-1")
    : -1

  if (timeStart !== -1 && timeStart < initialTimeStart.value) {
    currentTimeStart.value = timeStart
    emit("selecting", currentTimeStart.value, initialTimeEnd.value)
  } else if (timeEnd !== -1 && timeEnd > initialTimeEnd.value) {
    currentTimeEnd.value = timeEnd
    emit("selecting", initialTimeStart.value, currentTimeEnd.value)
  }
}

function onTouchEnd(event: TouchEvent) {
  if (currentTimeStart.value !== -1 && currentTimeEnd.value !== -1 && isInSelectionMode.value) {
    emit("selected", currentTimeStart.value, currentTimeEnd.value, event)
  }
  isInSelectionMode.value = false
  initialTimeStart.value = -1
  initialTimeEnd.value = -1
}

function onLongPressed() {
  isInSelectionMode.value = true
  if (initialTimeStart.value !== -1) {
    emit("selecting", initialTimeStart.value, initialTimeEnd.value)
    emit("pickStart")
  }
}
</script>
