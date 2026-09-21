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
  "pick-start": []
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

/**
 * Resolve the touch point to the sentence span it visually overlaps.
 *
 * `document.elementFromPoint` alone returns the topmost element AT the
 * pixel — if the user lifts on inter-sentence whitespace, that element
 * is the whitespace text-wrapper, and `.closest()` walks up past the
 * sentence boundary and binds to whichever ancestor is shared. The net
 * effect is an off-by-one sentence on either side of the selection.
 *
 * Probe the stacked elements at the point and pick the candidate
 * sentence span whose visual center is nearest by horizontal distance,
 * so a release on whitespace snaps to the visually-closest sentence
 * rather than to the DOM ancestor of the whitespace itself.
 */
function resolveSentenceAt(touchX: number, touchY: number): HTMLElement | null {
  const stack = document.elementsFromPoint(touchX, touchY) as HTMLElement[]
  for (const el of stack) {
    if (el.hasAttribute(props.datasetFieldStart) && el.hasAttribute(props.datasetFieldEnd)) {
      return el
    }
  }
  let best: HTMLElement | null = null
  let bestDist = Infinity
  for (const el of stack) {
    const parent = el.closest(
      `[${props.datasetFieldStart}][${props.datasetFieldEnd}]`
    ) as HTMLElement | null
    if (!parent) continue
    const r = parent.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const dist = Math.abs(cx - touchX)
    if (dist < bestDist) {
      bestDist = dist
      best = parent
    }
  }
  return best
}

function readTimesFrom(el: HTMLElement | null): [number, number] {
  if (!el) return [-1, -1]
  const start = parseFloat(el.getAttribute(props.datasetFieldStart) || "-1")
  const end = parseFloat(el.getAttribute(props.datasetFieldEnd) || "-1")
  return [start, end]
}

function onTouchStart(event: TouchEvent) {
  // Reset both pairs on every new touch — leaving stale `currentTime*`
  // from a prior gesture causes `onTouchEnd` to emit a phantom selection
  // when the new long-press lands on a non-selectable region (verse
  // block, whitespace) and `initialTime*` was never set.
  initialTimeStart.value = -1
  initialTimeEnd.value = -1
  currentTimeStart.value = -1
  currentTimeEnd.value = -1

  const { clientX: touchX, clientY: touchY } = event.touches[0]
  const [timeStart, timeEnd] = readTimesFrom(resolveSentenceAt(touchX, touchY))

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
  const [timeStart, timeEnd] = readTimesFrom(resolveSentenceAt(touchX, touchY))

  // Both branches emit the RUNNING pair, never the fixed anchor: `selected`
  // (below) is built from `currentTime*`, so mixing one running edge with one
  // anchor edge made the highlight disagree with what a release actually saved
  // as soon as the drag crossed the anchor — the note, the "Ask Sadhu" text and
  // the share payload then covered a span the user never saw (#1732).
  //
  // Retraction is deliberately kept as it is: the edge being dragged follows the
  // finger back toward the anchor (both comparisons are against `initialTime*`),
  // but crossing the anchor extends the OTHER edge instead of collapsing this
  // one — a touch drag has no grab handles, so a selection already made on the
  // far side is not thrown away by a move across the start sentence.
  if (timeStart !== -1 && timeStart < initialTimeStart.value) {
    currentTimeStart.value = timeStart
    emit("selecting", currentTimeStart.value, currentTimeEnd.value)
  } else if (timeEnd !== -1 && timeEnd > initialTimeEnd.value) {
    currentTimeEnd.value = timeEnd
    emit("selecting", currentTimeStart.value, currentTimeEnd.value)
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
    emit("pick-start")
  }
}
</script>

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
