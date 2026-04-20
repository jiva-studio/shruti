<template>
  <div
    class="speaker-floating-chip"
    :class="{
      'hidden': !curSpeaker
    }"
  >
    {{ curSpeaker }}:
  </div>
</template>


<script setup lang="ts">
import { inject, onUnmounted, ref, type Ref } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const scrollTop: Ref<number> | undefined = inject('scrollTop')
const positionTop = ref('0px')
const curSpeaker  = ref('')
const lastSpeaker = ref('')
let lastEl: HTMLElement | null


const intervalId = setInterval(async () => {
  const currentEl: HTMLElement | null = document.querySelector('.current')
  if (currentEl) {
    const speaker = currentEl.getAttribute('data-speaker')
    // Filter out collapsed rects (e.g. <br> elements in Safari return
    // zero-width rects alongside the real text rect).
    const top = Math.min(
      ...Array.from(currentEl.getClientRects())
        .filter((x) => x.width > 0)
        .map((x) => x.top)
    )

    curSpeaker.value = speaker || ''
    if (curSpeaker.value !== lastSpeaker.value || currentEl === lastEl) {
      positionTop.value = `${top + (scrollTop?.value || 0)}px`
    }
    lastSpeaker.value = speaker || ''
    lastEl = currentEl
  } else {
    curSpeaker.value = ''
  }
}, 500)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onUnmounted(() => clearInterval(intervalId))
</script>


<style scoped>
.speaker-floating-chip {
  position: absolute;
  top: v-bind(positionTop);
  left: 10px;
  font-size: .75rem;
  padding: .25rem;
  border-radius: 5px;
  background-color: var(--ion-color-warning);
  transition: all 100ms ease-in-out;
  transform: translateY(-100%);
}

.hidden {
  opacity: 0;
}
</style>
