<template>
  <div ref="targetRef">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, defineEmits } from 'vue'
import { createGesture, Gesture } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  delay?: number
}>()

const emit = defineEmits(['long-press'])

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const targetRef = ref<HTMLElement | null>(null)
let gesture: Gesture | null = null
let longPressTimeout: ReturnType<typeof setTimeout>

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onMounted(() => {
  if (!targetRef.value) return

  gesture = createGesture({
    el: targetRef.value,
    gestureName: 'long-press',
    threshold: 0,
    onStart: () => {
      longPressTimeout = setTimeout(() => {
        emit('long-press')
      }, props.delay || 500)
    },
    onMove: () => {
      if (longPressTimeout) {
        clearTimeout(longPressTimeout)
      }
    }, 
    onEnd: () => clearTimeout(longPressTimeout),
    onCancel: () => clearTimeout(longPressTimeout),
  })

  gesture.enable()
})

onBeforeUnmount(() => {
  gesture?.destroy()
})
</script>

<style scoped>
/* Optional: Add visual feedback styles here */
</style>