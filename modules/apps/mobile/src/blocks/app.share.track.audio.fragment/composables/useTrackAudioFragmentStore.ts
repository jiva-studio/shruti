import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useTrackAudioFragmentStore = defineStore('audio-fragment', () => {
  const busy = ref(false)

  return { busy }
})