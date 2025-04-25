import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const usePlayerControls = createGlobalState(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */
  
  const trackId = ref('')
  const isPlaying = ref(false)
  const title = ref('')
  const author = ref('')
  const position = ref(0)
  const duration = ref(0)

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  function close() {
    isPlaying.value = false
    trackId.value = ''
    title.value = ''
    author.value = ''
    position.value = 0
    duration.value = 0
  }


  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    close,
    trackId,
    isPlaying,
    title,
    author,
    position,
    duration,
  }
})
