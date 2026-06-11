<template>
  <!-- Animates its own height to match its content. When the slotted
       content reflows (e.g. a chat card swaps translated ↔ original text
       of a different length), the height eases instead of snapping. -->
  <div class="auto-height" :class="{ 'auto-height--ready': ready }" :style="style">
    <div ref="inner" class="auto-height__inner">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

const inner = ref<HTMLElement>()
/** Measured content height in px; null until first measured (= auto). */
const height = ref<number | null>(null)
/** Gate so the very first layout paints at its natural height instead of
 *  easing in from 0. */
const ready = ref(false)
let ro: ResizeObserver | null = null

const style = computed(() => (height.value == null ? undefined : { height: `${height.value}px` }))

function measure(): void {
  if (inner.value) height.value = inner.value.getBoundingClientRect().height
}

onMounted(() => {
  if (!inner.value) return
  measure()
  ro = new ResizeObserver(() => measure())
  ro.observe(inner.value)
  requestAnimationFrame(() => {
    ready.value = true
  })
})

onBeforeUnmount(() => ro?.disconnect())
</script>

<style scoped>
.auto-height {
  overflow: hidden;
}
.auto-height--ready {
  transition: height 0.28s ease;
}
/* flow-root so the slotted content's vertical margins are contained and
 * counted in the measured height. */
.auto-height__inner {
  display: flow-root;
}
@media (prefers-reduced-motion: reduce) {
  .auto-height--ready {
    transition: none;
  }
}
</style>
