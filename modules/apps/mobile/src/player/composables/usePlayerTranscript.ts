import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerTranscript = createGlobalState(() => {
  const isOpen = ref(false)
  const trackId = ref<string | null>(null)

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */
    
  async function toggleTranscriptOpen() {
    isOpen.value = !isOpen.value
  }

  return {
    isOpen, trackId, toggleTranscriptOpen
  }
})
