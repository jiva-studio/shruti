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
import { ref, inject, Ref, onUnmounted } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const scrollTop: Ref<number>|undefined = inject('scrollTop')
const positionTop = ref('0px')
const curSpeaker  = ref('')
const lastSpeaker = ref('')


const intervalId = setInterval(async () => {
  const currentEl: HTMLElement | null = document.querySelector('.current')
  if (currentEl) {
    const speaker    = currentEl.getAttribute('data-speaker')
    const rect       = currentEl.getBoundingClientRect()
    curSpeaker.value = speaker || ''

    if (curSpeaker.value !== lastSpeaker.value) {
      positionTop.value = `${rect.top  + (scrollTop?.value || 0)}px`
    }
    lastSpeaker.value = speaker || ''
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
  transform: translateY(-1.5rem);
}

.hidden {
  opacity: 0;
}
</style>