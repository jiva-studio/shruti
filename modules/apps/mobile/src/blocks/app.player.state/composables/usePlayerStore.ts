import { ref } from 'vue'
import { defineStore } from 'pinia'

export const usePlayerStore = defineStore('player', () => {
  const trackId = ref('')
  const audioType = ref<'original' | 'clean'>('original')
  const playlistItemId = ref('')
  const isPlaying = ref(false)
  const position = ref(0)
  const duration = ref(0)
  const author = ref('')
  const title = ref('')

  return {
    trackId,
    audioType,
    playlistItemId,
    isPlaying,
    position,
    duration,
    author,
    title,
  }
})