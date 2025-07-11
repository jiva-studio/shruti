import { ref } from 'vue'
import { defineStore } from 'pinia'

export const usePlayerStore = defineStore('player', () => {
  const trackId = ref('')
  const playlistItemId = ref('')
  const isPlaying = ref(false)
  const title = ref('')
  const author = ref('')
  const position = ref(0)
  const duration = ref(0)

  return {
    trackId,
    playlistItemId,
    isPlaying,
    title,
    author,
    position,
    duration,
  }
})