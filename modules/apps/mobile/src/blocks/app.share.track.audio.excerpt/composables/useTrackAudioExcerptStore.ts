import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useTrackAudioExcerptStore = defineStore('notes', () => {
  const busy = ref(false)

  return { busy }
})