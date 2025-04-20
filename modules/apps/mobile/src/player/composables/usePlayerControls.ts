import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerControls = createGlobalState(() => {
  const isPlaying = ref(false)
  const title = ref('')
  const author = ref('')
  const position = ref(0)

  return {
    isPlaying,
    title,
    author,
    position,
  }
})
