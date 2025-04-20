import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerControls = createGlobalState(() => {
  const isPlaying = ref(false)
  const title = ref('')
  const author = ref('')

  return {
    isPlaying,
    title,
    author,
  }
})
