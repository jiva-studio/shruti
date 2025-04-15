import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerControls = createGlobalState(() => {
  const isPlaying = ref(false)

  return {
    isPlaying,
  }
})
