import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerControls = createGlobalState(() => {
  const trackId = ref('')
  const isPlaying = ref(false)
  const title = ref('')
  const author = ref('')
  const position = ref(0)

  return {
    trackId,
    isPlaying,
    title,
    author,
    position,
  }
})
