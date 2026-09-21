<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

const inner = ref<HTMLElement>()
/** Measured content height in px; null until measured (= auto). */
const height = ref<number | null>(null)
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
})

onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <!-- Animates its own height to match its content, so a slotted chat card
       eases instead of snapping when it swaps translated ↔ original text. -->
  <div class="auto-height" :style="style">
    <div ref="inner" class="auto-height__inner">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.auto-height {
  overflow: hidden;
  transition: height 0.28s ease;
}
/* flow-root so the slotted content's vertical margins are contained and
 * counted in the measured height. */
.auto-height__inner {
  display: flow-root;
}
@media (prefers-reduced-motion: reduce) {
  .auto-height {
    transition: none;
  }
}
</style>
