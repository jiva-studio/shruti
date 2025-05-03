import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerTranscript = createGlobalState(() => {
  const isOpen = ref(false)
  const trackId = ref<string | null>(null)

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */
    
  async function toggleTranscriptOpen() {
    await Haptics.impact({ style: ImpactStyle.Light })
    isOpen.value = !isOpen.value
  }

  return {
    isOpen, trackId, toggleTranscriptOpen
  }
})
