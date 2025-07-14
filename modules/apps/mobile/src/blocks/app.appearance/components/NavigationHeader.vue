<template>
  <div
    class="NavigationHeader"
    :class="{ 
      'show': display,
      'hide': !display, 
    }"
  />
</template>

<script setup lang="ts">
import { ref, toRefs, watch } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  visible: boolean
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { visible } = toRefs(props)
const display = ref(false)
let timeoutId: ReturnType<typeof setTimeout> | null = null

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(visible, (newValue) => {
  if (newValue) {
    if (timeoutId) { clearTimeout(timeoutId) }
    timeoutId = setTimeout(() => display.value = true, 1000)
 } else {
    if (timeoutId) { clearTimeout(timeoutId) }
    display.value = false
  }
})
</script>

<style scoped>
.NavigationHeader {
  background: linear-gradient(
    to bottom, 
    #1D263B, rgba(29, 38, 59, 0)
  );
  position: fixed;
  left: 0px;
  right: 0px;
  top: 0px;
  height: calc(var(--ion-safe-area-top) * 1.8);
  z-index: 10000;
  opacity: 0;
  pointer-events: none;
}

.NavigationHeader.show {
  opacity: 1;
  transition: opacity 1.0s ease;
}

.NavigationHeader.hide {
  opacity: 0;
  transition: opacity 0s linear;
}
</style>