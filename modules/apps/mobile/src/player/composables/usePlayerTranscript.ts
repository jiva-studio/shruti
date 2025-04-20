import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerTranscript = createGlobalState(() => {
  const isOpen = ref(false)
  const trackId = ref<string | null>(null)

  return {
    isOpen, trackId
  }
})
